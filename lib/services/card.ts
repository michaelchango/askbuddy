// 卡片变更合并服务：变更流程中卡片受影响时，聚焦合并卡片字段并落库。
// 独立于对话主链路：一次 AI 调用，失败兜底为保持原卡片不动。
import { callAI } from "@/lib/ai/client";
import { getRequirement, finalizeCardVersion } from "./requirements";
import { saveCardConnector } from "@/lib/ai/connectors/internal/save-card";
import { cardMergeSystemPrompt } from "@/lib/ai/prompts/card-merge";
import type { RequirementCardData } from "@/lib/ai/types";

/**
 * 卡片字段白名单（合并时只认这几个字段）。
 *
 * 【为什么导出】`tests/contract/impact-map.spec.ts` 要从这里**反射式**取字段名，
 * 断言每个卡片字段都有对应的 `card.<field>` 影响源——这样「给卡片加字段」这个动作
 * 会**必然**让契约测试报红，而不是等上线后出现漏重算。
 */
export const CARD_FIELDS: Array<keyof RequirementCardData> = [
  "background",
  "targetUsers",
  "painPoints",
  "scope",
  "nonFunctional",
  "constraints",
];

/** 卡片合并结果：`changedFields` 是 M5-D2 里质量最高的影响源（确定性字符串 diff）。 */
export interface CardChangeResult {
  ok: boolean;
  changedFields: Array<keyof RequirementCardData>;
}

// 基于「现有卡片 + 变更描述」合并卡片并写回（复用 saveCardConnector）。
// 合并成功后触发"变更定版"：卡片版本 +1，note 记录变更摘要（优先 noteSummary，缺省用 changeText）。
// 失败（AI 异常 / 解析失败）时静默兜底：不修改原卡片、不定版，不抛错阻断变更主流程。
export async function applyCardChange(
  requirementId: string,
  changeText: string,
  noteSummary?: string
): Promise<CardChangeResult> {
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
    if (!parsed || typeof parsed !== "object") return { ok: false, changedFields: [] };

    // 只收录合法字段且为非空字符串，避免脏数据写回；
    // 同时逐字段与「变更前」比对，收集字段级 diff（M5-D2 最可靠的影响源：
    // 卡片是 JSON，diff 是确定性的字符串比较，不掺任何 LLM 判断）。
    const merged: Partial<RequirementCardData> = {};
    const changedFields: Array<keyof RequirementCardData> = [];
    for (const key of CARD_FIELDS) {
      const v = parsed[key];
      if (typeof v !== "string" || !v.trim()) continue;
      merged[key] = v.trim();
      if ((card[key] ?? "").trim() !== merged[key]) changedFields.push(key);
    }
    if (Object.keys(merged).length === 0) return { ok: false, changedFields: [] };

    await saveCardConnector.execute({ requirementId, data: merged });
    // 变更定版：卡片内容已按变更更新，冻结为新版本并记录变更摘要
    await finalizeCardVersion(
      requirementId,
      `需求变更：${(noteSummary ?? changeText).trim()}`
    ).catch(() => {});
    return { ok: true, changedFields };
  } catch {
    return { ok: false, changedFields: [] };
  }
}
