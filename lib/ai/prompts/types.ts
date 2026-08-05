// Prompt 模块类型：每个任务一个规范化 prompt，便于集中调优与版本化。
import type { AITaskType } from "../models";
import type { ChatMessage } from "../types";

export interface PromptVars {
  message: string;
  card?: Record<string, unknown>;
  history?: ChatMessage[];
  references?: string;
  // 上游步骤输出物（积累式记忆），key=步骤/子产物名，value=内容文本
  upstream?: Record<string, string>;
  // 变更模式：changeNote=本次变更点描述；existingDoc=当前步骤已生成的文档内容。
  // 两者同时存在时，prompt 应切换为"基于现有文档做精准修改"而非全新生成。
  changeNote?: string;
  existingDoc?: string;
}

export interface PromptModule {
  taskType: AITaskType;
  system: string;
  buildUser(vars: PromptVars): string;
}
