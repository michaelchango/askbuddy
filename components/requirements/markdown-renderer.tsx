"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// mermaid 体积较大且仅在渲染 ```mermaid 代码块时才需要，改为动态 import，
// 避免被静态打进需求详情页的首屏客户端包，显著缩短首次进入的 JS 加载 / 解析时间。
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
// 防御性处理：去除 AI 可能在外围包裹的 markdown 代码围栏（```markdown / ```），
// 避免整篇文档被渲染成一个黑色代码块。
function unwrapMarkdownFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("```")) return content;
  const firstLineEnd = trimmed.indexOf("\n");
  if (firstLineEnd === -1) return content;
  const lang = trimmed.slice(3, firstLineEnd).trim().toLowerCase();
  if (lang !== "" && lang !== "markdown" && lang !== "md") return content;
  const lastFence = trimmed.lastIndexOf("```");
  if (lastFence <= firstLineEnd) return content;
  return trimmed.slice(firstLineEnd + 1, lastFence).trim();
}

function ensureMermaid(): Promise<typeof import("mermaid").default> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: "neutral",
        securityLevel: "strict",
        fontFamily: "inherit",
      });
      return m.default;
    });
  }
  return mermaidPromise;
}

function MermaidBlockInner({ code, disabled }: { code: string; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (disabled) return; // 生成中：暂不渲染，避免边生成边重绘导致页面抖动/反复横跳
    let cancelled = false;
    ensureMermaid()
      .then((mermaid) => {
        if (cancelled) return;
        const id = `mmd-${Math.random().toString(36).slice(2)}`;
        return mermaid.render(id, code);
      })
      .then((res) => {
        if (!cancelled && res && ref.current) ref.current.innerHTML = res.svg;
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code, disabled]);

  // 生成中：以固定占位符呈现，不触发异步重渲染，滚动可稳定停在底部
  if (disabled) {
    return (
      <div className="my-3 flex items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 py-6 text-[13px] text-slate-400">
        流程图生成中…
      </div>
    );
  }

  if (error) {
    return (
      <pre className="my-3 overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-[12px] leading-relaxed text-slate-600">
        <code>{code}</code>
      </pre>
    );
  }
  return <div ref={ref} className="my-3 flex justify-center" />;
}

// 内容未变时不重渲染（避免父组件因 outputs/generating 切换而重复解析大文档 + 重复跑 mermaid）
const MermaidBlock = React.memo(MermaidBlockInner);
// 用稳定标记让 pre 组件识别出「子节点已是 MermaidBlock」（React.memo 包装后 .name 不可靠）
const MERMAID_MARKER = Symbol.for("askbuddy-mermaid-block");
(MermaidBlock as unknown as Record<symbol, boolean>)[MERMAID_MARKER] = true;

/**
 * 统一 Markdown 渲染器：react-markdown + remark-gfm。
 * - 支持 GFM 表格、任务列表、删除线、自动链接等。
 * - ```mermaid 代码块渲染为流程图（渲染失败回退为代码块）。
 * - 元素样式自包含，不依赖 @tailwindcss/typography 的 prose。
 */
function MarkdownRendererInner({
  content,
  disableMermaid = false,
}: {
  content: string;
  disableMermaid?: boolean;
}) {
  // 防御性去除外围 markdown 围栏，避免整篇文档被识别为代码块。
  const cleanedContent = useMemo(() => unwrapMarkdownFence(content), [content]);
  // 提取 React 子节点中的纯文本（用于生成 h2 锚点，与后端章节切分逻辑保持一致）
  const nodeText = (node: React.ReactNode): string => {
    if (node == null) return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(nodeText).join("");
    if (typeof node === "object" && "props" in (node as unknown as Record<string, unknown>)) {
      return nodeText((node as { props?: { children?: React.ReactNode } }).props?.children);
    }
    return "";
  };
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => (
          <h1 className="mt-5 mb-2 text-xl font-bold text-slate-900">{children}</h1>
        ),
        h2: ({ children }) => {
          // M3 · 章节级溯源：h2 挂 id + data-source-anchor，正文保持纯净，
          // 溯源经 doc_sections 表 anchor → source 映射（渲染时按锚点查表）。
          const slug = nodeText(children).trim().replace(/\s+/g, "-");
          return (
            <h2
              id={slug}
              data-source-anchor={slug}
              className="mt-5 mb-2 scroll-mt-4 text-lg font-semibold text-slate-900"
            >
              {children}
            </h2>
          );
        },
        h3: ({ children }) => (
          <h3 className="mt-4 mb-1.5 text-base font-semibold text-slate-800">{children}</h3>
        ),
        h4: ({ children }) => (
          <h4 className="mt-3 mb-1 text-sm font-semibold text-slate-800">{children}</h4>
        ),
        h5: ({ children }) => (
          <h5 className="mt-3 mb-1 text-[13px] font-semibold text-slate-800">{children}</h5>
        ),
        h6: ({ children }) => (
          <h6 className="mt-3 mb-1 text-[13px] font-medium text-slate-600">{children}</h6>
        ),
        p: ({ children }) => (
          <p className="my-2 leading-relaxed text-slate-700">{children}</p>
        ),
        ul: ({ children }) => (
          <ul className="my-2 list-disc space-y-1 pl-5 text-slate-700">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="my-2 list-decimal space-y-1 pl-5 text-slate-700">{children}</ol>
        ),
        li: ({ children }) => <li className="pl-0.5">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className="my-3 border-l-4 border-slate-200 pl-3 text-slate-500">
            {children}
          </blockquote>
        ),
        a: ({ children, href }) => (
          <a
            href={href}
            className="text-[#f66612] underline hover:opacity-80"
            target="_blank"
            rel="noreferrer"
          >
            {children}
          </a>
        ),
        strong: ({ children }) => <strong className="font-semibold text-slate-900">{children}</strong>,
        em: ({ children }) => <em>{children}</em>,
        del: ({ children }) => <del className="text-slate-400">{children}</del>,
        hr: () => <hr className="my-4 border-slate-200" />,
        img: ({ src, alt }) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={typeof src === "string" ? src : ""} alt={alt ?? ""} className="my-3 max-w-full rounded-lg" />
        ),
        code({ className, children }) {
          const text = String(children).replace(/\n$/, "");
          const isMermaid = /language-mermaid/.test(className || "");
          if (isMermaid) return <MermaidBlock code={text} disabled={disableMermaid} />;
          // 行内代码：无语言标记且单行；块级代码由 pre 负责深色样式。
          const isInline = !className && !text.includes("\n");
          if (isInline) {
            return (
              <code className="mx-0.5 rounded bg-slate-100 px-1 py-0.5 text-[13px] text-[#d85a10]">
                {children}
              </code>
            );
          }
          return <code className={className}>{children}</code>;
        },
        pre({ children }) {
          const child = Array.isArray(children) ? children[0] : children;
          // 若子节点已是 MermaidBlock（由 code 返回），直接透传，避免被 <pre> 包裹。
          if (
            React.isValidElement(child) &&
            (child.type as unknown as Record<symbol, boolean>)?.[MERMAID_MARKER]
          ) {
            return <>{child}</>;
          }
          return (
            <pre className="my-3 overflow-auto rounded-lg bg-slate-900 p-3 text-[13px] leading-relaxed text-slate-100">
              {children}
            </pre>
          );
        },
        table({ children }) {
          return (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">{children}</table>
            </div>
          );
        },
        thead: ({ children }) => <thead className="bg-slate-50">{children}</thead>,
        th: ({ children }) => (
          <th className="border border-slate-200 px-2 py-1 text-left font-semibold text-slate-700">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-slate-200 px-2 py-1 text-slate-700">{children}</td>
        ),
      }}
    >
      {cleanedContent}
    </Markdown>
  );
}

// 内容未变时不重复解析整篇文档（大 PRD / 方案渲染开销主要在 react-markdown 解析）。
const MarkdownRenderer = React.memo(MarkdownRendererInner);

export default MarkdownRenderer;
