// 阶段中文标签 / 推进话术 / 阶段推导纯函数。
// 本文件【不依赖 db】，可被客户端组件（"use client"）安全引用，
// 不会把 @cloudbase/node-sdk 等 Node 后端代码打进浏览器 bundle。
//
// 与后端 app/api/requirements/[id]/conversation/route.ts 中的实现保持一致，
// 前后端共用，确保对话自动推进与按钮手动进入下一阶段的提示文案一致。
export const STAGE_LABELS: Record<string, string> = {
  dialoguing: "需求确认",
  research_analysis: "调研分析",
  design: "方案设计",
  prd_writing: "需求文档",
};

// design 步骤下的「原型设计」子阶段标签（方案文档确认后进入的子阶段，
// 与上方 STAGE_LABELS 一一对应的子级标签，统一在回复话术里复用，避免散落硬编码）
export const PROTOTYPE_STAGE_LABEL = "原型设计（交互原型）";

// 用户主动确认推进时的合成回复话术（与后端 proceedReplyText 一致）。
// 保证非空，修复按钮进入下一阶段时对话面板毫无反馈的问题。
//
// 文案风格统一起见，所有 subPhase / nextStep 路径都以"好的，xxx 已确认"打头，
// 仅在最后用方括号「」指出推进到的具体阶段（含子阶段"原型设计（交互原型）"）。
export function proceedReplyText(
  step: string,
  nextStep: string | null,
  subPhase?: string
): string {
  if (subPhase === "prototype") {
    return `好的，${STAGE_LABELS[step] ?? ""}已确认。正在为您推进到「${PROTOTYPE_STAGE_LABEL}」…`;
  }
  if (!nextStep) return `好的，${STAGE_LABELS[step] ?? ""}已完成，已为您标记完成。`;
  return `好的，${STAGE_LABELS[step] ?? ""}已确认。正在为您推进到「${STAGE_LABELS[nextStep]}」…`;
}

// 步骤 → 阶段状态 的映射（步骤完成度由 requirement_steps 表独立管理，
// 阶段标签据步骤 state 实时推导，不再依赖创建后不再更新的 requirement.status 字段）。
import type {
  Requirement,
  RequirementStatus,
  RequirementStep,
  StepName,
  StepState,
} from "@/types";

const STEP_TO_STATUS: Record<StepName, RequirementStatus> = {
  dialoguing: "dialoguing",
  research_analysis: "researching",
  design: "designing",
  prd_writing: "prd_writing",
};

/**
 * 纯函数：判断「需求卡片」是否已定版（完成态、带版本号）。
 * 不触碰 db，可在客户端/服务端通用。
 *
 * 定版的稳定事实（不可回退）：
 *  - currentVersion >= 1：首次定版（dialoguing 置 done）时由 finalizeCardVersion 写入；
 *  - 确认闸门曾打开（awaitingConfirm === true 且 dialoguing 步骤非 not_started）：
 *    需求确认达标后即便用户尚未点「确认并进入下一阶段」（state 仍 in_progress），
 *    卡片本身已是一个有版本号的完成态产物。
 *
 * 这是修复「切出详情页再进入时需求卡片状态回落为进行中」的关键判据：
 * 一旦卡片定版，状态推导不再因 dialoguing 步骤的 state 残留（未落库为 done）
 * 或后续阶段推进 / generating 标记而回落为 "dialoguing"。
 */
export function isCardFinalized(
  awaitingConfirm: boolean,
  currentVersion: number,
  dialoguingState?: StepState
): boolean {
  if (currentVersion >= 1) return true;
  if (awaitingConfirm && dialoguingState && dialoguingState !== "not_started")
    return true;
  return false;
}

/**
 * 纯函数：依据 requirement_steps 的实际完成情况推导需求当前所处阶段。
 * 不触碰 db，可在客户端/服务端通用。
 * - 已归档 → "archived"
 * - 全部步骤 done → "completed"
 * - 否则取首个未完成步骤，映射为其对应阶段
 * - 无步骤记录（存量老数据未初始化）→ 回退到原 status，避免崩溃
 *
 * opts.cardFinalized：需求卡片是否已定版（见 isCardFinalized）。为真时，
 * 「需求确认（dialoguing）」阶段视为已完成参与推导，整体阶段不再回落为
 * "dialoguing"，但后续阶段标签仍由各自步骤 state 正常驱动。
 */
export function deriveRequirementStatus(
  req: Requirement,
  steps: RequirementStep[],
  opts?: { cardFinalized?: boolean }
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
  const finalized = opts?.cardFinalized ?? false;
  // 卡片已定版：dialoguing 步骤视为已完成，不再作为「首个未完成步骤」参与推导，
  // 避免其 state 残留 in_progress 把整体阶段错误地回落成 "dialoguing"。
  const current = sorted.find(
    (s) => s.state !== "done" && !(finalized && s.step === "dialoguing")
  );
  if (!current) return "completed";
  return STEP_TO_STATUS[current.step];
}

import { STEP_KEYS } from "@/lib/steps-meta";
