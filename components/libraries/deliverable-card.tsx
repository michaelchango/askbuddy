"use client";

import { useState } from "react";
import Link from "next/link";
import type { LibraryItem, LibraryType } from "@/lib/services/library";
import { relativeTime, requirementStatusMeta } from "@/lib/display";
import MarkdownRenderer from "@/components/requirements/markdown-renderer";

const TYPE_LABELS: Record<LibraryType, string> = {
  research: "调研分析",
  solution: "方案文档",
  prototype: "交互原型",
  prd: "需求文档",
};

const TYPE_ICONS: Record<LibraryType, string> = {
  research: "🔍",
  solution: "📐",
  prototype: "🎨",
  prd: "📄",
};

interface DeliverableCardProps {
  item: LibraryItem;
  libraryType: LibraryType;
}

export function DeliverableCard({ item, libraryType }: DeliverableCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contentType, setContentType] = useState<"markdown" | "html" | null>(null);

  const statusMeta = requirementStatusMeta(
    item.requirementStatus as Parameters<typeof requirementStatusMeta>[0]
  );

  async function toggleExpand() {
    if (expanded) {
      setExpanded(false);
      return;
    }

    setExpanded(true);

    // 如果已经加载过内容，直接展示
    if (content != null) return;

    setLoading(true);
    setError(null);

    try {
      const { apiUrl, responseType } = getPreviewParams(item.requirementId, libraryType);
      const res = await fetch(apiUrl);
      const d = await res.json();

      if (!d.ok) {
        setError(d.error ?? "加载失败");
        setLoading(false);
        return;
      }

      const data = d.data;
      setContentType(responseType);

      if (responseType === "html") {
        // 原型：HTML 内容
        setContent(data.content ?? data.html ?? "");
      } else {
        // 调研/方案/文档：Markdown 内容
        setContent(data.content ?? "");
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-[12px] border border-[#1111111a] bg-white transition-shadow hover:shadow-sm">
      {/* 卡片头部（可点击展开） */}
      <button
        type="button"
        onClick={toggleExpand}
        className="flex w-full items-center gap-[13px] p-[18px] text-left"
      >
        {/* 类型图标 */}
        <span className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[10px] bg-[#f6661214] text-[18px]">
          {TYPE_ICONS[libraryType]}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15.75px] font-semibold text-[#111111]">
              {item.requirementTitle}
            </span>
            <span
              className="shrink-0 rounded-[4px] px-[6px] py-[1px] text-[11px] font-medium"
              style={{
                backgroundColor: statusMeta.bg,
                color: statusMeta.text,
              }}
            >
              {statusMeta.label}
            </span>
          </div>
          <div className="mt-[2px] flex items-center gap-2 text-[12px] text-[#78746C]">
            <span className="rounded-full bg-[#f6661214] px-[8px] py-[1px] text-[11px] font-semibold text-[#f66612]">
              v{item.version}
            </span>
            <span>{relativeTime(item.updatedAt)}</span>
            <span className="text-[#1111111a]">|</span>
            <Link
              href={`/dashboard/projects/.../requirements/${item.requirementId}`}
              onClick={(e) => e.stopPropagation()}
              className="text-[#f66612] underline-offset-2 hover:underline"
            >
              {TYPE_LABELS[libraryType]}
            </Link>
          </div>
        </div>

        {/* 展开/折叠指示器 */}
        <div className="shrink-0 text-[#78746C]">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`h-[18px] w-[18px] transition-transform ${expanded ? "rotate-180" : ""}`}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
      </button>

      {/* 展开的预览区 */}
      {expanded && (
        <div className="border-t border-[#1111110d]">
          {loading && (
            <div className="flex items-center justify-center py-[40px]">
              <div className="flex items-center gap-2 text-[13px] text-[#78746C]">
                <svg
                  className="h-[18px] w-[18px] animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="3"
                    className="opacity-25"
                  />
                  <path
                    d="M4 12a8 8 0 018-8"
                    stroke="#f66612"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                </svg>
                加载预览中…
              </div>
            </div>
          )}

          {error && (
            <div className="px-[18px] py-[18px] text-[13px] text-red-500">
              {error}
            </div>
          )}

          {content != null && !loading && !error && (
            <div className="px-[18px] pb-[18px] pt-[12px]">
              {contentType === "html" ? (
                <iframe
                  sandbox="allow-scripts allow-forms allow-popups allow-modals"
                  title={`原型预览 v${item.version}`}
                  className="min-h-[420px] w-full rounded-[8px] border border-[#1111111a] bg-white"
                  srcDoc={content}
                />
              ) : (
                <div className="max-h-[600px] overflow-y-auto rounded-[8px] border border-[#1111111a] bg-[#fafaf8] px-[16px] py-[12px]">
                  {content ? (
                    <MarkdownRenderer content={content} />
                  ) : (
                    <p className="text-[13px] text-[#78746C]">暂无内容</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 根据库类型确定预览 API 路径与返回内容类型 */
function getPreviewParams(
  requirementId: string,
  libraryType: LibraryType
): { apiUrl: string; responseType: "markdown" | "html" } {
  switch (libraryType) {
    case "research":
      return {
        apiUrl: `/api/requirements/${requirementId}/outputs/research_analysis`,
        responseType: "markdown",
      };
    case "solution":
      return {
        apiUrl: `/api/requirements/${requirementId}/outputs/design?subType=solution`,
        responseType: "markdown",
      };
    case "prototype":
      return {
        apiUrl: `/api/requirements/${requirementId}/outputs/design?subType=prototype`,
        responseType: "html",
      };
    case "prd":
      return {
        apiUrl: `/api/requirements/${requirementId}/outputs/prd`,
        responseType: "markdown",
      };
  }
}
