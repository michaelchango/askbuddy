// 卡片变更合并服务：变更流程中卡片受影响时，聚焦合并卡片字段并落库。
// 独立于对话主链路：一次 AI 调用，失败兜底为保持原卡片不动。
import { callAI } from "@/lib/ai/client";
import { getRequirement, finalizeCardVersion } from "./requirements";
import { saveCardConnector } from "@/lib/ai/connectors/internal/save-card";
import { cardMergeSystemPrompt } from "@/lib/ai/prompts/card-merge";
import type { RequirementCardData } from "@/lib/ai/types";

const CARD_FIELDS: Array<keyof RequirementCardData> = [
  "background",
  "targetUsers",
  "painPoints",
  "scope",
  "nonFunctional",
  "constraints",
];

// 基于「现有卡片 + 变更描述」合并卡片并写回（复用 saveCardConnector）。
// 合并成功后触发"变更定版"：卡片版本 +1，note 记录变更摘要（优先 noteSummary，缺省用 changeText）。
// 失败（AI 异常 / 解析失败）时静默兜底：不修改原卡片、不定版，不抛错阻断变更主流程。
export async function applyCardChange(
  requirementId: string,
  changeText: string,
  noteSummary?: string
): Promise<boolean> {
  const req = await getRequirement(requirementId);
  const card = (req?.card ?? {}) as Partial<RequirementCardData>;

  const userContent = [
    "【现有需求卡片】\n" + JSON.stringify(card, null, 2),
    "【变更点】\n" + changeText.slice(0, 2000),
    "请按规则输出更新后的完整需求卡片 JSON。",
  ].join("\n\n");

  try {
    const result = await callAI("dialoguing", [
      { role: "system", content: cardMergeSystemPrompt },
      { role: "user", content: userContent },
    ]);

    const content = result.content.replace(/<think[\s\S]*?<\/think>/gi, "").trim();

    let parsed: Record<string, unknown> | null = null;
    const fence = content.match(/```json\s*([\s\S]*?)\s*```/i);
    if (fence) {
      try { parsed = JSON.parse(fence[1]); } catch { /* ignore */ }
    }
    if (!parsed) {
      const obj = content.match(/\{[\s\S]*\}/);
      if (obj) {
        try { parsed = JSON.parse(obj[0]); } catch { /* ignore */ }
      }
    }
    if (!parsed || typeof parsed !== "object") return false;

    // 只收录合法字段且为非空字符串，避免脏数据写回
    const merged: Partial<RequirementCardData> = {};
    for (const key of CARD_FIELDS) {
      const v = parsed[key];
      if (typeof v === "string" && v.trim()) merged[key] = v.trim();
    }
    if (Object.keys(merged).length === 0) return false;

    await saveCardConnector.execute({ requirementId, data: merged });
    // 变更定版：卡片内容已按变更更新，冻结为新版本并记录变更摘要
    await finalizeCardVersion(
      requirementId,
      `需求变更：${(noteSummary ?? changeText).trim()}`
    ).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
