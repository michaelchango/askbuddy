"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Download, ArrowLeft, PanelRightClose, Loader2 } from "lucide-react";
import { api } from "@/lib/api/client";
import { extractResearchAnalysis } from "@/lib/ai/parse";
import { buildResearchAnalysisMarkdown } from "@/lib/render/research-analysis";
import MarkdownRenderer from "./markdown-renderer";
import { ICONS } from "./output-sidebar";
import type { OutputContent, OutputType } from "@/lib/services/outputs";

// 原 components/requirements/markdown.tsx 只是给 MarkdownRenderer 套一层排版容器，
// 且仅本文件使用，M0 已内联至此并删除该中转文件（少一层无意义的间接跳转）。
function Markdown({
  content,
  disableMermaid = false,
}: {
  content: string;
  disableMermaid?: boolean;
}) {
  return (
    <div className="text-[14px] text-slate-700">
      <MarkdownRenderer content={content} disableMermaid={disableMermaid} />
    </div>
  );
}

const CARD_FIELDS: { key: string; label: string }[] = [
  { key: "background", label: "背景" },
  { key: "targetUsers", label: "目标用户" },
  { key: "painPoints", label: "核心痛点" },
  { key: "scope", label: "功能范围" },
  { key: "nonFunctional", label: "非功能需求" },
  { key: "constraints", label: "约束" },
];

