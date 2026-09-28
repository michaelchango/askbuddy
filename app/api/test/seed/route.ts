// e2e 专用 seed 通道（M5-D5 · P4-4）。
//
// 【为什么必须走 HTTP】mock 数据库是 **dev server 进程的内存表**，Playwright 测试进程
// 根本访问不到它（`globalThis.__askbuddy_memory` 只在同进程内共享）。所以「把库摆成
// 某个状态」这件事只能通过打 dev server 的 HTTP 端点来完成。
//
// 【安全】一个能往数据库随便写的未鉴权端点在生产环境是灾难。守卫是**双重**的：
//   `USE_MOCK === 'true'` **且** `NODE_ENV !== 'production'`，否则一律 404
//（返回 404 而不是 403：不暴露这个端点的存在）。
//
// 【为什么用真实服务而不是手写原始行】手写行要维护几十个列名与约束（还都是 camelCase
// 漂移键），改一处 schema 就全烂。这里直接调 `createProject/createRequirement/
// runDevContextGeneration/transitionLifecycle` —— seed 出来的数据与应用自己产生的
// 数据**走同一条路径**，不会出现「seed 能跑但应用读不了」的假绿。
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createProject } from "@/lib/services/projects";
import {
  createRequirement,
  getRequirement,
  mergeRequirementCard,
} from "@/lib/services/requirements";
import { getSteps, markStepDone, setStepState } from "@/lib/services/steps";
import { STEP_KEYS } from "@/lib/steps-meta";
import { getDevContext } from "@/lib/services/devcontext";
import { getLifecycle, transitionLifecycle } from "@/lib/services/requirement-status";
import { runDevContextGeneration } from "@/lib/ai/steps/devcontext";
import type { RequirementCard } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 未走 /try 的会话一律映射到这个 uid（与 lib/auth/session.ts 的 FALLBACK_DEV_UID 一致）。 */
const MOCK_UID = "mock-user-001";

const FULL_CARD: RequirementCard = {
  background: "（e2e）团队在多个项目间重复定义相同的业务规则，缺少统一沉淀处。",
  targetUsers: "产品经理、研发工程师",
  painPoints: "规则散落在 PRD 各处，改一处要翻五份文档，极易漏改。",
  scope: "项目级知识沉淀 + 语义检索 + 生成时自动注入。",
  nonFunctional: "检索 P95 ≤ 500ms；注入失败不得阻断主流程。",
  constraints: "数据保留期 30 天；仅项目内可见。",
};

