// Prompt 注册表：任务类型 → Prompt 模块。新增任务只需在此登记 + models.ts 加路由。
import type { AITaskType } from "../models";
import type { PromptModule } from "./types";
import { dialoguingPrompt } from "./dialoguing";
import { researchAnalysisPrompt } from "./research-analysis";
import { solutionWritingPrompt } from "./designing";
import { prdWritingPrompt } from "./prd-writing";
import { prototypeGenPrompt } from "./prototype-gen";
import { prototypeEditPrompt } from "./prototype-edit";

const registry: Record<string, PromptModule> = {
  dialoguing: dialoguingPrompt,
  research_analysis: researchAnalysisPrompt,
  solution_writing: solutionWritingPrompt,
  prd_writing: prdWritingPrompt,
  prototype_gen: prototypeGenPrompt,
  prototype_edit: prototypeEditPrompt,
};

export function getPrompt(taskType: AITaskType): PromptModule {
  const p = registry[taskType];
  if (!p) throw new Error(`未登记 prompt：${taskType}`);
  return p;
}
