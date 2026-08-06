// 步骤状态服务：requirement_steps 表 CRUD。
// 说明：requirement_steps 同时保留旧字段 completion（内容完整度，[暂不使用]），
// 本轮新增 state（流程节点状态）作为状态流转与 UI 展示的唯一依据。
import { db } from "@/lib/db";
import { STEP_KEYS, nextStepOf } from "@/lib/steps-meta";
import type { StepName, StepState, StepCompletion, RequirementStep } from "@/types";

// 对外重新导出纯函数，供服务端路由继续使用（客户端请直接 import @/lib/steps-meta）
export { nextStepOf };

// 生成全局唯一的步骤行 id。
// 注意：requirement_steps 的 id 必须跨需求唯一——历史上曾用自增计数器(1/2/3/4)，
// 导致 db.update(id) 命中全表第一个 id 相同的行（属于其它需求），当前需求状态永远改不到。
// 改用随机 UUID，确保 update 按 id 精确命中本需求的步骤行。
function newStepId(): string {
  return crypto.randomUUID();
}

// 判断当前步骤是否为"前沿阶段"（frontier）：其所有下游步骤状态均为 not_started。
// 由于阶段严格顺序推进，状态一定是连续前缀（done/done/in_progress/not_started），
// 故 frontier 唯一且良定义——即最后一个状态非 not_started 的阶段。
// 用途：变更（change）重生成时，上游阶段自动置 done，前沿阶段需重开确认闸门。
export function isFrontierStep(steps: RequirementStep[], step: StepName): boolean {
  const idx = STEP_KEYS.indexOf(step);
  if (idx < 0) return false;
  // 检查所有下游步骤：全都 not_started 才算 frontier
  for (let i = idx + 1; i < STEP_KEYS.length; i++) {
    const downstream = steps.find((s) => s.step === STEP_KEYS[i]);
    if (downstream && downstream.state !== "not_started") {
      return false;
    }
  }
  return true;
}

// 为新需求初始化 4 行步骤，默认状态均为【未开始】
export async function initSteps(requirementId: string): Promise<void> {
  const now = new Date().toISOString();
  for (const step of STEP_KEYS) {
    await db.insert("requirement_steps", {
      id: newStepId(),
      requirement_id: requirementId,
      step,
      state: "not_started",
      awaiting_confirm: 0,
      // completion: [暂不使用] 内容完整度功能后续独立实现，保留列仅作存量兼容
      note: null,
      output_version: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
    });
  }
}

// 获取需求的所有步骤状态
export async function getSteps(requirementId: string): Promise<RequirementStep[]> {
  // 下推 where；排序保留在内存：STEP_KEYS 是「工作流先后顺序」而非列值顺序，
  // 无法用 ORDER BY 表达（除非在库里加一列 step_order，那是过度设计）。
  const rows = await db.findMany<{
    id: number | string;
    requirement_id: string;
    step: string;
    state?: string;
    completion?: string;
    note?: string;
    output_version?: number;
    awaiting_confirm?: number | boolean;
    completed_at?: string;
    updated_at: string;
  }>("requirement_steps", {
    where: { requirement_id: { eq: requirementId } },
  });

  // 惰性初始化：旧需求可能没有步骤记录
  if (rows.length === 0) {
    await initSteps(requirementId);
    return getSteps(requirementId);
  }

  return rows
    .map((r) => ({
      id: r.id,
      requirementId: r.requirement_id,
      step: r.step as StepName,
      state: (r.state as StepState) ?? "not_started",
      completion: (r.completion as StepCompletion) ?? undefined, // [暂不使用]
      note: r.note,
      outputVersion: r.output_version,
      awaitingConfirm: !!r.awaiting_confirm,
      completedAt: r.completed_at,
      updatedAt: r.updated_at,
    }))
    .sort((a, b) => STEP_KEYS.indexOf(a.step) - STEP_KEYS.indexOf(b.step));
}

