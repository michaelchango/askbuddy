"use client";

import { useState } from "react";
import { Check, Pencil, X, Loader2, Layers } from "lucide-react";
import { EVT } from "@/lib/events";

export type SuggestionStatus = "pending" | "accepted" | "edited" | "ignored";

export interface SuggestionView {
  id: string;
  requirement_id: string;
  target_type: "research" | "solution" | "prototype" | "prd" | "dev_context";
  target_path: string | null;
  op: "add" | "modify" | "remove";
  payload: Record<string, unknown>;
  status: SuggestionStatus;
  source?: { conversation_turn?: number | null } | null;
}

const TARGET_LABEL: Record<SuggestionView["target_type"], string> = {
  research: "调研报告",
  solution: "方案文档",
  prototype: "交互原型",
  prd: "需求文档",
  dev_context: "开发上下文",
};

const STATUS_META: Record<SuggestionStatus, { label: string; cls: string }> = {
  pending: { label: "待确认", cls: "bg-amber-50 text-amber-600" },
  accepted: { label: "已接受", cls: "bg-emerald-50 text-emerald-600" },
  edited: { label: "已编辑", cls: "bg-emerald-50 text-emerald-600" },
  ignored: { label: "已忽略", cls: "bg-slate-100 text-slate-400" },
};

function previewText(s: SuggestionView): string {
  const p = s.payload ?? {};
  if (s.target_type === "research") {
    const r = typeof p.report === "string" ? p.report : "";
    return r.slice(0, 160) || "（空报告）";
  }
  if (s.target_type === "solution") {
    const d = typeof p.doc === "string" ? p.doc : "";
    return d.slice(0, 160) || "（空文档）";
  }
  if (s.target_type === "prd") {
    const m = typeof p.markdown === "string" ? p.markdown : "";
    return m.slice(0, 160) || "（空文档）";
  }
  if (s.target_type === "prototype") {
    const pages = Array.isArray((p.structure as { pages?: unknown[] })?.pages)
      ? ((p.structure as { pages: unknown[] }).pages.length)
      : 0;
    return `交互原型 · ${pages} 个页面`;
  }
  return TARGET_LABEL[s.target_type];
}

export interface RespondData {
  action: "accept" | "edit" | "ignore";
  targetType: SuggestionView["target_type"];
  version: number | null;
  stageResolved: boolean;
  step: string;
  proceedPrompt: {
    step: string;
    nextStep: string | null;
    subPhase?: string;
    canSkip: boolean;
    message: string;
    version: number | null;
  } | null;
}

export function ProposalCard({
  requirementId,
  suggestion,
  onResolved,
}: {
  requirementId: string;
  suggestion: SuggestionView;
  onResolved?: (data: RespondData) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = STATUS_META[suggestion.status];

  async function respond(decision: "accept" | "edit" | "ignore", editedPayload?: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/requirements/${requirementId}/proposals/${suggestion.id}/respond`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision, editedPayload }),
        }
      );
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "响应失败");
      onResolved?.(json.data as RespondData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "响应失败");
    } finally {
      setBusy(false);
      setEditing(false);
    }
  }

  function startEdit() {
    // 预填当前 payload 的可编辑文本（MD / 报告类取正文，原型类无内联编辑）
    const p = suggestion.payload ?? {};
    let initial = "";
    if (suggestion.target_type === "research") initial = typeof p.report === "string" ? p.report : "";
    else if (suggestion.target_type === "solution") initial = typeof p.doc === "string" ? p.doc : "";
    else if (suggestion.target_type === "prd") initial = typeof p.markdown === "string" ? p.markdown : "";
    setEditText(initial);
    setEditing(true);
  }

  function submitEdit() {
    const trimmed = editText.trim();
    if (!trimmed) {
      setError("编辑内容不能为空");
      return;
    }
    // 用编辑后的文本覆盖 payload 的对应正文键
    const base = { ...suggestion.payload };
    if (suggestion.target_type === "research") base.report = trimmed;
    else if (suggestion.target_type === "solution") base.doc = trimmed;
    else if (suggestion.target_type === "prd") base.markdown = trimmed;
    void respond("edit", base);
  }

  return (
    <div
      data-proposal-id={suggestion.id}
      className="proposal-card flex gap-3 rounded-xl border border-amber-200 bg-amber-50/40 p-3 transition-shadow"
    >
      {/* 琥珀色竖条（问询式确认的物理标识） */}
      <div className="mt-0.5 w-1 shrink-0 rounded-full bg-amber-400" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <Layers className="h-4 w-4 text-amber-500" />
          <span className="text-[13px] font-semibold text-amber-700">
            AI 建议 · {TARGET_LABEL[suggestion.target_type]}
          </span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.cls}`}>
            {meta.label}
          </span>
          {suggestion.source?.conversation_turn != null && (
            <span className="text-[10px] text-slate-400">来源：对话 #{suggestion.source.conversation_turn}</span>
          )}
        </div>

        <p className="line-clamp-4 whitespace-pre-wrap text-[13px] leading-relaxed text-slate-600">
          {previewText(suggestion)}
        </p>

        {error && (
          <div className="mt-1.5 text-[12px] text-[#E5484D]">{error}</div>
        )}

        {editing ? (
          <div className="mt-2">
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={5}
              className="w-full resize-none rounded-lg border border-amber-300 bg-white p-2 text-[13px] leading-relaxed text-slate-700 outline-none focus:ring-1 focus:ring-amber-400"
              placeholder="编辑 AI 建议内容…"
            />
            <div className="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={submitEdit}
                className="flex items-center gap-1 rounded-md bg-amber-500 px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                确认编辑
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(false)}
                className="rounded-md px-2.5 py-1 text-[12px] font-medium text-slate-500 hover:bg-white/70"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          suggestion.status === "pending" && (
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => respond("accept")}
                className="flex items-center gap-1 rounded-md bg-emerald-500 px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                接受
              </button>
              {suggestion.target_type !== "prototype" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={startEdit}
                  className="flex items-center gap-1 rounded-md bg-white px-2.5 py-1 text-[12px] font-medium text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-slate-50"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  编辑
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => respond("ignore")}
                className="flex items-center gap-1 rounded-md bg-white px-2.5 py-1 text-[12px] font-medium text-slate-500 ring-1 ring-slate-200 transition-colors hover:bg-slate-50"
              >
                <X className="h-3.5 w-3.5" />
                忽略
              </button>
            </div>
          )
        )}
      </div>
    </div>
  );
}
