// 知识条目列表（M4 知识复利）：展示 + 编辑/删除入口 + 未索引徽标。
"use client";

import { Pencil, Trash2, AlertCircle } from "lucide-react";
import type { KnowledgeItem } from "@/lib/schemas/knowledge";
import { KnowledgeCategoryBadge } from "./knowledge-category-badge";
import { relativeTime } from "@/lib/display";

export function KnowledgeList({
  items,
  onEdit,
  onDelete,
}: {
  items: KnowledgeItem[];
  onEdit: (item: KnowledgeItem) => void;
  onDelete: (item: KnowledgeItem) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="mt-[40px] flex flex-col items-center text-center">
        <p className="text-[15.75px] text-[#78746C]">
          还没有沉淀任何知识，点击右上角「新增知识」或「沉淀知识」开始积累。
        </p>
      </div>
    );
  }

  return (
    <div className="mt-[12px] flex flex-col gap-[12px]">
      {items.map((k) => (
        <div
          key={k.id}
          className="group rounded-[13px] border border-[#1111111a] bg-[#F9F8F5] p-[18.8px] transition-all hover:border-[#f6661280] hover:shadow-[0_4px_12px_rgba(246,102,18,0.10)]"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-[8px]">
                <span className="text-[15.75px] font-semibold text-[#111111]">{k.title}</span>
                <KnowledgeCategoryBadge category={k.category} />
                {/* 未索引徽标：embedding 为 null（embedding 尚未计算完成或失败） */}
                {k.embedding == null && (
                  <span className="flex shrink-0 items-center gap-1 rounded-[7px] bg-[#f59e0b1a] px-[9px] py-[3px] text-[11px] font-medium text-[#d97706]">
                    <AlertCircle className="h-3 w-3" />
                    未索引
                  </span>
                )}
              </div>
              <p className="mt-[8px] whitespace-pre-wrap text-[14px] leading-relaxed text-[#554f47] line-clamp-3">
                {k.content}
              </p>
              <div className="mt-[8px] text-[12.5px] text-[#78746C]">
                {relativeTime(k.updated_at)}
                {k.source_type === "decision" && " · 自动沉淀"}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                onClick={() => onEdit(k)}
                aria-label="编辑"
                className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[#78746C] hover:bg-[#1111110a]"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => onDelete(k)}
                aria-label="删除"
                className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[#ef4444] hover:bg-[#ef44441a]"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
