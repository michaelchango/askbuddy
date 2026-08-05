"use client";

import { useState } from "react";
import {
  FileText,
  Search,
  Lightbulb,
  LayoutTemplate,
  FileType,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import type { OutputMeta, OutputType } from "@/lib/services/outputs";
import { cn } from "@/lib/utils";

export const ICONS: Record<string, LucideIcon> = {
  card: FileText,
  research_analysis: Search,
  design: Lightbulb,
  solution: Lightbulb,
  prototype: LayoutTemplate,
  prd: FileType,
};

interface SelectedOutput {
  type: OutputType;
  subType?: string;
}

export function OutputSidebar({
  outputs,
  selected,
  onSelect,
}: {
  outputs: OutputMeta[];
  selected: SelectedOutput | null;
  onSelect: (type: OutputType, subType?: string) => void;
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
          // 组标题随「是否存在任意子产物」联动置灰，与顶层普通项保持一致
          const groupDisabled = !o.exists;
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
                  {groupDisabled ? (
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
                      const disabled = !sub.exists;
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
                            <LayoutTemplate
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
                          {disabled ? (
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
          const disabled = !o.exists;
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
              {disabled ? (
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
