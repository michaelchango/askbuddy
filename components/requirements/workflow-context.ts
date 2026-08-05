"use client";
import { createContext, useContext } from "react";
import type { StepName } from "@/types";

export interface PendingPrompt {
  step: StepName;            // 当前已生成/达标、等待用户确认的"当前阶段"
  nextStep: StepName | null; // 确认后进入的下一阶段（prd_writing → null）
  canSkip: boolean;
  message: string;
  version?: number;          // 仅 prd_writing 需回写 steps.output_version
  auto?: boolean;            // true=前端自动推进（用户主动确认），false/undefined=渲染按钮等点击（模型主动判定）
  subPhase?: string;         // 子阶段标记：值为 "prototype" 时，确认后进入方案设计的原型子阶段而非标记步骤完成
}

// 变更更新任务队列中的单个任务
export interface ChangeTask {
  output: string;    // 输出物类型：card / research_analysis / design / prd
  status: "pending" | "generating" | "done" | "error";
}

export interface WorkflowState {
  // 当前正在生成的步骤
  generatingStep: StepName | null;
  // 流式生成的内容（实时推送到 OutputViewer）
  generationContent: string;
  // 待用户确认的下一步提示（确认闸门）
  pendingPrompt: PendingPrompt | null;
  // 用户确认进入下一步
  onProceed: () => void;
  // 用户点击【返回修改】：在输入框填入默认修改文案
  onReturnToModify: () => void;
  // 变更更新任务队列（非空表示正在处理变更）
  changeTasks: ChangeTask[];
  // 方案设计步骤的子阶段：null=方案文档阶段，"prototype"=原型设计子阶段
  designSubPhase: "prototype" | null;
}

export const WorkflowContext = createContext<WorkflowState | null>(null);

export function useWorkflow(): WorkflowState | null {
  return useContext(WorkflowContext);
}
