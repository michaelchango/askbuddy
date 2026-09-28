// 知识段渲染（M4 知识复利）：把检索到的知识注入 prompt，并附硬指令。
import type { KnowledgeRef } from "@/lib/schemas/knowledge";
import { buildKnowledgeBlock } from "../context/budget";

const CATEGORY_LABEL: Record<string, string> = {
  rule: "业务规则",
  term: "术语",
  decision: "决策",
  constraint: "约束",
};

/** 把 KnowledgeRef[] 渲染成可拼进 buildUser 的「知识段」文本。空则返回 ""。 */
export function renderKnowledgeBlock(knowledge?: KnowledgeRef[]): string {
  if (!knowledge || knowledge.length === 0) return "";
  const { block } = buildKnowledgeBlock(
    knowledge.map((k) => ({
      title: k.title,
      content: k.content,
      category: CATEGORY_LABEL[k.category] ?? k.category,
      score: k.score,
    }))
  );
  if (!block) return "";
  return (
    "【项目知识（历史沉淀，请优先遵循，冲突时以知识为准）】\n" +
    block
  );
}

/** 系统指令里追加的「知识优先」硬指令（注入到各 prompt 的 system）。 */
export const KNOWLEDGE_SYSTEM_DIRECTIVE =
  "若提供【项目知识】，其中确立的业务规则/术语/决策/约束具有跨需求约束力，" +
  "生成内容必须与之保持一致，不得与其冲突；必要时在正文中显式引用。";
