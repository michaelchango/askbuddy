// 全局类型定义：与 db/schema.sql、requirement-model.md 对齐。
import { AI_TASK_MODEL } from "@/lib/ai/models";

// 4 步核心 + 弹性完成度模型：
//   dialoguing → researching → designing → prd_writing → completed
export type RequirementStatus =
  | "dialoguing"
  | "researching"
  | "designing"
  | "prd_writing"
  | "completed"
  | "archived";

export type ProjectStatus = "active" | "archived";

export type AITaskStatus = "pending" | "running" | "success" | "failed";

// [暂不使用] 步骤完成度（内容完整度）：充分 / 简要 / 跳过
// 说明：内容完整度属于独立的后续功能，本轮仅保留类型定义，不参与状态流转与 UI 展示。
export type StepCompletion = "full" | "brief" | "skip";

// 步骤状态（流程节点状态）：未开始 / 进行中 / 已完成 / 待更新
// 这是驱动步骤节点展示与流转的唯一依据（与上面的 StepCompletion 解耦）。
export type StepState = "not_started" | "in_progress" | "done" | "pending_update";

// 4 步对应的内部键
export type StepName = "dialoguing" | "research_analysis" | "design" | "prd_writing";

export interface RequirementStep {
  id: number | string;
  requirementId: string;
  step: StepName;
  state: StepState;                  // 流程节点状态（当前使用）
  completion?: StepCompletion;       // [暂不使用] 内容完整度，后续独立功能
  note?: string;
  outputVersion?: number;
  awaitingConfirm?: boolean;        // 确认闸门：true 表示已生成/达标、等待用户手动确认进入下一阶段
  generating?: boolean;             // 生成中标记：true 表示该步骤产物正在生成（跨页面/会话持久化）
  completedAt?: string;
  updatedAt: string;
}

// 结构化需求卡片
export interface RequirementCard {
  background: string;
  targetUsers: string;
  painPoints: string;
  scope: string;
  nonFunctional: string;
  constraints: string;
  [key: string]: unknown;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  ownerId: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

// 标题来源：auto=对话自动概括（锁定，不再改写）；manual=用户手动改名；null=尚未确定。
export type TitleSource = "auto" | "manual" | null;

export interface Requirement {
  id: string;
  projectId: string;
  title: string;
  titleSource?: TitleSource;
  /**
   * 【派生字段，不落库】需求阶段由 requirement_steps.state 实时推导，
   * 经 lib/stage.ts:attachDerivedStatus 注入到返回对象上。
   * 数据库 requirements 表【没有】status 列 —— 历史上有过，但自创建后从不更新
   * （恒为 'dialoguing'），M1 已连同该列一并移除。读到的永远是推导值。
   */
  status: RequirementStatus;
  /**
   * 【派生字段，不落库】当前正在生成的步骤（无则为 null/undefined）。
   * 由 lib/stage.ts:attachDerivedStatus 依据 requirement_steps.generating 注入，
   * 供列表页展示「生成中」动效/角标使用。
   */
  generatingStep?: StepName | null;
  priority?: "low" | "medium" | "high";
  tags?: string[];
  category?: string;
  relatedIds?: string[];
  card: RequirementCard;
  createdAt: string;
  updatedAt: string;
  /**
   * 归档时间。列名口径统一为 snake_case：写入侧与 listRequirements /
   * listProjectRequirements 的过滤条件用的都是 archived_at，
   * 而 stage.ts 曾误读 camelCase 的 archivedAt —— 那个分支从未命中过。M1 已统一。
   */
  archived_at?: string;
}

export interface AITask {
  id: string;
  userId: string;
  requirementId?: string;
  taskType: keyof typeof AI_TASK_MODEL;
  status: AITaskStatus;
  progress: number;
  result?: unknown;
  error?: string;
}

export type { AITaskType } from "@/lib/ai/models";

// ---------- API Token（PAT） ----------
export interface ApiToken {
  id: string;
  name: string;
  key_preview: string;    // 脱敏后的 key 预览，如 "a1b2c3****x9y0"
  expires_at: string | null;
  created_at: string;
}
