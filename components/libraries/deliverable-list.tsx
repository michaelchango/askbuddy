"use client";

import { useMemo, useState } from "react";
import type { Requirement } from "@/types";
import type { LibraryItem, LibraryType } from "@/lib/services/library";
import { LibraryFilter, type LibraryFilterValues } from "./library-filter";
import { DeliverableCard } from "./deliverable-card";

const EMPTY_MESSAGES: Record<LibraryType, string> = {
  research: "该项目下暂无调研产出。完成需求的调研分析后，报告将自动汇总于此。",
  solution: "该项目下暂无方案产出。完成需求的方案设计后，方案文档将自动汇总于此。",
  prototype: "该项目下暂无原型产出。完成需求的原型生成后，交互原型将自动汇总于此。",
  prd: "该项目下暂无文档产出。完成需求的 PRD 编写后，需求文档将自动汇总于此。",
};

const EMPTY_ICONS: Record<LibraryType, string> = {
  research: "🔍",
  solution: "📐",
  prototype: "🎨",
  prd: "📄",
};

interface DeliverableListProps {
  items: LibraryItem[];
  requirements: Requirement[];
  libraryType: LibraryType;
  isLoading: boolean;
}

/** 骨架卡片占位 */
function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-[12px] border border-[#1111110d] bg-white p-[18px]">
      <div className="flex items-center gap-[13px]">
        <div className="h-[40px] w-[40px] rounded-[10px] bg-[#F2F0EB]" />
        <div className="flex-1 space-y-2">
          <div className="h-[18px] w-[220px] rounded bg-[#F2F0EB]" />
          <div className="h-[14px] w-[160px] rounded bg-[#F2F0EB]" />
        </div>
      </div>
    </div>
  );
}

export function DeliverableList({
  items,
  requirements,
  libraryType,
  isLoading,
}: DeliverableListProps) {
  const [filter, setFilter] = useState<LibraryFilterValues>({
    requirementId: "",
  });

  // 前端筛选
  const filtered = useMemo(() => {
    return items.filter((item) => {
      // 需求筛选
      if (filter.requirementId && item.requirementId !== filter.requirementId) {
        return false;
      }
      return true;
    });
  }, [items, filter]);

  // 加载态
  if (isLoading) {
    return (
      <div className="mt-6 space-y-3">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  // 空数据（整个库无产出物）
  if (items.length === 0) {
    return (
      <div className="mt-[72px] flex flex-col items-center text-center">
        <div className="flex h-[88px] w-[88px] items-center justify-center rounded-[28px] bg-[#f6661214] text-[36px]">
          {EMPTY_ICONS[libraryType]}
        </div>
        <h2 className="mt-6 text-[19px] font-bold text-[#111111]">暂无产出</h2>
        <p className="mt-2 max-w-[420px] text-[14.4px] leading-relaxed text-[#78746C]">
          {EMPTY_MESSAGES[libraryType]}
        </p>
      </div>
    );
  }

  return (
    <>
      {/* 筛选栏 */}
      <div className="mt-[24px]">
        <LibraryFilter requirements={requirements} onChange={setFilter} />
      </div>

      {/* 列表 */}
      <div className="mt-5 space-y-3">
        {filtered.length === 0 ? (
          <p className="py-[40px] text-center text-[14px] text-[#78746C]">
            没有匹配的产出物
          </p>
        ) : (
          filtered.map((item) => (
            <DeliverableCard
              key={`${libraryType}-${item.requirementId}`}
              item={item}
              libraryType={libraryType}
            />
          ))
        )}
      </div>
    </>
  );
}
