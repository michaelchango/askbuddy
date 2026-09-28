// 需求生命周期：需求级状态机（区别于 requirement_steps 的阶段级状态）。
//
// 纯函数、无副作用、客户端可直接导入——与 lib/steps-meta.ts 遵循同一惯例，
// 避免把 @cloudbase/node-sdk 经 services 拉进客户端打包。
// 本模块是 M5-D1 的「规则层」；「写入层」（唯一写入口 + 审计）见
// lib/services/requirement-status.ts，禁止在任何其他位置直接写 lifecycle 列。
//
// 设计依据：《M5 详细实施计划》§组1 / §B3。
// 与 askbuddy-legacy 五态机的两处刻意偏离（不得"修正"回去，单测钉死）：
//   1. created 与 designing 之间插入 dialoguing（PRDHub 的需求访谈是真实工作阶段）；
//   2. completed → designing 放开（变更影响分析会把已交付需求打回返工），
//      且该迁移必须带 reason 记入审计表。

import type { StepName, StepState } from "@/types";

export type RequirementLifecycle =
  | "created" // 已创建，尚未开始对话
  | "dialoguing" // 需求访谈中（卡片未定版）
  | "designing" // 产出设计资产中（调研 / 方案 / 原型 / PRD / DevContext）
  | "review" // 交付前人工复核
  | "completed" // 已交付
  | "archived"; // 已归档（形式终态；解档走 restore 特例，见 requirement-status.ts）

export const LIFECYCLE_KEYS: RequirementLifecycle[] = [
  "created",
  "dialoguing",
  "designing",
  "review",
  "completed",
  "archived",
];

export const LIFECYCLE_LABELS: Record<RequirementLifecycle, string> = {
  created: "待开始",
  dialoguing: "需求访谈",
  designing: "设计中",
  review: "待复核",
  completed: "已交付",
  archived: "已归档",
};

/** 邻接表：允许的迁移。archived 为形式终态（解档走 restore 特例）。 */
export const LIFECYCLE_TRANSITIONS: Record<
  RequirementLifecycle,
  RequirementLifecycle[]
> = {
  created: ["dialoguing", "archived"],
  dialoguing: ["designing", "archived"],
  designing: ["dialoguing", "review", "archived"], // 回退：变更打回需求访谈
  review: ["designing", "completed", "archived"], // 打回 / 通过
  completed: ["designing", "archived"], // 刻意偏离 askbuddy-legacy，见文件头
  archived: [],
};

/** 非法迁移错误。message 内含允许去的态列表，便于 API 直接透出给用户。 */
export class LifecycleTransitionError extends Error {
  readonly from: RequirementLifecycle;
  readonly to: RequirementLifecycle;
  readonly allowed: RequirementLifecycle[];

  constructor(from: RequirementLifecycle, to: RequirementLifecycle) {
    const allowed = LIFECYCLE_TRANSITIONS[from] ?? [];
    super(
      `非法生命周期迁移：${from} → ${to}。` +
        `允许的目标态：${allowed.length ? allowed.join(" / ") : "（无，终态）"}`
    );
    this.name = "LifecycleTransitionError";
    this.from = from;
    this.to = to;
    this.allowed = allowed;
  }
}

/**
 * 迁移需要 reason 但未提供（当前只有 completed → designing 一条）。
 *
 * 单独成类而非复用 Error，是为了让 API 层能把它映射成 400（客户端错误）
 * 而不是 500——「没填返工原因」是用户输入问题，不是服务端故障。
 */
export class LifecycleReasonRequiredError extends Error {
  readonly from: RequirementLifecycle;
  readonly to: RequirementLifecycle;

  constructor(from: RequirementLifecycle, to: RequirementLifecycle) {
    super(
      `${from} → ${to} 的返工迁移必须携带 reason（记入 requirement_status_history，用于区分正常返工与误操作）。`
    );
    this.name = "LifecycleReasonRequiredError";
    this.from = from;
    this.to = to;
  }
}

export function canTransition(
  from: RequirementLifecycle,
  to: RequirementLifecycle
): boolean {
  return (LIFECYCLE_TRANSITIONS[from] ?? []).includes(to);
}

/** 非法迁移直接抛 LifecycleTransitionError（服务层与 API 共用这一份判定）。 */
export function assertTransition(
  from: RequirementLifecycle,
  to: RequirementLifecycle
): void {
  if (!canTransition(from, to)) {
    throw new LifecycleTransitionError(from, to);
  }
}

export function availableTransitions(
  from: RequirementLifecycle
): RequirementLifecycle[] {
  return [...(LIFECYCLE_TRANSITIONS[from] ?? [])];
}

/** 可编辑性：completed / archived 的需求不允许再推进步骤（UI 据此置灰）。 */
export function isEditable(s: RequirementLifecycle): boolean {
  return s !== "completed" && s !== "archived";
}

export function isTerminal(s: RequirementLifecycle): boolean {
  return s === "archived";
}

/**
 * 自动派生：由步骤状态推导「系统认为应该处于」的生命周期。
 *
 * 只产出 created / dialoguing / designing / archived 四态——
 * review / completed 是人工决策态，系统永不自动进入（HITL 主权，单测钉死）。
 *
 * 判定顺序（必须严格短路，单测逐条覆盖）：
 *   1. archivedAt 存在 → archived
 *   2. 全部步骤 not_started 且无对话 → created
 *   3. dialoguing 步骤未 done → dialoguing
 *   4. 其余 → designing
 */
export function deriveLifecycle(input: {
  archivedAt?: string | null;
  hasConversation: boolean;
  steps: Array<{ step: StepName; state: StepState }>;
}): Extract<
  RequirementLifecycle,
  "created" | "dialoguing" | "designing" | "archived"
> {
  // 1. 归档优先于一切（archived_at 是归档的事实源，与 lib/stage.ts 既有约定一致）
  if (input.archivedAt) return "archived";

  const steps = input.steps ?? [];
  const allNotStarted =
    steps.length === 0 || steps.every((s) => s.state === "not_started");

  // 2. 全部未开始且没有任何对话 → created
  if (allNotStarted && !input.hasConversation) return "created";

  // 3. 访谈未定版 → dialoguing
  const dialoguing = steps.find((s) => s.step === "dialoguing");
  if (!dialoguing || dialoguing.state !== "done") return "dialoguing";

  // 4. 其余 → designing
  return "designing";
}
