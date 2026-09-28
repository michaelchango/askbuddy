// 需求生命周期服务（M5-D1）：requirements.lifecycle 列的【唯一写入口】。
//
// ⚠️ 唯一写入口纪律：禁止任何 Route Handler / 其他 service 直接 update
// requirements.lifecycle / lifecycle_updated_at / archived_at（归档语义）——
// 所有变更必须经本模块，且每次写入都在 requirement_status_history 留审计行。
// （与 lib/db/index.ts「禁止在 Route Handler 拼查询」的既有纪律同风格。）
//
// 三层闸门在此汇合（落实 AD-4）：
//   条目级 HITL（suggestions）→ 阶段级确认（awaiting_confirm）→ 需求级生命周期（本模块）。
// 此前没有任何地方能回答「这个需求现在到底能不能交付」，checkGate 就是那个答案。

import crypto from "crypto";
import { db } from "@/lib/db";
import {
  assertTransition,
  canTransition,
  deriveLifecycle,
  LifecycleReasonRequiredError,
  type RequirementLifecycle,
} from "@/lib/requirement-lifecycle";
import { getSteps } from "./steps";

/** 人工决策态：隐式同步永不覆盖（人的决定优先于系统派生）。 */
const MANUAL_STATES: ReadonlySet<RequirementLifecycle> = new Set([
  "review",
  "completed",
  "archived",
]);

export interface GateBlocker {
  code: string;
  message: string;
  hint?: string;
  severity: "block" | "warn";
}

interface RequirementRow {
  id: string;
  lifecycle?: string;
  archived_at?: string | null;
  updated_at?: string;
}

function isLifecycle(v: unknown): v is RequirementLifecycle {
  return (
    v === "created" ||
    v === "dialoguing" ||
    v === "designing" ||
    v === "review" ||
    v === "completed" ||
    v === "archived"
  );
}

/** 当前是否有过对话（conversations 表有无该需求的行）。 */
async function hasConversation(requirementId: string): Promise<boolean> {
  const n = await db.countMany("conversations", {
    requirement_id: { eq: requirementId },
  });
  return n > 0;
}

/** 读取当前生命周期。列值为空（未回填的存量行）时按步骤实时派生，不写库。 */
export async function getLifecycle(
  requirementId: string
): Promise<RequirementLifecycle> {
  const row = await db.get<RequirementRow>("requirements", requirementId);
  if (!row) throw new Error(`需求不存在：${requirementId}`);
  if (isLifecycle(row.lifecycle)) return row.lifecycle;

  // 存量回退：列值为空 → 派生但不落库（落库交给 backfill / 下一次同步）
  return deriveLifecycle({
    archivedAt: row.archived_at ?? null,
    hasConversation: await hasConversation(requirementId),
    steps: await getSteps(requirementId),
  });
}

/** 内部统一写入：lifecycle + lifecycle_updated_at + 审计行 + 缓存失效。 */
async function writeLifecycle(
  requirementId: string,
  from: RequirementLifecycle | null,
  to: RequirementLifecycle,
  opts: {
    actor: string;
    reason?: string;
    source: "manual" | "derived" | "change_cascade";
    /** 归档迁移同时写 archived_at；解档传 null 清空。 */
    archivedAt?: string | null;
  }
): Promise<RequirementLifecycle> {
  const now = new Date().toISOString();
  // ⚠️ requirements 表是 camelCase 漂移表：代码键是 updatedAt / createdAt，
  // 不是 updated_at。写错键会被 lib/db/postgres.ts::toColumns 直接【抛错】
  // （字段契约漂移），而 syncLifecycleFromSteps 又吞异常 → 表现为「生命周期
  // 静默不推进」。单测（mocked db）抓不到，靠 smoke-lifecycle-api.ts 兜住。
  const patch: Record<string, unknown> = {
    lifecycle: to,
    lifecycle_updated_at: now,
    updatedAt: now,
  };
  if (opts.archivedAt !== undefined) patch.archived_at = opts.archivedAt;

  await db.update("requirements", requirementId, patch);
  await db.insert("requirement_status_history", {
    id: crypto.randomUUID(),
    requirement_id: requirementId,
    from_state: from,
    to_state: to,
    actor: opts.actor,
    reason: opts.reason ?? null,
    source: opts.source,
    created_at: now,
  });

  // 列表页 / 详情页的派生 status 与 lifecycle 徽标依赖缓存，主动失效。
  try {
    const { invalidateRequirementsCache } = await import("./requirements");
    invalidateRequirementsCache();
  } catch {
    /* 缓存失效失败不阻断生命周期主流程 */
  }
  return to;
}