function downloadBlob(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function OutputViewer({
  requirementId,
  outputType,
  subType,
  expanded,
  onToggleExpand,
  onClose,
  generating,
  liveContent,
  liveHtml,
}: {
  requirementId: string;
  outputType: OutputType;
  subType?: string;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
  generating?: boolean;
  liveContent?: string;
  liveHtml?: string;
}) {
  const [version, setVersion] = useState<number | null>(null);

  const urlBase = `/api/requirements/${requirementId}/outputs/${outputType}`;
  const url = [
    urlBase,
    subType ? `?subType=${subType}` : "",
    version != null ? `${subType ? "&" : "?"}version=${version}` : "",
  ].join("");

  const { data, isLoading, isValidating, mutate: refreshOutput } = useSWR<OutputContent>(
    url,
    (u: string) => api<OutputContent>(u)
  );

  // 切换到新输出物时重置为最新版本
  useEffect(() => {
    setVersion(null);
  }, [outputType]);

  // 滚动容器引用
  const scrollRef = useRef<HTMLDivElement>(null);

  // 生成过程中自动滚动到底部，保持可见最新内容
  useEffect(() => {
    if (generating && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [liveContent, generating]);

  // 调研分析生成中：把流式原文末尾的 ```json 结构化数据剥离并实时渲染为条目列表，
  // 使其与其他段落一样所见即所得，避免出现黑底代码块。未闭合的 ```json 先补闭合再解析，
  // JSON 不完整时暂仅显示报告正文，随流式进度渐进出现。
  const liveMarkdown = useMemo(() => {
    if (outputType !== "research_analysis" || !liveContent) return liveContent ?? "";
    let fixed = liveContent;
    if (!/```json[\s\S]*?```/i.test(liveContent)) {
      const openIdx = liveContent.lastIndexOf("```json");
      if (openIdx !== -1) {
        const inner = liveContent.slice(openIdx + "```json".length).trim();
        fixed = liveContent.slice(0, openIdx) + "```json\n" + inner + "\n```";
      }
    }
    try {
      const parsed = extractResearchAnalysis(fixed);
      return buildResearchAnalysisMarkdown(parsed);
    } catch {
      return liveContent;
    }
  }, [outputType, liveContent]);

  // 生成刚结束时（generating 从 true → false）重新拉取内容
  const wasGenerating = useRef(false);
  const justEndedRef = useRef(false);
  useEffect(() => {
    if (wasGenerating.current && !generating) {
      // 生成结束 → 标记"刚结束"并强制重新拉取最新内容
      justEndedRef.current = true;
      refreshOutput();
    }
    wasGenerating.current = !!generating;
  }, [generating, refreshOutput]);

  // 仅"生成刚结束"时：内容重新拉取（isValidating 结束）并等待 mermaid 渲染后，
  // 再滚动到底部，确保用户看到文档最末端。手动切换文档/版本不会触发此逻辑。
  useEffect(() => {
    if (justEndedRef.current && !generating && !isValidating && data && scrollRef.current) {
      justEndedRef.current = false;
      const t = setTimeout(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      }, 350);
      return () => clearTimeout(t);
    }
  }, [generating, isValidating, data]);

  // 非生成态下切换文档（outputType/subType）或版本（version）时，回到顶部
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (generating || !scrollRef.current) return;
    scrollRef.current.scrollTop = 0;
  }, [outputType, subType, version]);

  const versions = data?.versions ?? [];
  const current = version ?? data?.version ?? null;
  const idx = versions.findIndex((v) => v.version === current);
  const canPrev = idx > 0;
  const canNext = idx >= 0 && idx < versions.length - 1;

  const TitleIcon = ICONS[outputType];

  function goPrev() {
    if (idx > 0) setVersion(versions[idx - 1].version);
  }
  function goNext() {
    if (idx >= 0 && idx < versions.length - 1) setVersion(versions[idx + 1].version);
  }

  function handleDownload() {
    if (!data) return;
    const name = `${outputType}-v${current ?? 1}`;
    if (data.contentType === "card") {
      downloadBlob(`${name}.json`, JSON.stringify(data.card ?? {}, null, 2), "application/json");
    } else if (data.contentType === "html") {
      downloadBlob(`${name}.html`, data.content ?? "", "text/html");
    } else {
      downloadBlob(`${name}.md`, data.content ?? "", "text/markdown");
    }
  }

  return (
    <div className="flex h-full flex-col bg-white">
      {/* 顶栏：左=收起+标题，中=返回对话(仅展开态)，右=展开/下载 */}
      <div className="grid h-[52px] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-[#1111111a] bg-white px-3">
        {/* 左：收起按钮 + 标题(带 icon) + 版本徽标 + 版本切换 */}
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            onClick={onClose}
            title="收起侧边栏"
            aria-label="收起侧边栏"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-[#F2F0EB] hover:text-slate-700"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
          <TitleIcon className="h-4 w-4 shrink-0 text-brand" />
          <span className="truncate text-[14px] font-semibold text-brand">
            {data?.label ?? outputType}
          </span>
        </div>

        {/* 中：版本号(居中) + 返回对话(仅展开态)，版本号多版本/单版本位置一致且不挤压标题 */}
        <div className="flex items-center justify-center gap-2">
          {current != null && versions.length > 1 ? (
            <div className="flex shrink-0 items-center gap-1">
              <button
                onClick={goPrev}
                disabled={!canPrev}
                className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                title="上一个版本"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <select
                value={current}
                onChange={(e) => setVersion(Number(e.target.value))}
                className="h-6 rounded border border-[#1111111a] bg-[#F2F0EB] px-1.5 font-mono text-[11px] font-semibold text-[#78746C] focus:outline-none focus:ring-1 focus:ring-brand/30"
              >
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}{v.note ? ` - ${v.note}` : ""}
                  </option>
                ))}
              </select>
              <button
                onClick={goNext}
                disabled={!canNext}
                className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                title="下一个版本"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          ) : current != null ? (
            <span className="shrink-0 rounded bg-[#F2F0EB] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[#78746C]">
              v{current}
            </span>
          ) : null}
          {expanded && (
            <button
              onClick={onClose}
              className="flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-[#e2570c]"
            >
              <ArrowLeft className="h-4 w-4" /> 返回对话
            </button>
          )}
        </div>

        {/* 右：展开 / 下载（顺序已互换） */}
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={onToggleExpand}
            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-[#F2F0EB] hover:text-slate-700"
            title={expanded ? "收起" : "展开"}
          >
            {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            onClick={handleDownload}
            disabled={!data || (data.contentType !== "card" && !data.content)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-[#F2F0EB] hover:text-slate-700 disabled:opacity-30"
            title="下载"
          >
            <Download className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 内容 */}
      <div ref={scrollRef} className="flex-1 overflow-auto bg-slate-50 p-5">
        {/* 生成中：实时流式内容 */}
        {generating && (
          <div>
            <div className="mb-3 flex items-center gap-2 text-[13px] font-medium text-[#4F39F6]">
              <Loader2 className="h-4 w-4 animate-spin" />
              AI 正在生成…
            </div>
            {liveHtml ? (
              <iframe
                title="preview"
                sandbox="allow-scripts allow-forms allow-popups allow-modals"
                className="h-full min-h-[520px] w-full rounded-lg border border-slate-200 bg-white"
                srcDoc={liveHtml}
              />
            ) : liveContent ? (
              <div className="mx-auto max-w-3xl rounded-lg border border-slate-200 bg-white p-6">
                {/* 生成中禁用 mermaid 实时重绘：避免流程图边生成边重绘导致反复横跳 */}
                {/* 调研分析：使用已剥离 json 围栏、按最终格式渲染的 liveMarkdown，避免黑底代码块 */}
                <Markdown content={outputType === "research_analysis" ? liveMarkdown : liveContent} disableMermaid />
              </div>
            ) : null}
          </div>
        )}

        {/* 非生成态：从 API 加载内容 */}
        {!generating && isLoading && <div className="text-sm text-slate-400">加载中…</div>}
        {!generating && !isLoading && data && (
          <>
            {data.contentType === "card" && (
              <div className="space-y-3">
                {CARD_FIELDS.map((f) => {
                  const val = (data.card?.[f.key] as string) ?? "";
                  return (
                    <div key={f.key} className="rounded-lg border border-slate-200 bg-white p-3">
                      <div className="mb-1 text-xs font-medium text-slate-500">{f.label}</div>
                      <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
                        {val || <span className="text-slate-300">（未填写）</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {data.contentType === "html" && (
              <iframe
                title="preview"
                sandbox="allow-scripts allow-forms allow-popups allow-modals"
                className="h-full min-h-[520px] w-full rounded-lg border border-slate-200 bg-white"
                srcDoc={data.content ?? ""}
              />
            )}
            {data.contentType === "markdown" && (
              <div className="mx-auto max-w-3xl rounded-lg border border-slate-200 bg-white p-6">
                {data.content ? (
                  <Markdown content={data.content} />
                ) : (
                  <div className="text-sm text-slate-400">暂无内容</div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
