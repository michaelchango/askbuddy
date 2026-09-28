// 知识类别徽标（M4 知识复利）。
import type { KnowledgeCategory } from "@/lib/schemas/knowledge";

const META: Record<KnowledgeCategory, { label: string; bg: string; text: string }> = {
  rule: { label: "业务规则", bg: "#0ea5e91a", text: "#0ea5e9" },
  term: { label: "术语", bg: "#8b5cf61a", text: "#8b5cf6" },
  decision: { label: "决策", bg: "#f59e0b1a", text: "#d97706" },
  constraint: { label: "约束", bg: "#ef44441a", text: "#ef4444" },
};

export function KnowledgeCategoryBadge({ category }: { category: KnowledgeCategory }) {
  const meta = META[category] ?? META.rule;
  return (
    <span
      className="shrink-0 rounded-[7px] px-[9px] py-[3px] text-[11px] font-medium"
      style={{ backgroundColor: meta.bg, color: meta.text }}
    >
      {meta.label}
    </span>
  );
}