/**
 * 显式迁移：人工触发（提交复核 / 通过 / 打回 / 归档）或变更级联（打回返工）。
 * - 非法迁移抛 LifecycleTransitionError（API 转 400）；
 * - completed→designing 必须带 reason（区分「正常返工」与「误操作」，审计可信的前提）。
 */
export async function transitionLifecycle(
  requirementId: string,
  to: RequirementLifecycle,
  opts: {
    actor: string; // 当前恒为 mock-user-001（M6/T1 接真 Auth 后为真实 uid）
    reason?: string;
    source?: "manual" | "derived" | "change_cascade";
    /**
     * 调用方已读到的当前态。API 层为了先判「迁移是否合法」已经读过一次，
     * 透传进来可省掉一次跨网关往返（CloudBase PG 网关单次约 1.7s，不能白花）。
     */
    from?: RequirementLifecycle;
  }
): Promise<RequirementLifecycle> {
  const from = opts.from ?? (await getLifecycle(requirementId));
  assertTransition(from, to);

  if (from === "completed" && to === "designing" && !(opts.reason ?? "").trim()) {
    throw new LifecycleReasonRequiredError(from, to);
  }

  return writeLifecycle(requirementId, from, to, {
    actor: opts.actor,
    reason: opts.reason,
    source: opts.source ?? "manual",
    archivedAt: to === "archived" ? new Date().toISOString() : undefined,
  });
}

/**
 * 解档（restore 特例）：archived 在邻接表里是形式终态，解档走独立语义——
 * 清空 archived_at，生命周期回到审计表中最近一次归档前的态。
 */
export async function restoreFromArchive(
  requirementId: string,
  actor: string
): Promise<RequirementLifecycle> {
  const row = await db.get<RequirementRow>("requirements", requirementId);
  if (!row) throw new Error(`需求不存在：${requirementId}`);

  const history = await db.findMany<{
    id: string;
    to_state: string;
    from_state: string | null;
    created_at: string;
  }>("requirement_status_history", {
    where: { requirement_id: { eq: requirementId }, to_state: { eq: "archived" } },
    orderBy: [["created_at", "desc"]],
    limit: 1,
  });
  if (history.length === 0) {
    throw new Error("该需求没有归档记录，无法解档。");
  }
  const previous = history[0].from_state;
  const to: RequirementLifecycle =
    isLifecycle(previous) && previous !== "archived" ? previous : "designing";

  return writeLifecycle(requirementId, "archived", to, {
    actor,
    reason: "解档",
    source: "manual",
    archivedAt: null,
  });
}

/**
 * 隐式同步：步骤状态变化后调用，把派生结果落库。
 *
 * 保守规则：
 *   1. 当前态 ∈ {review, completed, archived}（人工态）→ 不覆盖，直接 return；
 *   2. 派生态 === 当前态 → 不写（避免每次步骤更新都产生审计噪音）；
 *   3. 派生态不可达（不该出现的状态组合）→ 记 warn 不抛错（增强不阻断主流程）。
 * 注意：变更级联把 completed/review 打回 designing **不走这里**，由变更编排
 * 显式调 transitionLifecycle(source:'change_cascade')——打回必须在审计里可见。
 */
