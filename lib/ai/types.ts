// AI 层共享类型与结构化契约。
import { z } from "zod";
import type { AITaskType } from "./models";
import type { StepName } from "@/types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// 需求卡片结构化契约（与 types/index.ts 的 RequirementCard 对齐）。
export const RequirementCardSchema = z.object({
  background: z.string(),
  targetUsers: z.string(),
  painPoints: z.string(),
  scope: z.string(),
  nonFunctional: z.string(),
  constraints: z.string(),
});
export type RequirementCardData = z.infer<typeof RequirementCardSchema>;

// 对话产出：自然语言回复 + 部分卡片（随对话渐进补全）。
export const DialogueOutputSchema = z.object({
  reply: z.string(),
  card: RequirementCardSchema.partial(),
});
export type DialogueOutput = z.infer<typeof DialogueOutputSchema>;

export interface AIResult {
  model: string;
  content: string;
}

// 任务上下文（harness 的「记忆/上下文」）：本次输入 + 历史 + 已有卡片。
export interface TaskContext {
  requirementId: string;
  taskType: AITaskType;
  vars: Record<string, unknown>;
  history?: ChatMessage[];
  card?: Partial<RequirementCardData>;
}

// 步骤级上下文（v2 积累式记忆）：增加 upstream 承载上游步骤输出物。
export interface StepTaskContext extends TaskContext {
  step: StepName;
  // key = 步骤/子产物标识，value = 截断后的文本内容（≤6000 字符）
  upstream: Record<string, string>;
  input?: Record<string, unknown>;
}

export interface StructuredParseResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

// 调研分析输出
export interface ResearchAnalysisOutput {
  report: string;
  userStories: Array<{ role: string; goal: string; reason: string }>;
  features: Array<{ name: string; desc: string; priority: string; module?: string }>;
}
