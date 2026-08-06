// 阶段推导：依据 requirement_steps 的实际完成情况实时算出需求当前阶段。
// 独立于 services 层，仅依赖 db / steps-meta / types，避免与 projects/requirements 形成循环依赖。
import { db } from "@/lib/db";
import { STEP_KEYS } from "@/lib/steps-meta";
import type {
  Requirement,
  RequirementStatus,
  RequirementStep,
  StepCompletion,
  StepName,
  StepState,
} from "@/types";

// 步骤 → 阶段状态 的映射（步骤完成度由 requirement_steps 表独立管理，
// 阶段标签据步骤 state 实时推导，不再依赖创建后不再更新的 requirement.status 字段）。
const STEP_TO_STATUS: Record<StepName, RequirementStatus> = {
  dialoguing: "dialoguing",
  research_analysis: "researching",
  design: "designing",
  prd_writing: "prd_writing",
};

/**
 * 纯函数：依据 requirement_steps 的实际完成情况推导需求当前所处阶段。
 * - 已归档 → "archived"
 * - 全部步骤 done → "completed"
 * - 否则取首个未完成步骤，映射为其对应阶段
 * - 无步骤记录（存量老数据未初始化）→ 回退到原 status，避免崩溃
 */
export function deriveRequirementStatus(
  req: Requirement,
  steps: RequirementStep[]
): RequirementStatus {
  // 口径统一为 snake_case：写入侧与各处 list 过滤用的都是 archived_at，
  // 这里原本读的是 camelCase 的 archivedAt，因此该分支从未命中过（M1 修复）。
  if (req.archived_at) return "archived";
  // 无步骤记录 = 存量老数据未初始化。requirements 表已无 status 列（M1 T9），
  // 读出必为 undefined，回退到工作流第一阶段而不是 undefined，避免 UI 拿到空状态。
  if (steps.length === 0) return req.status ?? "dialoguing";
  const sorted = [...steps].sort(
    (a, b) => STEP_KEYS.indexOf(a.step) - STEP_KEYS.indexOf(b.step)
  );
  const current = sorted.find((s) => s.state !== "done");
  if (!current) return "completed";
  return STEP_TO_STATUS[current.step];
}

/**
 * 批量附加推导后的 status：一次扫描取回所有需求的 steps 并按 requirementId 分组，
 * 覆盖返回对象上的 status 字段。前端（r.status）/ 统计逻辑无需改动即可读到正确阶段。
 */
export async function attachDerivedStatus(
  requirements: Requirement[]
): Promise<Requirement[]> {
  if (requirements.length === 0) return requirements;
  // 下推：这是全站最热的查询之一 —— 每次列需求都会调用它。
  // 原实现把 requirement_steps 全表（上限 1000 行）拉回来再用 Set.has 过滤，
  // 需求数一多就会先撞上 1000 行截断，导致部分需求的阶段被算成 dialoguing。
  const ids = requirements.map((r) => r.id);
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
  }>("requirement_steps", { where: { requirement_id: { in: ids } } });

  const grouped = new Map<string, RequirementStep[]>();
  for (const r of rows) {
    const rid = r.requirement_id;
    const step: RequirementStep = {
      id: r.id,
      requirementId: rid,
      step: r.step as StepName,
      state: (r.state as StepState) ?? "not_started",
      completion: (r.completion as StepCompletion) ?? undefined,
      note: r.note,
      outputVersion: r.output_version,
      awaitingConfirm: !!r.awaiting_confirm,
      completedAt: r.completed_at,
      updatedAt: r.updated_at,
    };
    if (!grouped.has(rid)) grouped.set(rid, []);
    grouped.get(rid)!.push(step);
  }

  return requirements.map((req) => ({
    ...req,
    status: deriveRequirementStatus(req, grouped.get(req.id) ?? []),
  }));
}