// 更新单步骤的状态（流程节点状态）
// 注意：必须用 updateWhere 按 (requirement_id + step) 精确定位，
// 不能依赖 id —— 历史自增 id 在跨需求间不唯一，会导致更新命中错误行。
export async function setStepState(
  requirementId: string,
  step: StepName,
  state: StepState,
  options?: { note?: string; outputVersion?: number; awaitingConfirm?: boolean }
): Promise<void> {
  const now = new Date().toISOString();

  const patch: Record<string, unknown> = {
    state,
    note: options?.note ?? null,
    output_version: options?.outputVersion ?? null,
    completed_at: state === "done" ? now : null,
    updated_at: now,
  };
  // 仅当显式传入时才覆盖 awaiting_confirm，避免误清除已开启的确认闸门
  if (options?.awaitingConfirm !== undefined) {
    patch.awaiting_confirm = options.awaitingConfirm ? 1 : 0;
  }

  // 只需要判断存在性，用 countMany 而不是把整行拉回来。
  // PG 侧命中唯一索引 uq_step (requirement_id, step)，是一次索引探测。
  const existing = await db.countMany("requirement_steps", {
    requirement_id: { eq: requirementId },
    step: { eq: step },
  });

  if (existing > 0) {
    // 行已存在：按 (requirement_id + step) 精确更新
    await db.updateWhere(
      "requirement_steps",
      { requirement_id: requirementId, step },
      patch
    );
  } else {
    // 兜底：极端情况下行尚未初始化，直接插入
    await db.insert("requirement_steps", {
      id: newStepId(),
      requirement_id: requirementId,
      step,
      ...patch,
      created_at: now,
    });
  }
}

// 便捷封装：步骤完成（置【已完成】，并写 completed_at、清除确认闸门）
// 里程碑定版：需求确认（dialoguing）首次置 done 且尚无卡片版本时，冻结当前卡片为 v1。
// markStepDone 是 dialoguing→done 的唯一权威落点（调研生成 / 手动确认均经此），在此拦截可覆盖所有推进路径。
export async function markStepDone(
  requirementId: string,
  step: StepName,
  outputVersion?: number
): Promise<void> {
  if (step === "dialoguing") {
    try {
      // 动态导入避免与 requirements.ts 的模块循环依赖
      const { getRequirement, finalizeCardVersion } = await import("./requirements");
      const req = await getRequirement(requirementId);
      const currentVer =
        ((req as unknown as Record<string, unknown>)?.current_version as number) ?? 0;
      if (currentVer === 0) {
        await finalizeCardVersion(requirementId, "需求确认定版");
      }
    } catch {
      /* 定版失败不阻塞步骤推进 */
    }
  }
  return setStepState(requirementId, step, "done", { outputVersion, awaitingConfirm: false });
}

// 便捷封装：步骤进行中（清除确认闸门）
export async function markStepInProgress(
  requirementId: string,
  step: StepName
): Promise<void> {
  return setStepState(requirementId, step, "in_progress", { awaitingConfirm: false });
}

// 便捷封装：步骤待更新（清除确认闸门）
export async function markStepPendingUpdate(
  requirementId: string,
  step: StepName
): Promise<void> {
  return setStepState(requirementId, step, "pending_update", { awaitingConfirm: false });
}

// 阶段推进映射 nextStepOf 已移至 @/lib/steps-meta（纯函数，客户端可用），
// 此处从改模块导入并统一对外导出。

// 步骤完成并推进下一节点：自身置【已完成】，下一节点置【进行中】
export async function completeStepAndAdvance(
  requirementId: string,
  step: StepName,
  outputVersion?: number
): Promise<void> {
  const idx = STEP_KEYS.indexOf(step);
  await markStepDone(requirementId, step, outputVersion);
  if (idx >= 0 && idx < STEP_KEYS.length - 1) {
    await markStepInProgress(requirementId, STEP_KEYS[idx + 1]);
  }
}

// 仅更新确认闸门标记 awaiting_confirm（不影响 state/version 等其它字段）。
// 用于"生成完成/需求达标后等待用户手动确认"的场景，使确认按钮可在重进会话后恢复。
export async function setAwaitingConfirm(
  requirementId: string,
  step: StepName,
  value: boolean
): Promise<void> {
  await db.updateWhere(
    "requirement_steps",
    { requirement_id: requirementId, step },
    { awaiting_confirm: value ? 1 : 0, updated_at: new Date().toISOString() }
  );
}
