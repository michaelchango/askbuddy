// 步骤流程的纯函数元数据，不依赖数据库 / 服务端 SDK。
// 客户端组件（如 requirement-shell）可直接导入本模块，
// 避免把 @/lib/db（含 @cloudbase/node-sdk）拉进客户端打包。

import type { StepName } from "@/types";

// 流程节点顺序：需求确认 → 调研分析 → 方案设计 → 需求文档
export const STEP_KEYS: StepName[] = [
  "dialoguing",
  "research_analysis",
  "design",
  "prd_writing",
];

// 阶段推进映射：返回某步骤确认后要进入的下一阶段（最后一步返回 null）
export function nextStepOf(step: StepName): StepName | null {
  const idx = STEP_KEYS.indexOf(step);
  return idx >= 0 && idx < STEP_KEYS.length - 1 ? STEP_KEYS[idx + 1] : null;
}