export async function syncLifecycleFromSteps(requirementId: string): Promise<void> {
  try {
    const current = await getLifecycle(requirementId);
    if (MANUAL_STATES.has(current)) return;

    const row = await db.get<RequirementRow>("requirements", requirementId);
    const derived = deriveLifecycle({
      archivedAt: row?.archived_at ?? null,
      hasConversation: await hasConversation(requirementId),
      steps: await getSteps(requirementId),
    });
    if (derived === current) return;

    if (canTransition(current, derived)) {
      await writeLifecycle(requirementId, current, derived, {
        actor: "system",
        source: "derived",
      });
    } else {
      console.warn(
        `[lifecycle] 派生态不可达：${requirementId} ${current} → ${derived}（保持原态）`
      );
    }
  } catch (e) {
    console.warn(`[lifecycle] 同步失败（不阻塞步骤推进）：${(e as Error).message}`);
  }
}

/**
 * 闸门检查：返回阻塞项列表，空数组表示可以进入目标态。
 * 三层闸门汇合点：阶段完成度 / 阶段确认锁 / 条目级 HITL / DevContext 新鲜度。
 */
export async function checkGate(
  requirementId: string,
  to: RequirementLifecycle
): Promise<GateBlocker[]> {
  const blockers: GateBlocker[] = [];
  // 只有 review / completed 有人工闸门；archived 恒可归档，其余自动态无闸门。
  if (to !== "review" && to !== "completed") return blockers;

  const steps = await getSteps(requirementId);
  const notDone = steps.filter((s) => s.state !== "done");
  if (notDone.length > 0) {
    blockers.push({
      code: "STEP_NOT_DONE",
      message: `存在未完成的步骤：${notDone.map((s) => s.step).join("、")}`,
      severity: "block",
    });
  }
  const staleSteps = steps.filter((s) => s.state === "pending_update");
  if (staleSteps.length > 0) {
    blockers.push({
      code: "STALE_STEP",
      message: `存在待更新的步骤（上游已变更）：${staleSteps.map((s) => s.step).join("、")}`,
      hint: "请先在对应步骤重新生成，确认内容后再交付。",
      severity: "block",
    });
  }
  const unlocked = steps.filter((s) => s.awaitingConfirm);
  if (unlocked.length > 0) {
    blockers.push({
      code: "AWAITING_CONFIRM",
      message: `存在等待确认的步骤：${unlocked.map((s) => s.step).join("、")}`,
      severity: "block",
    });
  }

  if (to === "completed") {
    // 条目级 HITL：M3 建议卡已回退，当前无生产者；闸门保留——有数据才生效。
    const pendingSuggestions = await db.countMany("suggestions", {
      requirement_id: { eq: requirementId },
      status: { eq: "pending" },
    });
    if (pendingSuggestions > 0) {
      blockers.push({
        code: "PENDING_SUGGESTION",
        message: `存在 ${pendingSuggestions} 条未处理的条目建议`,
        severity: "block",
      });
    }

    const devctx = await db
      .get<{
        maybe_stale?: number | boolean;
        stale_sections?: string[];
        status?: string;
      }>("dev_contexts", requirementId, "requirement_id")
      .catch(() => undefined);

    if (devctx) {
      const staleSections = Array.isArray(devctx.stale_sections)
        ? devctx.stale_sections
        : [];
      if (devctx.maybe_stale === 1 || devctx.maybe_stale === true || staleSections.length > 0) {
        blockers.push({
          code: "DEVCONTEXT_STALE",
          message: `DevContext 有 ${staleSections.length || "若干"} 段可能已过期，尚未重算`,
          hint: "请在 PRD 页底部 DevContext 面板中重算，或确认无需更新。",
          severity: "block",
        });
      }
      if (devctx.status === "draft") {
        // 警告级：完整度低时「提示 PM 补充，不硬发」——是劝阻不是禁止（可 force 越过）。
        blockers.push({
          code: "DEVCONTEXT_DRAFT",
          message: "DevContext 尚为草稿态（三层校验未全部通过）",
          hint: "建议补全后再交付；确要交付请使用「强制交付」并自行承担风险。",
          severity: "warn",
        });
      }
    }
  }

  return blockers;
}
