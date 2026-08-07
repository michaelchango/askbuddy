"use client";

import { useEffect, useRef, useState } from "react";
import useSWR, { mutate } from "swr";
import { cn } from "@/lib/utils";
import { EVT } from "@/lib/events";
import { ArrowUp, Link2, Plus, User, X, Copy, Check } from "lucide-react";
import { ReferencePanel, type PickedReference } from "./reference-panel";
import type { OutputMeta, OutputType } from "@/lib/services/outputs";
import type { RequirementStatus } from "@/types";

interface ChatRef {
  type: string;
  label: string;
  version: number;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// 文本框随内容自动增高（换行抬高）
function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

interface Msg {
  id: number;
  role: string;
  content: string;
  created_at: string;
  meta?: { references?: ChatRef[] } | null;
}

export function ConversationPanel({
  requirementId,
  status,
  onFirstSend,
  onCardExtracted,
}: {
  /**
   * 需求 id。为 null 表示「尚未创建需求」——首条消息触发 onFirstSend 完成创建并返回新需求 id。
   */
  requirementId: string | null;
  status: RequirementStatus;
  onFirstSend?: (message: string) => Promise<string | null>;
  /** 每轮对话抽取到部分卡片时回调（用于右侧卡片预览实时填充）。 */
  onCardExtracted?: (card: Record<string, string>) => void;
}) {
  const [rid, setRid] = useState<string | null>(requirementId);
  const { data } = useSWR<Msg[]>(
    rid ? `/api/requirements/${rid}/conversation` : null,
    (u: string) => fetch(u).then((r) => r.json()).then((j) => j.data),
    { revalidateOnFocus: false, revalidateOnReconnect: false }
  );

  // 已生成输出物（供引用面板使用）。与 requirement-shell 共享 SWR 缓存，不额外轮询。
  const { data: outputs } = useSWR<OutputMeta[]>(
    rid ? `/api/requirements/${rid}/outputs` : null,
    (u: string) => fetch(u).then((r) => r.json()).then((j) => j.data),
    { revalidateOnFocus: false, revalidateOnReconnect: false }
  );
  const existingOutputs = (outputs ?? []).filter((o) => o.exists);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hasSentRef = useRef(false);
  // 可恢复错误（连接池瞬时耗尽等）的自动消失计时器；硬错误（AI 不可用等）不自动消失。
  const errTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 复制反馈：当前已复制消息的 id（1.5s 后自动清除）
  const [copiedId, setCopiedId] = useState<number | null>(null);

  async function copyMessage(id: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((v) => (v === id ? null : v));
      }, 1500);
    } catch {
      /* 忽略复制失败 */
    }
  }

  // 引用
  const [references, setReferences] = useState<PickedReference[]>([]);
  const [refOpen, setRefOpen] = useState(false);

  useEffect(() => {
    if (data && messages.length === 0 && !hasSentRef.current) setMessages(data);
  }, [data, messages.length]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "instant" as ScrollBehavior });
  }, [messages, draft]);

  function stripCardFence(t: string): string {
    const i = t.search(/```json|```/i);
    return (i >= 0 ? t.slice(0, i) : t)
      .replace(/\[STEP_COMPLETE\]/g, "")
      .replace(/\[COMPLEXITY:\s*[^\]]*\]/gi, "")
      .trim();
  }

  function handleSSE(buf: string, onEvent: (event: string, data: string) => void) {
    let rest = buf;
    let sep: number;
    while ((sep = rest.indexOf("\n\n")) !== -1) {
      const block = rest.slice(0, sep);
      rest = rest.slice(sep + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) onEvent(event, dataLines.join("\n"));
    }
    return rest;
  }

  async function send() {
    const message = text.trim();
    const refs = references;
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    setText("");
    if (taRef.current) taRef.current.style.height = "auto";
    setRefOpen(false);
    hasSentRef.current = true;

    let currentId = rid;
    try {
      if (!currentId) {
        if (!onFirstSend) return;
        currentId = await onFirstSend(message);
        if (!currentId) {
          setBusy(false);
          return;
        }
        setRid(currentId);
      }

      const userMsg: Msg = {
        id: Date.now(),
        role: "user",
        content: message,
        created_at: new Date().toISOString(),
        meta: refs.length ? { references: refs } : null,
      };
      setMessages((m) => [...m, userMsg]);
      setReferences([]);
      setDraft("");
      let acc = "";
      // 后端在 done 前通过 event: reply 下发已清理的正式回复（问题1修复：
      // 模型可能仅输出卡片 JSON 无正文，此时气泡优先使用后端 finalReply）
      let finalReply = "";

      const res = await fetch(`/api/requirements/${currentId}/conversation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, references: refs }),
      });
      if (!res.body) throw new Error("无响应");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        buf = handleSSE(buf, (event, data) => {
          if (event === "delta") {
            try {
              const delta = JSON.parse(data) as string;
              acc += delta;
              setDraft(stripCardFence(acc));
            } catch {
              /* ignore */
            }
          } else if (event === "reply") {
            // 后端已清理的正式回复文本（气泡最终内容优先来源）
            try {
              const r = JSON.parse(data) as string;
              if (typeof r === "string" && r.trim()) finalReply = r.trim();
            } catch {
              /* ignore */
            }
          } else if (event === "card") {
            // 卡片成功回传说明 DB 此刻可达，清掉任何残留错误横幅
            setError(null);
            try {
              onCardExtracted?.(JSON.parse(data) as Record<string, string>);
              // 刷新右侧卡片内容缓存，使最新提炼结果即时呈现
              if (currentId) mutate(`/api/requirements/${currentId}/outputs/card`);
            } catch {
              /* ignore */
            }
          } else if (event === "title") {
            try {
              const { title } = JSON.parse(data) as { title: string };
              if (title && rid) {
                mutate(`/api/requirements/${rid}`);
                // 连带失效项目需求列表（面包屑同项目需求），保证列表与详情读同一持久标题
                mutate(
                  (key) =>
                    typeof key === "string" &&
                    key.startsWith("/api/requirements?projectId="),
                  undefined,
                  { revalidate: true }
                );
              }
            } catch {
              /* ignore */
            }
          } else if (event === "error") {
            try {
              const e = JSON.parse(data) as { message?: string; recoverable?: boolean };
              setError(e.message || "对话出错");
              if (e.recoverable) {
                // 可恢复错误（连接池瞬时耗尽等）自动消失，不长期占用界面
                if (errTimerRef.current) clearTimeout(errTimerRef.current);
                errTimerRef.current = setTimeout(() => setError(null), 8000);
              }
            } catch {
              setError("对话出错");
            }
          } else if (event === "done") {
            // 本轮正常结束：此前任何瞬时错误都已过时，清除横幅（避免「报错一直显示」）
            if (errTimerRef.current) {
              clearTimeout(errTimerRef.current);
              errTimerRef.current = null;
            }
            setError(null);
          } else if (event === "step_update") {
            // 进展类事件到达即视为本轮已推进成功，清掉残留错误横幅
            setError(null);
            // 步骤状态变更：直接注入 SWR 缓存 + 拉取 outputs
            if (currentId) {
              try {
                const steps = JSON.parse(data);
                mutate(`/api/requirements/${currentId}/steps`, steps, false);
              } catch {
                mutate(`/api/requirements/${currentId}/steps`);
              }
              fetch(`/api/requirements/${currentId}/outputs`)
                .then((r) => r.json())
                .then((j) => {
                  if (j.ok) mutate(`/api/requirements/${currentId}/outputs`, j.data, false);
                })
                .catch(() => {});
            }
          } else if (event === "proceed_prompt") {
            // AI 提示进入下一步 → 转发给 shell 显示确认闸门双按钮（携带 nextStep/version/auto/subPhase）
            // 同时清掉残留错误横幅（进入下一阶段本身是成功推进）
            setError(null);
            if (currentId) {
              try {
                const payload = JSON.parse(data) as {
                  step: string;
                  nextStep?: string | null;
                  canSkip: boolean;
                  message?: string;
                  version?: number;
                  auto?: boolean;
                  subPhase?: string;
                };
                window.dispatchEvent(
                  new CustomEvent(EVT.PROCEED_PROMPT, {
                    detail: {
                      requirementId: currentId,
                      step: payload.step,
                      nextStep: payload.nextStep ?? null,
                      canSkip: payload.canSkip,
                      message: payload.message ?? "需求已明确，是否进入下一阶段？",
                      version: payload.version,
                      auto: payload.auto ?? false,
                      // 透传 subPhase（设计阶段方案文档 → 原型子阶段的判定依据），
                      // 否则 handleProceed 误把 subPhase 丢失为 undefined、走 PATCH done 路径
                      subPhase: payload.subPhase,
                    },
                  })
                );
              } catch { /* ignore */ }
            }
          } else if (event === "change_update") {
            // AI 检测到变更点 → 通知 shell 自动执行变更更新队列
            if (currentId) {
              try {
                const payload = JSON.parse(data) as {
                  affectedOutputs: string[];
                  changes: Array<{ output: string; field: string; description: string }>;
                  summary: string;
                };
                // 通知 shell 执行变更更新
                window.dispatchEvent(
                  new CustomEvent(EVT.CHANGE_UPDATE, {
                    detail: {
                      requirementId: currentId,
                      affectedOutputs: payload.affectedOutputs,
                      changes: payload.changes,
                      summary: payload.summary,
                    },
                  })
                );
              } catch { /* ignore */ }
            }
          }
        });
      }

      // 本轮助手消息：优先使用后端 reply 事件下发的正式回复（兜底流式清理文本），
      // 修复模型仅输出卡片 JSON 时气泡空白的问题。
      // 兜底：当回复完全为空时使用默认文本，防止气泡消失。
      const bubbleText = finalReply || stripCardFence(acc) || "好的，已收到。";
      if (bubbleText) {
        setMessages((m) => [
          ...m,
          {
            id: Date.now(),
            role: "assistant",
            content: bubbleText,
            created_at: new Date().toISOString(),
          },
        ]);
      }
      setDraft("");
      // 对话完成后直接拉取 outputs 并注入 SWR 缓存，确保侧边栏即时更新
      if (currentId) {
        try {
          const outRes = await fetch(`/api/requirements/${currentId}/outputs`);
          const outJson = await outRes.json();
          if (outJson.ok) mutate(`/api/requirements/${currentId}/outputs`, outJson.data, false);
        } catch {
          mutate(`/api/requirements/${currentId}/outputs`);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "发送失败");
    } finally {
      setBusy(false);
    }
  }

  // 监听后端合成消息（已落库）→ 实时追加到对话（替代原仅存本地 state 的 generation-complete）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { content: string; requirementId?: string };
      if (detail.requirementId !== rid) return;
      if (!detail.content) return;
      setMessages((m) => [
        ...m,
        {
          id: Date.now(),
          role: "assistant",
          content: detail.content,
          created_at: new Date().toISOString(),
        },
      ]);
    };
    window.addEventListener(EVT.GEN_MESSAGE, handler);
    return () => window.removeEventListener(EVT.GEN_MESSAGE, handler);
  }, [rid]);

  // 监听【返回修改】→ 在输入框填入默认修改文案并聚焦，供用户补充修改点
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { defaultText: string };
      setText(detail.defaultText ?? "");
      // 延迟聚焦，确保输入框已更新
      setTimeout(() => taRef.current?.focus(), 0);
    };
    window.addEventListener(EVT.REQUEST_MODIFY, handler);
    return () => window.removeEventListener(EVT.REQUEST_MODIFY, handler);
  }, []);

  // 监听变更全部完成事件 → 添加总结消息
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        requirementId: string;
        affectedOutputs: string[];
      };
      if (detail.requirementId !== rid) return;
      const labels: Record<string, string> = {
        card: "需求卡片",
        research_analysis: "调研分析",
        design: "方案设计",
        prd: "需求文档",
        prd_writing: "需求文档",
      };
      const updatedList = detail.affectedOutputs
        .map((s) => labels[s] ?? s)
        .join("、");
      setMessages((m) => [
        ...m,
        {
          id: Date.now(),
          role: "assistant",
          content: `✅ 变更已全部完成！已更新：${updatedList}。你可以在左侧边栏查看最新内容。`,
          created_at: new Date().toISOString(),
        },
      ]);
    };
    window.addEventListener(EVT.CHANGE_COMPLETE, handler);
    return () => window.removeEventListener(EVT.CHANGE_COMPLETE, handler);
  }, [rid]);

  // 监听自动推进生成失败事件（handleProceed 在 handleGenerate 抛错时下发）
  // 将错误显示为可恢复横幅 + 8s 自动消失，引导用户通过顶部按钮重试
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        requirementId: string;
        step: string;
        message: string;
      };
      if (!detail.requirementId || detail.requirementId !== rid) return;
      const msg = detail.message || "自动推进生成失败，请通过上方阶段栏按钮重试。";
      setError(msg);
      // 8 秒后自动消失（可恢复性质）
      if (errTimerRef.current) clearTimeout(errTimerRef.current);
      errTimerRef.current = setTimeout(() => setError(null), 8000);
    };
    window.addEventListener(EVT.GEN_ERROR, handler);
    return () => window.removeEventListener(EVT.GEN_ERROR, handler);
  }, [rid]);

  // 卸载时清理可恢复错误的自动消失计时器，避免对已卸载组件 setState
  useEffect(() => {
    return () => {
      if (errTimerRef.current) clearTimeout(errTimerRef.current);
    };
  }, []);

  return (
    <div className="flex h-full flex-col bg-white">
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto [scrollbar-gutter:stable] px-6 py-[18px]">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex items-start gap-3 ${m.role === "user" ? "flex-row-reverse" : ""}`}
          >
            {m.role === "assistant" ? (
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand/10">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/logo-orange.png" alt="AskBuddy" className="h-7 w-7 object-contain" />
              </span>
            ) : (
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-white">
                <User className="h-[18px] w-[18px]" />
              </span>
            )}

            <div
              className={`flex min-w-0 max-w-[80%] flex-col ${
                m.role === "user" ? "items-end" : "items-start"
              }`}
            >
              {m.meta?.references && m.meta.references.length > 0 && (
                <div className="mb-1.5 flex flex-wrap gap-1">
                  {m.meta.references.map((r, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500"
                    >
                      <Link2 className="h-3 w-3" />
                      {r.label} v{r.version}
                    </span>
                  ))}
                </div>
              )}
              <span
                className={`inline-block whitespace-pre-wrap px-4 py-2.5 text-[15.75px] leading-relaxed ${
                  m.role === "user"
                    ? "rounded-bl-[18px] rounded-br-[18px] rounded-tl-[18px] rounded-tr-[5px] bg-brand text-white"
                    : "rounded-bl-[18px] rounded-br-[18px] rounded-tl-[5px] rounded-tr-[18px] bg-[#F9F8F5] text-[#111111] ring-1 ring-[#1111111a]"
                }`}
              >
                {m.content}
              </span>
              {m.role === "user" ? (
                <div className="mt-1 flex items-center gap-2 px-1">
                  <span className="text-[11px] text-slate-400">
                    {fmtTime(m.created_at)}
                  </span>
                  <button
                    type="button"
                    onClick={() => copyMessage(m.id, m.content)}
                    className="flex items-center rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                    title={copiedId === m.id ? "已复制" : "复制消息"}
                  >
                    {copiedId === m.id ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              ) : (
                <span className="mt-1 px-1 text-[11px] text-slate-400">
                  {fmtTime(m.created_at)}
                </span>
              )}
            </div>
          </div>
        ))}
        {draft && (
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand/10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/logo-orange.png" alt="AskBuddy" className="h-7 w-7 object-contain" />
            </span>
            <div className="flex min-w-0 max-w-[80%] flex-col items-start">
              <span className="inline-block whitespace-pre-wrap rounded-bl-[18px] rounded-br-[18px] rounded-tl-[5px] rounded-tr-[18px] bg-[#F9F8F5] px-4 py-2.5 text-[15.75px] leading-relaxed text-[#111111] ring-1 ring-[#1111111a]">
                {draft}
                <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-brand" />
              </span>
              <span className="mt-1 px-1 text-[11px] text-slate-400">生成中…</span>
            </div>
          </div>
        )}
        {messages.length === 0 && !draft && (
          <div className="py-10 text-center text-sm text-slate-400">
            发送第一条消息，开始创建你的需求。
          </div>
        )}
      </div>

      <div className="relative mt-0 border-t border-[#1111111a] px-6 pb-[18px] pt-[18px]">
        {/* 错误提示条 */}
        {error && (
          <div className="mb-2 flex items-start gap-2 rounded-[10px] border border-[#E5484D33] bg-[#E5484D0d] px-3 py-2 text-[13px] text-[#E5484D]">
            <span className="flex-1 leading-relaxed">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label="关闭"
              className="mt-0.5 shrink-0 rounded-full p-0.5 transition-colors hover:bg-[#E5484D1a]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* 引用 chips */}
        {references.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {references.map((r) => (
              <span
                key={r.type}
                className="inline-flex items-center gap-1 rounded-full bg-brand/5 px-2.5 py-1 text-[12px] text-[#d85a10]"
              >
                <Link2 className="h-3 w-3" />
                {r.label} v{r.version}
                <button
                  onClick={() => setReferences((rs) => rs.filter((x) => x.type !== r.type))}
                  className="ml-0.5 rounded-full hover:bg-brand/10"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* 引用面板 + 点击外部关闭遮罩 */}
        {refOpen && rid && (
          <div
            className="fixed inset-0 z-20"
            onClick={() => setRefOpen(false)}
          />
        )}

        {/* 输入框药丸：上=输入区，下=功能区(加号常驻左 / 发送常驻右)；默认两行，换行自动抬高 */}
        <div
          className={cn(
            "relative flex flex-col rounded-2xl border bg-[#F2F0EB] transition-colors",
            focused ? "border-brand" : "border-[#1111111a]"
          )}
        >
          {/* 引用面板：挂在药丸左边框上 */}
          {refOpen && rid && (
            <ReferencePanel
              outputs={existingOutputs}
              picked={references}
              onPick={(ref) => setReferences((rs) => [...rs.filter((x) => x.type !== ref.type), ref])}
              onRemove={(type: OutputType) =>
                setReferences((rs) => rs.filter((x) => x.type !== type))
              }
            />
          )}
          <textarea
            ref={taRef}
            rows={2}
            value={text}
            placeholder="描述你的需求想法，Enter 发送 / Shift+Enter 换行"
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => {
              setText(e.target.value);
              autoGrow(e.target);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            className="min-h-[64px] w-full resize-none bg-transparent px-4 pt-3 text-[15.75px] leading-6 text-[#111111] outline-none placeholder:text-[#78746C] transition-[height] duration-200 ease-out"
          />
          <div className="flex items-center justify-between px-2 pb-2">
            {rid ? (
              <button
                type="button"
                onClick={() => setRefOpen((v) => !v)}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-xl transition-colors",
                  refOpen
                    ? "bg-white text-brand shadow-sm"
                    : "text-slate-500 hover:bg-white/70"
                )}
                title="引用上下文"
              >
                <Plus className="h-[18px] w-[18px]" />
              </button>
            ) : (
              <span className="h-9 w-9" />
            )}
            <button
              type="button"
              onClick={send}
              disabled={busy || status === "completed" || status === "archived"}
              className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-white transition-opacity disabled:opacity-40"
              title="发送"
            >
              <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
