// 上下文预算裁剪（M4 知识复利）：把注入 prompt 的知识段控制在预算内。
//
// 【R1 风险防线】知识检索结果直接注入 prompt 会占用上下文窗口，可能挤占
// 上游产物 / 历史对话。这里按优先级裁剪，知识段最先被裁。
//
// 优先级：card > upstream > existingDoc > history > knowledge（知识最先裁）。

/** 知识段总预算（字符）。 */
export const KNOWLEDGE_BUDGET = 12_000;

/** 单条知识内容截断上限（字符）。 */
export const SINGLE_KNOWLEDGE_LIMIT = 2_000;

export interface KnowledgeBudgetItem {
  title: string;
  content: string;
  category?: string;
  score?: number;
}

/**
 * 按预算裁剪知识段列表，返回可注入 prompt 的文本与命中的知识标题集合。
 * 超预算时逐条截断，直到整体 ≤ budget。
 */
export function buildKnowledgeBlock(
  items: KnowledgeBudgetItem[],
  budget = KNOWLEDGE_BUDGET
): { block: string; titles: string[] } {
  if (!items || items.length === 0) return { block: "", titles: [] };

  const sections: string[] = [];
  const titles: string[] = [];
  let used = 0;

  for (const item of items) {
    if (used >= budget) break;
    const remaining = budget - used;
    const title = (item.title ?? "").trim();
    let content = (item.content ?? "").trim();
    if (!title || !content) continue;

    // 标题 + 类别标签 + 内容，整体不得超过剩余预算。
    const label = item.category ? `【${item.category}】` : "";
    const head = `${label}${title}`;
    const headLen = head.length + 3; // 换行等分隔
    let contentLimit = Math.min(SINGLE_KNOWLEDGE_LIMIT, remaining - headLen);
    if (contentLimit <= 0) break;

    if (content.length > contentLimit) {
      content = content.slice(0, contentLimit) + "…";
    }

    const section = `${head}\n${content}`;
    sections.push(section);
    titles.push(title);
    used += section.length + 2;
  }

  if (sections.length === 0) return { block: "", titles: [] };
  return { block: sections.join("\n\n"), titles };
}
