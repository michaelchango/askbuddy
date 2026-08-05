"use client";

import MarkdownRenderer from "./markdown-renderer";

// 统一 Markdown 渲染入口：委托给 MarkdownRenderer（react-markdown + remark-gfm + mermaid）。
// 供 OutputViewer 在「生成中流式内容」与「加载态历史内容」两处复用。
// 保持 export function Markdown 签名不变，调用方无需改动。
export function Markdown({
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
