// 知识条目表单弹窗（新增/编辑，M4 知识复利）。
"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { KnowledgeCategory, KnowledgeItem } from "@/lib/schemas/knowledge";
import { CategoryLabel } from "@/lib/schemas/knowledge";

const CATEGORIES: KnowledgeCategory[] = ["rule", "term", "decision", "constraint"];

export function KnowledgeFormDialog({
  open,
  projectId,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  projectId: string;
  editing: KnowledgeItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<KnowledgeCategory>("rule");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setTitle(editing?.title ?? "");
      setContent(editing?.content ?? "");
      setCategory(editing?.category ?? "rule");
      setError("");
    }
  }, [open, editing]);

  if (!open) return null;

  async function handleSubmit() {
    if (saving) return;
    if (!title.trim() || !content.trim()) {
      setError("标题与内容不能为空");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const url = editing
        ? `/api/projects/${projectId}/knowledge/${editing.id}`
        : `/api/projects/${projectId}/knowledge`;
      const method = editing ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { title, content, category } : { title, content, category }),
      });
      const d = await res.json();
      if (!d.ok) {
        setError(d.message ?? "保存失败");
        return;
      }
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden />
      <div className="relative w-[560px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[16px] bg-white shadow-[0_24px_64px_rgba(0,0,0,0.22)]">
        <div className="flex items-center justify-between border-b border-[#1111111a] px-6 py-4">
          <h2 className="text-[18px] font-semibold text-[#111111]">
            {editing ? "编辑知识" : "新增知识"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-[8px] text-[#78746C] hover:bg-[#F2F0EB]"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5">
          <label className="flex flex-col gap-2">
            <span className="text-[13.5px] font-medium text-[#111111]">标题</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="如：结算金额取两位小数"
              className="h-[42px] rounded-[10px] border border-[#1111111a] px-3 text-[15px] text-[#111111] outline-none focus:border-[#f66612]"
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-[13.5px] font-medium text-[#111111]">类别</span>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={
                    "rounded-[8px] px-3 py-1.5 text-[13px] font-medium transition-colors " +
                    (category === c
                      ? "bg-[#f6661219] text-[#f66612]"
                      : "bg-[#F2F0EB] text-[#78746C] hover:bg-[#e9e6df]")
                  }
                >
                  {CategoryLabel[c]}
                </button>
              ))}
            </div>
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-[13.5px] font-medium text-[#111111]">内容</span>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="描述这条知识，供 AI 在后续需求中复用…"
              rows={6}
              className="resize-none rounded-[10px] border border-[#1111111a] px-3 py-2.5 text-[15px] leading-relaxed text-[#111111] outline-none focus:border-[#f66612]"
            />
          </label>

          {error && <p className="text-[13px] text-[#ef4444]">{error}</p>}
        </div>

        <div className="flex justify-end gap-3 border-t border-[#1111111a] px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="h-[42px] rounded-[10px] px-4 text-[15px] font-medium text-[#78746C] hover:bg-[#F2F0EB]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving}
            className="flex h-[42px] items-center gap-2 rounded-[10px] bg-brand px-5 text-[15px] font-semibold text-white transition-colors hover:bg-brand/90 disabled:opacity-70"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
