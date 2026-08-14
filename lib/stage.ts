// 阶段推导（依赖 db 的部分）。
//
// ⚠️ 本文件会 import db（Node 后端），因此【只能被服务端代码引用】，
// 禁止被 "use client" 组件直接 import，否则会把 @cloudbase/node-sdk 打进浏览器 bundle。
// 客户端组件请改用 @/lib/stage-meta 获取 STAGE_LABELS / proceedReplyText /
// deriveRequirementStatus（纯前端安全，无 db 依赖）。
//
// 这里 re-export 纯前端内容，保持旧 import 路径 @/lib/stage 的兼容。
export { STAGE_LABELS, proceedReplyText } from "@/lib/stage-meta";
// 显式 import，使 deriveRequirementStatus / isCardFinalized 成为本作用域内的绑定，
// attachDerivedStatus 才能正确调用（re-export 不会被当作本地定义）。
import { deriveRequirementStatus, isCardFinalized } from "@/lib/stage-meta";

// 阶段推导：依据 requirement_steps 的实际完成情况实时算出需求当前阶段。
// 独立于 services 层，仅依赖 db / steps-meta / types，避免与 projects/requirements 形成循环依赖。
import { db } from "@/lib/db";
import { STEP_KEYS } from "@/lib/steps-meta";
import type {
  Requirement,
  RequirementStep,
  StepCompletion,
  StepName,
  StepState,
} from "@/types";

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
    generating?: number | boolean;
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
      generating: !!r.generating,
      completedAt: r.completed_at,
      updatedAt: r.updated_at,
    };
    if (!grouped.has(rid)) grouped.set(rid, []);
    grouped.get(rid)!.push(step);
  }

  return requirements.map((req) => {
    const steps = grouped.get(req.id) ?? [];
    // 派生「需求卡片是否已定版」：current_version 是 requirements 表的非标准代码键
    // （未在 Requirement 类型声明），需用 Record 形态安全读取。该字段由首次定版
    // （dialoguing 置 done）写入，不可回退，是「卡片已完成态」最可靠的判据。
    const currentVersion =
      ((req as unknown as Record<string, unknown>)?.current_version as number) ?? 0;
    const dialoguing = steps.find((s) => s.step === "dialoguing");
    const cardFinalized = isCardFinalized(
      !!dialoguing?.awaitingConfirm,
      currentVersion,
      dialoguing?.state
    );
    // 派生「当前正在生成的步骤」：取首个 generating=true 的步骤。
    // 阶段标签由 deriveRequirementStatus 依据 state 推导（生成中的步骤 state 已是
    // in_progress，故 status 天然指向该步骤对应阶段），此处额外暴露 generatingStep
    // 供前端在阶段标签旁叠加「生成中」动效/角标。
    const generating = steps.find((s) => s.generating === true);
    return {
      ...req,
      status: deriveRequirementStatus(req, steps, { cardFinalized }),
      generatingStep: generating ? generating.step : null,
    };
  });
}
