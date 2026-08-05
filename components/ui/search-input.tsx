"use client";

import { type ReactNode } from "react";

/**
 * 统一的搜索输入框组件。
 *
 * 设计要点（项目内所有文本搜索都应复用本组件，保持视觉与交互一致）：
 * - 左侧内嵌放大镜图标，右侧在输入非空时显示「清空」按钮（圆形悬浮高亮）。
 * - 高度 38px、圆角 9px、聚焦时边框变为品牌橙 #f66612，过渡平滑。
 * - 受控组件：通过 value / onChange 接入父级状态。
 */

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** 额外类名，用于覆盖宽度等布局（默认 w-[220px]）。 */
  className?: string;
  "aria-label"?: string;
}

export function SearchInput({
  value,
  onChange,
  placeholder = "搜索…",
  className = "w-[220px]",
  "aria-label": ariaLabel,
}: SearchInputProps) {
  const clearBtn: ReactNode = value ? (
    <button
      type="button"
      aria-label="清空搜索"
      onClick={() => onChange("")}
      className="absolute right-[10px] top-1/2 flex h-[18px] w-[18px] -translate-y-1/2 items-center justify-center rounded-full text-[#78746C] transition-colors hover:bg-[#F2F0EB] hover:text-[#111111]"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-[13px] w-[13px]"
      >
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    </button>
  ) : null;

  return (
    <div className="relative inline-flex items-center">
      <svg
        className="pointer-events-none absolute left-[13px] top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-[#78746C]"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={
          "h-[38px] rounded-[9px] border border-[#1111111a] bg-white pl-[36px] pr-[36px] text-[14px] text-[#111111] outline-none transition-colors placeholder:text-[#78746C99] focus:border-[#f66612] " +
          className
        }
      />
      {clearBtn}
    </div>
  );
}
