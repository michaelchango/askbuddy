// 卡片合并 mock 夹具（M5-D3）。
//
// 关键设计：**回显现有卡片 + 只动 constraints**。
// 这样 `applyCardChange` 算出的字段级 diff 恰好是 `["constraints"]`——
// e2e「改卡片 constraints → 只有 business_rules 链路段被标过期」需要这个确定性，
// 若 mock 顺手补齐/润色其它字段，diff 就会变成多个字段，映射表断言随之失真。

import { hashTag } from "../hash";

const CARD_KEYS = [
  "background",
  "targetUsers",
  "painPoints",
  "scope",
  "nonFunctional",
  "constraints",
] as const;

/** 从 user 消息里取出【现有需求卡片】那段 JSON（到下一个【 标记为止）。 */
export function parseExistingCard(userContent: string): Record<string, string> | null {
  const start = userContent.indexOf("【现有需求卡片】");
  if (start < 0) return null;
  const rest = userContent.slice(start + "【现有需求卡片】".length);
  const end = rest.indexOf("【");
  const raw = (end >= 0 ? rest.slice(0, end) : rest).trim();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const k of CARD_KEYS) {
      out[k] = typeof parsed[k] === "string" ? (parsed[k] as string) : "";
    }
    return out;
  } catch {
    return null;
  }
}

export function cardMergeFixture(userContent: string, scenario: string): string {
  const existing = parseExistingCard(userContent) ?? {
    background: "",
    targetUsers: "",
    painPoints: "",
    scope: "",
    nonFunctional: "",
    constraints: "",
  };
  const tag = hashTag(userContent);
  const merged: Record<string, string> = { ...existing };
  // 空字段仍然留空：`applyCardChange` 会跳过空值，保证 diff 只有 constraints
  if (merged.constraints) merged.constraints = `${merged.constraints}〔mock-${tag}〕`;
  else merged.constraints = `（示例）新增约束〔mock-${tag}〕`;

  if (scenario === "card-multiple") {
    merged.scope = merged.scope
      ? `${merged.scope}〔mock-${tag}〕`
      : `（示例）新增范围〔mock-${tag}〕`;
  }

  return "```json\n" + JSON.stringify(merged, null, 2) + "\n```";
}