/** 双重守卫：不满足则 404（不暴露端点存在性）。 */
function guard(): NextResponse | null {
  if (process.env.USE_MOCK !== "true" || process.env.NODE_ENV === "production") {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  return null;
}

/**
 * 清空内存表。
 *
 * ⚠️ 必须**原地清空**而不是 `delete globalThis.__askbuddy_memory`：
 * lib/db/mock.ts 在 import 时就把该对象的引用捕获进模块闭包，delete 之后
 * 后端仍持有旧引用，等于没清（与 tests/setup/unit.ts 是同一个坑）。
 */
function clearMemory(): void {
  const g = globalThis as Record<string, unknown>;
  const memory = g.__askbuddy_memory as Record<string, unknown[]> | undefined;
  if (!memory) return;
  for (const key of Object.keys(memory)) memory[key] = [];
}

async function seedEmpty() {
  const project = await createProject({ name: "e2e 空项目", ownerId: MOCK_UID });
  return { projectId: project.id, requirementId: null as string | null };
}

/** 卡片已定版、dialoguing 已 done。 */
async function seedCardReady() {
  const project = await createProject({ name: "e2e 卡片就绪", ownerId: MOCK_UID });
  const req = await createRequirement({
    projectId: project.id,
    title: "e2e 需求：卡片已定版",
    card: FULL_CARD,
  });
  // markStepDone 对 dialoguing 会自动定版（finalizeCardVersion → v1）
  await markStepDone(req.id, "dialoguing");
  return { projectId: project.id, requirementId: req.id };
}

/** 四步全 done + 四份上游产物齐备 + DevContext 已生成 + 生命周期 completed。 */
async function seedFullFlow() {
  const base = await seedCardReady();
  const rid = base.requirementId;

  // ⚠️ 必须把四份上游产物也造出来：`listOutputs()` 用「行是否存在」决定侧栏条目能否点击，
  // 而「开发上下文」面板只在 PRD 视图下挂载——产物缺失时 PRD 入口是禁用态，
  // 任何断言 DC 面板的用例都会卡在「点不进去」。用真实 save* 函数落库（与生成链路同路径）。
  const [outputs, prototypes] = await Promise.all([
    import("@/lib/services/outputs"),
    import("@/lib/services/prototypes"),
  ]);
  await outputs.saveResearchAnalysis(rid, {
    report: "## （seed）调研结论\n\n目标用户为需要高频记录灵感的职场人群。",
    userStories: [{ role: "用户", goal: "快速记录灵感", reason: "减少遗忘" }],
    features: [{ name: "灵感速记", desc: "极简输入即保存", priority: "P0", module: "核心" }],
  });
  await outputs.saveSolution(rid, "## （seed）方案概述\n\n单页应用 + 本地存储，零后端依赖。");
  await prototypes.savePrototypeVersion(rid, {
    html: "<!DOCTYPE html><html><body><main id=\"app\">（seed）原型</main></body></html>",
    structure: { pages: [{ id: "main", title: "主界面" }] },
  });
  await outputs.savePRD(rid, "# （seed）需求文档\n\n## 1. 背景\n\n零门槛记录。\n\n## 2. 验收标准\n\n保存后立即可见。");

  for (const step of STEP_KEYS) {
    if (step !== "dialoguing") await markStepDone(rid, step);
  }
  // 走**真实生成链路**（mock AI 确定性、0 延迟）落一份 DevContext v1
  await runDevContextGeneration(rid, { trigger: "manual" });
  await transitionLifecycle(rid, "review", { actor: MOCK_UID });
  await transitionLifecycle(rid, "completed", { actor: MOCK_UID });
  return base;
}

/** 待复核 + 一条 pending 建议（用于验证 PENDING_SUGGESTION 闸门）。 */
async function seedReviewBlocked() {
  const base = await seedFullFlow();
  const rid = base.requirementId;
  // full-flow 结束在 completed，这里回到 review 再加建议，形成「待复核且被闸门挡住」
  await transitionLifecycle(rid, "designing", {
    actor: MOCK_UID,
    reason: "e2e 造场景：回到复核前",
  });
  await transitionLifecycle(rid, "review", { actor: MOCK_UID });
  await db.insert("suggestions", {
    id: crypto.randomUUID(),
    requirement_id: rid,
    target_type: "dev_context",
    target_path: "business_rules[0].formal.then",
    op: "modify",
    payload: { statement: "（e2e）建议修改这条业务规则" },
    status: "pending",
    source: null,
    created_at: new Date().toISOString(),
  });
  return base;
}

/** DevContext 为 draft（完整度偏低）——用于验证「草案态交付是 warn 而非 block」。 */
async function seedDraftDevContext() {
  const base = await seedCardReady();
  const rid = base.requirementId;
  await setStepState(rid, "research_analysis", "done");
  await setStepState(rid, "design", "done");
  await setStepState(rid, "prd_writing", "done");
  // 只落两个 section 的 DC → 完整度必然 < 0.7 → draft
  const { saveDevContext } = await import("@/lib/services/devcontext");
  const { completenessScore, checkConsistency, detectUpstreamSignals } = await import(
    "@/lib/services/devcontext-validate"
  );
  const { generateDevContextSections } = await import("@/lib/ai/mock/fixtures/dev-context");
  const body = generateDevContextSections(["objective", "scope"] as never, "e2e-draft");
  const signals = await detectUpstreamSignals(rid);
  const score = completenessScore(body as never, signals);
  const issues = await checkConsistency(body as never, rid);
  await saveDevContext(rid, body as never, {
    score,
    issues,
    status: "draft",
    trigger: "manual",
    note: "e2e：刻意只生成两段以制造 draft",
  });
  return base;
}

const PRESETS: Record<string, () => Promise<{ projectId: string; requirementId: string | null }>> =
  {
    empty: seedEmpty,
    "card-ready": seedCardReady,
    "full-flow": seedFullFlow,
    "review-blocked": seedReviewBlocked,
    "draft-devcontext": seedDraftDevContext,
  };

export async function POST(req: NextRequest) {
  const denied = guard();
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const preset = typeof body?.preset === "string" ? body.preset : "empty";
  const factory = PRESETS[preset];
  if (!factory) {
    return NextResponse.json(
      { ok: false, error: "unknown_preset", available: Object.keys(PRESETS) },
      { status: 400 }
    );
  }

  // 每个 preset 从干净内存表起步：e2e 用例之间不互相污染（与 workers:1 是配套的）
  clearMemory();

  try {
    const data = await factory();
    // 需要走 MCP 的场景（05）：顺手签发一枚 PAT（MCP server 用 Bearer 鉴权）
    let token: string | null = null;
    if (body?.withToken === true) {
      const { createToken } = await import("@/lib/services/tokens");
      const t = await createToken(MOCK_UID, "e2e", 1);
      token = t.raw;
    }
    return NextResponse.json({ ok: true, data: { preset, token, ...data } });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "seed_failed", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

/**
 * 只读内省：让 e2e 能直接断言库内状态（生命周期 / 审计 / 步骤 / DevContext 标记），
 * 不必去 UI 上找徽标、也不必再开一个只读 API。
 */
export async function GET(req: NextRequest) {
  const denied = guard();
  if (denied) return denied;

  const id = req.nextUrl.searchParams.get("requirementId");
  if (!id) return NextResponse.json({ ok: false, error: "requirementId required" }, { status: 400 });

  const req_ = await getRequirement(id);
  if (!req_) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const [steps, lifecycle, audit, dc, versions] = await Promise.all([
    getSteps(id),
    getLifecycle(id),
    db.findMany<{
      from_state: string | null;
      to_state: string;
      actor: string;
      reason: string | null;
      source: string;
      created_at: string;
    }>("requirement_status_history", {
      where: { requirement_id: { eq: id } },
      orderBy: [["created_at", "asc"]],
    }),
    getDevContext(id),
    db.findMany<{ version: number; changelog: unknown; status: string }>("dev_context_versions", {
      where: { requirement_id: { eq: id } },
      orderBy: [["version", "asc"]],
    }),
  ]);

  return NextResponse.json({
    ok: true,
    data: {
      requirement: {
        id,
        title: req_.title,
        currentVersion:
          ((req_ as unknown as Record<string, unknown>).current_version as number) ?? 0,
        lifecycle,
      },
      steps: steps.map((s) => ({
        step: s.step,
        state: s.state,
        awaitingConfirm: !!s.awaitingConfirm,
      })),
      audit: audit.map((a) => ({
        from: a.from_state,
        to: a.to_state,
        actor: a.actor,
        source: a.source,
        reason: a.reason,
      })),
      devContext: dc
        ? {
            exists: true,
            version: dc.current_version,
            status: dc.status,
            completeness_score: dc.completeness_score,
            maybe_stale: dc.maybe_stale === 1,
            stale_sections: dc.stale_sections ?? [],
            stale_reason: dc.stale_reason ?? {},
            content: dc.content,
            /** 全部版本快照（e2e 用最后一条的 changelog 对账定向重算的 changed/unchanged）。 */
            versions: versions.map((v) => ({
              version: v.version,
              status: v.status,
              changelog: v.changelog,
            })),
          }
        : { exists: false, versions: [] },
    },
  });
}

/** 清空内存表（用例收尾用）。 */
export async function DELETE() {
  const denied = guard();
  if (denied) return denied;
  clearMemory();
  return NextResponse.json({ ok: true });
}
