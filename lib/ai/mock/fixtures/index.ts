// Mock 夹具总调度（M5-D3）。
//
// 调度顺序即优先级，两类「按 prompt 识别」的分支必须排在做 taskType 之前：
//   card-merge 与 change-analysis 都挂在 `dialoguing` 任务上（历史原因：它们复用
//   对话模型），只能靠 system prompt 的特征串区分——这是刻意的确定性识别，
//   不是模糊匹配（特征串取自两个 prompt 的固定文案，改动它们会让本文件一起报红，
//   由 tests/unit/ai-provider.spec.ts 的「prompt 特征串仍在」用例守护）。

import type { AITaskType } from "../../models";
import type { ChatMessage } from "../../types";
import { SECTION_KEYS, type SectionKey } from "@/lib/schemas/devcontext";
import { fingerprint } from "../hash";
import { dialogueFixture } from "./dialoguing";
import { researchFixture } from "./research-analysis";
import { changeAnalysisFixture, parseCandidates } from "./change-analysis";
import { cardMergeFixture } from "./card-merge";
import { devContextBaseFixture, generateDevContextSections } from "./dev-context";
import {
  genericFixture,
  knowledgeExtractFixture,
  prdFixture,
  prototypeFixture,
  solutionFixture,
  titleFixture,
} from "./misc";

/** card-merge 的 prompt 特征串（取自 lib/ai/prompts/card-merge.ts）。 */
const CARD_MERGE_MARKER = "6 个字段（全部为字符串）";
/** change-analysis 的 prompt 特征串（取自 lib/ai/services/change-analyzer.ts 的 systemPrompt）。 */
const CHANGE_ANALYSIS_MARKER = "affectedOutputs";

/** 定向重算时 prompt 里的段清单行（见 lib/ai/prompts/devcontext.ts）。 */
const TARGETED_SECTIONS = /只重算\*\*这些 section：([^\n。]+)/;

export function systemOf(messages: ChatMessage[]): string {
  return messages.find((m) => m.role === "system")?.content ?? "";
}

export function lastUserOf(messages: ChatMessage[]): string {
  return [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
}

/** 从定向重算 prompt 里解析被请求的 section 清单。 */
export function parseTargetedSections(userContent: string): string[] {
  const m = userContent.match(TARGETED_SECTIONS);
  if (!m) return [];
  const known = new Set<string>(SECTION_KEYS);
  return m[1]
    .split("、")
    .map((s) => s.trim())
    .filter((s) => known.has(s));
}

function fenced(v: unknown): string {
  return "```json\n" + JSON.stringify(v, null, 2) + "\n```";
}

/** DevContext 夹具：区分「全量生成」与「定向重算」。 */
function devContextText(messages: ChatMessage[], scenario: string): string {
  const user = lastUserOf(messages);
  const seed = fingerprint(messages);

  if (scenario === "schema-invalid") {
    // business_rules 是 min(1) → 立即 Schema 失败（用于验证重试与错误分类）
    return fenced({ business_rules: [] });
  }
  if (scenario === "low-completeness") {
    const partial = generateDevContextSections(["objective", "scope"], seed);
    return fenced(partial);
  }

  const targeted = parseTargetedSections(user);
  if (targeted.length > 0) {
    return fenced(generateDevContextSections(targeted as SectionKey[], seed));
  }
  return fenced(generateDevContextSections([...SECTION_KEYS], seed));
}

/**
 * 按 (taskType, prompt 特征, scenario) 产出确定性文本。
 * 同一组输入 → 逐字节相同（`fingerprint` 参与所有 tag 的派生）。
 */
export function mockTextFor(
  taskType: AITaskType,
  messages: ChatMessage[],
  scenario: string
): string {
  const system = systemOf(messages);
  const user = lastUserOf(messages);
  const seed = fingerprint(messages);

  // ---- 挂在 dialoguing 上的两个「伪任务」（按 prompt 特征识别）----
  if (system.includes(CARD_MERGE_MARKER)) return cardMergeFixture(user, scenario);
  if (system.includes(CHANGE_ANALYSIS_MARKER)) {
    return changeAnalysisFixture(system, user, scenario);
  }

  switch (taskType) {
    case "dialoguing":
      return dialogueFixture(user, seed);
    case "title":
      return titleFixture(user);
    case "research_analysis":
      return researchFixture(seed);
    case "designing":
    case "solution_writing":
      return solutionFixture(seed);
    case "prd_writing":
      return prdFixture(seed);
    case "prototype_gen":
    case "prototype_edit":
      return prototypeFixture(seed);
    case "devcontext":
      return devContextText(messages, scenario);
    case "knowledge_extract":
      return knowledgeExtractFixture(seed);
    default:
      return genericFixture(taskType, seed);
  }
}

/** 供测试直接断言夹具本身（不必经 provider）。 */
export const __mockInternals = {
  parseTargetedSections,
  parseCandidates,
  devContextBaseFixture,
};
