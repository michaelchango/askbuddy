"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import useSWR from "swr";
import { ChevronDown, ChevronRight, Download, RefreshCw, Loader2 } from "lucide-react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import {
  renderMarkdown,
  renderCursorRules,
  renderClaudeMd,
  renderPrompt,
} from "@/lib/services/devcontext-render";
import type { DevContext } from "@/lib/schemas/devcontext";

interface DevContextApiData {
  content: DevContext;
  status: "draft" | "confirmed";
  completeness_score: number;
  applicable_count: number;
  present_count: number;
  version: number;
  updated_at: string;
  hints: string[];
  versions: Array< { version: number; note?: string; createdAt?: string } >;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json()).then((j) => (j.ok ? j.data : null));

/** 与 output-viewer.tsx 同款下载工具（避免跨文件耦合）。 */
function downloadBlob(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 底部折叠面板「开发上下文（供 AI 读取）」。
 * 默认收起；展开后展示完整度评分 / 状态 / 提示，并提供 5 种交付格式的下载菜单。
 *
 * 评分 < 0.7 时给出琥珀色「可实现性偏低」提示条（M2-B7）。
 */
export function DevContextPanel({
  requirementId,
  pending = false,
  onReady,
}: {
  requirementId: string;
  /** PRD 生成后 DevContext 正在后台异步生成时为 true（用于显示「生成中」）。 */
  pending?: boolean;
  /** DevContext 首次出现内容时回调，供父组件清除 pending 态。 */
  onReady?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  // 轮询状态追踪：错误计数（指数退避）+ 起始时间（上限停轮询）。
  const errorCountRef = useRef(0);
  const pollStartRef = useRef<number | null>(null);

  // pending 置真时记录轮询起始时间。
  useEffect(() => {
    if (pending && !pollStartRef.current) pollStartRef.current = Date.now();
  }, [pending]);

  // 动态轮询间隔：
  // - 有内容且非 pending/重新生成 → 停轮询（0）
  // - 无内容超过 5 分钟 → 停轮询（避免无限空转吃连接池）
  // - 否则按错误次数指数退避：5s → 10s → 20s → 30s（封顶）
  const refreshInterval = useCallback(
    (latest: DevContextApiData | null | undefined): number => {
      if (latest?.content && !pending && !regenerating) return 0;
      if (pollStartRef.current && Date.now() - pollStartRef.current > 5 * 60 * 1000) return 0;
      const base = 5000;
      return Math.min(base * Math.pow(2, errorCountRef.current), 30000);
    },
    [pending, regenerating]
  );

  const { data, isLoading, mutate, error } = useSWR<DevContextApiData | null>(
    `/api/requirements/${requirementId}/dev-context`,
    fetcher,
    {
      revalidateOnFocus: false,
      refreshInterval,
      dedupingInterval: 3000, // 3s 内重复 key 不再发请求（配合服务端 5s 缓存双重去重）
      onError: () => { errorCountRef.current += 1; },
      onSuccess: () => { errorCountRef.current = 0; },
    }
  );

  // 轮询命中内容后通知父组件清除「生成中」态，同时重置轮询状态。
  useEffect(() => {
    if (data?.content) {
      errorCountRef.current = 0;
      pollStartRef.current = null;
      if (onReady) onReady();
    }
  }, [data?.content, onReady]);

  const hasContent = !!data?.content;
  const score = data?.completeness_score ?? 0;
  const isLow = hasContent && score < 0.7;

  async function regenerate() {
    setRegenerating(true);
    try {
      await fetch(`/api/requirements/${requirementId}/dev-context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: "manual" }),
      });
      await mutate();
    } finally {
      setRegenerating(false);
    }
  }

  function buildExportItems() {
    if (!data?.content) {
      return [
        { label: "Markdown (.md)", disabled: true, onSelect: () => {} },
        { label: "CLAUDE.md", disabled: true, onSelect: () => {} },
        { label: ".cursorrules", disabled: true, onSelect: () => {} },
        { label: "结构化 Prompt (.txt)", disabled: true, onSelect: () => {} },
        { label: "JSON (.json)", disabled: true, onSelect: () => {} },
      ];
    }
    const ctx = data.content;
    const base = `devcontext-v${data.version ?? 1}`;
    return [
      { label: "Markdown (.md)", onSelect: () => downloadBlob(`${base}.md`, renderMarkdown(ctx), "text/markdown") },
      { label: "CLAUDE.md", onSelect: () => downloadBlob("CLAUDE.md", renderClaudeMd(ctx), "text/markdown") },
      { label: ".cursorrules", onSelect: () => downloadBlob(".cursorrules", renderCursorRules(ctx), "text/plain") },
      { label: "结构化 Prompt (.txt)", onSelect: () => downloadBlob(`${base}-prompt.txt`, renderPrompt(ctx), "text/plain") },
      { label: "JSON (.json)", onSelect: () => downloadBlob(`${base}.json`, JSON.stringify(ctx, null, 2), "application/json") },
    ];
  }

  return (
    <div className="shrink-0 border-t border-[#1111111a] bg-white">
      {/* 折叠头 */}
      <div className="flex items-center justify-between px-4 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-[13.5px] font-semibold text-[#111111]"
        >
          {open ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
          开发上下文（供 AI 读取）
          {pending ? (
            <span className="ml-1 flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-500">
              <Loader2 className="h-3 w-3 animate-spin" /> 生成中…
            </span>
          ) : hasContent ? (
            <span
              className={`ml-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                score >= 0.7
                  ? "bg-emerald-50 text-emerald-600"
                  : "bg-amber-50 text-amber-600"
              }`}
            >
              已完成 · {Math.round(score * 100)}%
            </span>
          ) : (
            <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-400">
              未生成
            </span>
          )}
        </button>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={regenerate}
            disabled={regenerating}
            title="重新生成 DevContext"
            className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-slate-500 transition-colors hover:bg-[#F2F0EB] hover:text-slate-700 disabled:opacity-40"
          >
            {regenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            重新生成
          </button>
          <DropdownMenu
            icon={<Download className="h-4 w-4" />}
            ariaLabel="导出开发上下文"
            width={180}
            items={buildExportItems()}
          />
        </div>
      </div>

      {/* 展开内容 */}
      {open && (
        <div className="space-y-3 px-4 pb-4">
          {!hasContent ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-[13px] text-slate-400">
              尚无开发上下文。生成「需求文档」后会自动产出，或点击右上角「重新生成」。
            </div>
          ) : (
            <>
              {isLow && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-700">
                  ⚠️ 可实现性评分偏低（{Math.round(score * 100)}%），部分内容 section 缺失或未通过一致性校验，
                  建议补充上游产物或重新生成后再交由 AI 编码工具消费。
                </div>
              )}
              <div className="grid grid-cols-3 gap-2 text-[12px]">
                <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                  <div className="text-slate-400">完整度</div>
                  <div className="text-[15px] font-semibold text-[#111111]">{Math.round(score * 100)}%</div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                  <div className="text-slate-400">覆盖 section</div>
                  <div className="text-[15px] font-semibold text-[#111111]">
                    {data?.present_count ?? 0}/{data?.applicable_count ?? 0}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                  <div className="text-slate-400">版本</div>
                  <div className="text-[15px] font-semibold text-[#111111]">v{data?.version ?? 1}</div>
                </div>
              </div>
              {data?.hints && data.hints.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {data.hints.map((h, i) => (
                    <span
                      key={i}
                      className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500"
                    >
                      {h}
                    </span>
                  ))}
                </div>
              )}
              <div className="text-[11.5px] leading-relaxed text-slate-400">
                机器读产物：AI 编码工具（Cursor / Claude Code）可通过 AskBuddy MCP 的
                <code className="mx-0.5 rounded bg-slate-100 px-1">requirement_dev_context</code>
                等工具直接消费本 JSON，无需复制粘贴。
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
