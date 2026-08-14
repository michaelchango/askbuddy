"use client";

import { useState } from "react";
import {
  ClipboardList,
  FileText,
  Search,
  Lightbulb,
  MonitorPlay,
  ScrollText,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import type { OutputMeta, OutputType } from "@/lib/services/outputs";
import type { StepName } from "@/types";
import { cn } from "@/lib/utils";

// 输出物类型 → 步骤名（用于判断该产物是否正在生成）
function stepFromOutput(type: OutputType): StepName | null {
  const map: Partial<Record<OutputType, StepName>> = {
    research_analysis: "research_analysis",
    design: "design",
    prd: "prd_writing",
  };
  return map[type] ?? null;
}

export const ICONS: Record<string, LucideIcon> = {
  card: ClipboardList,
  research_analysis: Search,
  design: Lightbulb,
  solution: FileText,
  prototype: MonitorPlay,
  prd: ScrollText,
};

interface SelectedOutput {
  type: OutputType;
  subType?: string;
}

export function OutputSidebar({
  outputs,
  selected,
  onSelect,
  generatingStep,
  generatingSubType,
}: {
  outputs: OutputMeta[];
  selected: SelectedOutput | null;
  onSelect: (type: OutputType, subType?: string) => void;
  // 持久化/内存态「正在生成的步骤」，用于让生成中的产物立即可点击+高亮（不等落库）
  generatingStep?: StepName | null;
  // design 组当前生成的子产物（"prototype" 表示原型生成中，否则方案文档生成中）
  generatingSubType?: string | null;
}) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    new Set(["design"])
  );

  const toggleGroup = (type: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <aside className="flex w-[252px] shrink-0 flex-col overflow-y-auto border-r border-[#1111111a] bg-[#F4F3EF]">
      <nav className="flex flex-col gap-1 p-[13.5px]">
        {outputs.map((o) => {
          const hasSubs = o.subOutputs && o.subOutputs.length > 0;
          const isGroupExpanded = expandedGroups.has(o.type);
          const active = selected?.type === o.type && !selected?.subType;

        if (hasSubs) {
          // 组标题随「是否存在任意子产物」联动置灰，与顶层普通项保持一致。
          // 若该组对应步骤正在生成，则组标题也视为可用（可展开看到生成中的子产物）。
          const groupGenerating = generatingStep != null && stepFromOutput(o.type) === generatingStep;
          const groupDisabled = !o.exists && !groupGenerating;
          return (
              <div key={o.type}>
                {/* 组标题（可折叠） */}
                <button
                  type="button"
                  disabled={groupDisabled}
                  onClick={() => !groupDisabled && toggleGroup(o.type)}
                  className={cn(
                    "flex h-[45px] w-full items-center gap-[13.5px] rounded-[9px] px-[13.5px] text-left text-[15.75px] transition-colors",
                    groupDisabled
                      ? "cursor-not-allowed font-medium text-[rgba(120,116,108,0.4)]"
                      : active
                        ? "bg-brand/10 font-semibold text-brand"
                        : "font-medium text-[#111111] hover:bg-[#1111110a]"
                  )}
                >
                  <Lightbulb
                    className={cn(
                      "h-[18px] w-[18px] shrink-0",
                      groupDisabled ? "text-[rgba(120,116,108,0.4)]" : active ? "text-brand" : "text-[#1e293b]"
                    )}
                  />
                  <span className="flex-1 truncate">{o.label}</span>
                  {groupGenerating ? (
                    <span className="flex items-center gap-1 text-[11px] font-medium text-brand">
                      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
                      生成中
                    </span>
                  ) : groupDisabled ? (
                    <span className="text-[11px] text-[rgba(120,116,108,0.4)]">未生成</span>
                  ) : (
                    <ChevronDown
                      className={cn(
                        "h-3.5 w-3.5 transition-transform",
                        isGroupExpanded && "rotate-180"
                      )}
                    />
                  )}
                </button>

                {/* 子产物 */}
                {isGroupExpanded && !groupDisabled && (
                  <div className="ml-5 flex flex-col gap-0.5 border-l border-[#1111110d] pl-3">
                    {(o.subOutputs ?? []).map((sub) => {
                      // 子产物「生成中」：design 组下 solution（方案文档）或 prototype（原型）
                      const subGenerating =
                        groupGenerating &&
                        (sub.subType === "prototype"
                          ? generatingSubType === "prototype"
                          : generatingSubType !== "prototype");
                      const disabled = !sub.exists && !subGenerating;
                      const subActive =
                        selected?.type === o.type && selected?.subType === sub.subType;
                      return (
                        <button
                          key={sub.subType}
                          disabled={disabled}
                          onClick={() => !disabled && onSelect(o.type, sub.subType)}
                          className={cn(
                            "flex h-[38px] items-center gap-2 rounded-[7px] px-2.5 text-left text-[14px] transition-colors",
                            disabled
                              ? "cursor-not-allowed text-[rgba(120,116,108,0.4)]"
                              : subActive
                              ? "bg-brand/8 font-semibold text-brand"
                              : "text-[#111111] hover:bg-[#1111110a]"
                          )}
                        >
                          {sub.subType === "prototype" ? (
                            <MonitorPlay
                              className={cn(
                                "h-[15px] w-[15px] shrink-0",
                                disabled ? "text-[rgba(120,116,108,0.4)]" : subActive ? "text-brand" : "text-[#78746C]"
                              )}
                            />
                          ) : (
                            <FileText
                              className={cn(
                                "h-[15px] w-[15px] shrink-0",
                                disabled ? "text-[rgba(120,116,108,0.4)]" : subActive ? "text-brand" : "text-[#78746C]"
                              )}
                            />
                          )}
                          <span className="flex-1 truncate">{sub.label}</span>
                          {subGenerating ? (
                            <span className="flex items-center gap-1 text-[10px] font-medium text-brand">
                              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
                              生成中
                            </span>
                          ) : disabled ? (
                            <span className="text-[10px] text-[rgba(120,116,108,0.4)]">未生成</span>
                          ) : (
                            <span className="font-mono text-[10px] text-[#78746C]">
                              v{sub.version}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }

          // 普通项
          const Icon = ICONS[o.type];
          const generating = generatingStep != null && stepFromOutput(o.type) === generatingStep;
          const disabled = !o.exists && !generating;
          const isActive = selected?.type === o.type && !selected?.subType;
          return (
            <button
              key={o.type}
              disabled={disabled}
              onClick={() => !disabled && onSelect(o.type)}
              className={cn(
                "flex h-[45px] items-center gap-[13.5px] rounded-[9px] px-[13.5px] text-left text-[15.75px] transition-colors",
                disabled
                  ? "cursor-not-allowed text-[rgba(120,116,108,0.4)]"
                  : isActive
                  ? "bg-brand/10 font-semibold text-brand"
                  : "font-medium text-[#111111] hover:bg-[#1111110a]"
              )}
            >
              <Icon
                className={cn(
                  "h-[18px] w-[18px] shrink-0",
                  disabled ? "text-[rgba(120,116,108,0.4)]" : isActive ? "text-brand" : "text-[#1e293b]"
                )}
              />
              <span className="flex-1 truncate">{o.label}</span>
              {generating ? (
                <span className="flex items-center gap-1 text-[11px] font-medium text-brand">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
                  生成中
                </span>
              ) : disabled ? (
                <span className="text-[11px] text-[rgba(120,116,108,0.4)]">未生成</span>
              ) : (
                <span className="font-mono text-[11px] font-semibold text-[#78746C]">
                  v{o.version}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
