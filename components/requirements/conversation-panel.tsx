"use client";

import { useEffect, useRef, useState } from "react";
import useSWR, { mutate } from "swr";
import { cn } from "@/lib/utils";
import { EVT } from "@/lib/events";
import { ArrowUp, Link2, Plus, User, X, Copy, Check, Loader2 } from "lucide-react";
import { ReferencePanel, type PickedReference } from "./reference-panel";
import { ProposalCard, type SuggestionView, type RespondData } from "./proposal-card";
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

  // M3 · 待确认建议卡（条目级 HITL）。生成产物后由后端写入 suggestions(pending)，
  // 此处拉取 pending 列表渲染；响应后即时刷新。accept/edit/ignore 后该条从列表中移除。
  const { data: proposals, mutate: mutateProposals } = useSWR<SuggestionView[]>(
    rid ? `/api/requirements/${rid}/proposals?status=pending` : null,
    (u: string) => fetch(u).then((r) => r.json()).then((j) => j.data ?? []),
    { revalidateOnFocus: false, revalidateOnReconnect: false }
  );
  const [bulkBusy, setBulkBusy] = useState(false);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hasSentRef = useRef(false);
  // 消息 ID 严格递增计数器：避免 Date.now() 在快速连续追加时返回相同毫秒值
  // 导致 React key 重复（"Encountered two children with the same key" 警告，
  // 极端情况下也会让两条消息被渲染/对调）。所有本地新增消息 id 都走这里。
  const msgIdRef = useRef(0);
  function nextMsgId(): number {
    msgIdRef.current += 1;
    return msgIdRef.current;
  }
  // 对话流并发控制：取消上一轮仍在后台读取的 SSE（文字已显示但卡片抽取等仍在跑），
  // 避免上一轮 done 的 finally 误把本轮 busy 解禁；同时用 sendId 判定"本轮是否仍是当前轮"。
  const convAbortRef = useRef<AbortController | null>(null);
  const convSendIdRef = useRef(0);
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

    // 取消上一轮仍在后台读取的对话流（其文字已显示，但卡片抽取 / 落库等后端工作可能还在跑）。
    // 否则上一轮 done 的 finally 会把本轮（新发送）的 busy 状态误解除，造成按钮在生成中变可点。
    convAbortRef.current?.abort();
    const ac = new AbortController();
    convAbortRef.current = ac;
    const mySendId = ++convSendIdRef.current;

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
        id: nextMsgId(),
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
        signal: ac.signal,
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
            // AI 文字回复已完整下发 → 立即解禁发送按钮，不再等待卡片抽取 / 落库等后续后端工作。
            // 仅当本轮仍是当前轮时才解禁，避免被已取消的旧流 finally 误触。
            if (convSendIdRef.current === mySendId) setBusy(false);
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
          } else if (event === "proposal") {
            // M3 · AI 生成产物 → 新建议卡到达，即时刷新 pending 列表（无需等待轮询）
            if (currentId) mutateProposals();
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
            id: nextMsgId(),
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
      // 被新一轮发送主动取消（AbortError）：属正常流程，不报错、不干扰新一轮的 busy 状态。
      if (e instanceof DOMException && e.name === "AbortError") {
        return;
      }
      setError(e instanceof Error ? e.message : "发送失败");
    } finally {
      // 仅当本轮仍是当前轮时才解禁按钮（被取消的旧流不要误触新一轮状态）。
      if (convSendIdRef.current === mySendId) setBusy(false);
      if (convAbortRef.current === ac) convAbortRef.current = null;
    }
  }

  // 监听后端合成消息（已落库）→ 实时追加到对话（替代原仅存本地 state 的 generation-complete）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { content: string; requirementId?: string };
      if (detail.requirementId !== rid) return;
      if (!detail.content) return;
      setMessages((m) => {
        // 防御性去重：若最后一条助手消息内容完全相同（后端 addMessage 落库 +
        // gen_message 事件双路径，或 SSE 解析/事件重复派发），不再追加第二条。
        const last = m[m.length - 1];
        if (last && last.role === "assistant" && last.content === detail.content) {
          return m;
        }
        return [
          ...m,
          {
            id: nextMsgId(),
            role: "assistant",
            content: detail.content,
            created_at: new Date().toISOString(),
          },
        ];
      });
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
      const summary = `✅ 变更已全部完成！已更新：${updatedList}。你可以在左侧边栏查看最新内容。`;
      setMessages((m) => {
        // 防御性去重：同一条变更总结若已被追加（重复派发），不重复追加
        const last = m[m.length - 1];
        if (last && last.role === "assistant" && last.content === summary) return m;
        return [
          ...m,
          {
            id: nextMsgId(),
            role: "assistant",
            content: summary,
            created_at: new Date().toISOString(),
          },
        ];
      });
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

  // M3 · 单条建议决策后的处理：刷新列表 + 刷新产物 + 阶段闸门（若全部解决）
  function handleProposalResolved(data: RespondData) {
    mutateProposals();
    if (rid) {
      // 通知输出面板立即刷新（SWR 精确 key 匹配，用事件比 mutate 前缀更可靠）
      window.dispatchEvent(
        new CustomEvent(EVT.OUTPUT_REFRESH, { detail: { requirementId: rid } })
      );
    }
    if (data.proceedPrompt) {
      window.dispatchEvent(
        new CustomEvent(EVT.PROCEED_PROMPT, {
          detail: { requirementId: rid, ...data.proceedPrompt },
        })
      );
    }
  }

  // M3 · 全部接受（R7 缓解）：一次性 accept 所有 pending 建议
  async function bulkAcceptAll() {
    if (!rid) return;
    setBulkBusy(true);
    try {
      const res = await fetch(`/api/requirements/${rid}/proposals/bulk-accept`, {
        method: "POST",
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "批量接受失败");
      mutateProposals();
      if (rid) {
        window.dispatchEvent(
          new CustomEvent(EVT.OUTPUT_REFRESH, { detail: { requirementId: rid } })
        );
      }
      for (const p of json.data?.proceedPrompts ?? []) {
        window.dispatchEvent(
          new CustomEvent(EVT.PROCEED_PROMPT, { detail: { requirementId: rid, ...p } })
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "批量接受失败");
    } finally {
      setBulkBusy(false);
    }
  }

  // M3 · 定位来源：从产物条目跳回对应建议卡并高亮（验收红线交互落点）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { suggestionId?: string; conversationTurn?: number };
      if (!scrollRef.current) return;
      if (detail.suggestionId) {
        const el = scrollRef.current.querySelector(`[data-proposal-id="${detail.suggestionId}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("ring-2", "ring-brand", "ring-offset-2");
          setTimeout(() => el.classList.remove("ring-2", "ring-brand", "ring-offset-2"), 2200);
          return;
        }
      }
      if (detail.conversationTurn != null) {
        const el = scrollRef.current.querySelector(`[data-turn="${detail.conversationTurn}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("ring-2", "ring-brand", "ring-offset-2");
          setTimeout(() => el.classList.remove("ring-2", "ring-brand", "ring-offset-2"), 2200);
          return;
        }
      }
      // 无对应元素（如建议已被决策移除）→ 滚动到底部
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    };
    window.addEventListener(EVT.LOCATE_SOURCE, handler);
    return () => window.removeEventListener(EVT.LOCATE_SOURCE, handler);
  }, []);

  // M3 · 监听全局 proposal 事件：生成 SSE 由 requirement-shell 转发，
  // 后端把产物转为 pending 建议卡后即时刷新对话面板的建议列表。
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { requirementId?: string };
      if (detail.requirementId !== rid) return;
      mutateProposals();
    };
    window.addEventListener(EVT.PROPOSAL, handler);
    return () => window.removeEventListener(EVT.PROPOSAL, handler);
  }, [rid, mutateProposals]);

  // 卸载时清理可恢复错误的自动消失计时器，避免对已卸载组件 setState
  useEffect(() => {
    return () => {
      if (errTimerRef.current) clearTimeout(errTimerRef.current);
    };
  }, []);

  return (
    <div className="flex h-full flex-col bg-white">
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto [scrollbar-gutter:stable] px-6 py-[18px]">
        {messages.map((m, i) => (
          <div
            key={m.id}
            data-turn={i + 1}
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

        {/* M3 · 待确认建议卡列表（条目级 HITL 入口） */}
        {proposals && proposals.length > 0 && (
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-slate-400">
                {proposals.length} 条待确认建议
              </span>
              <button
                type="button"
                disabled={bulkBusy}
                onClick={bulkAcceptAll}
                className="flex items-center gap-1 rounded-md bg-brand px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-[#e2570c] disabled:opacity-50"
              >
                {bulkBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                全部接受
              </button>
            </div>
            {proposals.map((s) => (
              <ProposalCard
                key={s.id}
                requirementId={rid as string}
                suggestion={s}
                onResolved={handleProposalResolved}
              />
            ))}
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
