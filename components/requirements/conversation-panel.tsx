"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR, { mutate } from "swr";
import { cn } from "@/lib/utils";
import { EVT, pendingGenMessages, pendingChangeComplete } from "@/lib/events";
import { ArrowUp, Link2, Plus, User, X, Copy, Check, ArrowRight, CheckCircle2, Loader2, Square } from "lucide-react";
import { ReferencePanel, type PickedReference } from "./reference-panel";
import MarkdownRenderer from "./markdown-renderer";
import { useWorkflow } from "@/components/requirements/workflow-context";
import type { ConvPhase } from "@/components/requirements/workflow-context";
import type { OutputMeta, OutputType } from "@/lib/services/outputs";
import type { RequirementStatus } from "@/types";
import { reorderForDisplay } from "@/lib/services/conversation-order";

const STEP_COMPLETE_LABEL: Record<string, string> = {
  dialoguing: "需求确认已完成",
  research_analysis: "调研分析已生成",
  design: "方案设计已完成",
  prd_writing: "需求文档已完成",
};

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

// 输入框自动增高：默认一行(min-h-[40px])，最多撑到 MAX_INPUT_ROWS 行，超出后内部滚动
const INPUT_LINE_H = 24; // leading-6 行高
const INPUT_PAD_Y = 16; // pt-3(12) + 底部余量(4)
const MAX_INPUT_ROWS = 6;
const MAX_INPUT_H = MAX_INPUT_ROWS * INPUT_LINE_H + INPUT_PAD_Y; // 160px

function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  if (el.scrollHeight > MAX_INPUT_H) {
    el.style.height = MAX_INPUT_H + "px";
    el.style.overflowY = "auto";
  } else {
    el.style.height = el.scrollHeight + "px";
    el.style.overflowY = "hidden";
  }
}

interface Msg {
  id: number;
  role: string;
  content: string;
  created_at: string;
  isThinking?: boolean;
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

  // 兜底 flush：若 requirement-shell 派发 GEN_MESSAGE 时本组件尚未 ready，
  // 事件会丢失。rid 就绪后从 pendingGenMessages 取出未处理的话术追加到对话。
  useEffect(() => {
    if (!rid) return;
    const pending = pendingGenMessages.get(rid);
    if (!pending || pending.length === 0) return;
    pendingGenMessages.delete(rid);
    setMessages((prev) => {
      const known = new Set(prev.map((m) => `${m.role}:${m.content}`));
      const additions: Msg[] = [];
      for (const content of pending) {
        if (known.has(`assistant:${content}`)) continue;
        known.add(`assistant:${content}`);
        additions.push({
          id: nextMsgId(),
          role: "assistant",
          content,
          created_at: new Date().toISOString(),
        });
      }
      return additions.length ? [...prev, ...additions] : prev;
    });
  }, [rid]);

  // 兜底 flush：变更完成总结事件（CHANGE_COMPLETE）若在 rid 未就绪时派发，
  // 监听器内 `if (!rid) return` 会直接丢弃。rid 就绪后从 pendingChangeComplete
  // 取出受影响输出物，重新走 /conversation/summary 接口落库并显示总结消息，
  // 保证「✅ 变更已处理完成」在 panel 后挂载场景下不丢失。
  useEffect(() => {
    if (!rid) return;
    const pending = pendingChangeComplete.get(rid);
    if (!pending || pending.length === 0) return;
    // 取走并清空：标记为「已被 flush 处理」，listener 后跑时遇到空缓存会跳过。
    pendingChangeComplete.delete(rid);
    void (async () => {
      let content: string | null = null;
      try {
        const r = await fetch(`/api/requirements/${rid}/conversation/summary`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ affectedOutputs: pending }),
        });
        const j = (await r.json()) as
          | { ok?: boolean; data?: { content?: string | null } }
          | undefined;
        if (j?.ok && typeof j.data?.content === "string" && j.data.content) {
          content = j.data.content;
        }
      } catch {
        /* 走下方兜底 */
      }
      if (!content) {
        const labels: Record<string, string> = {
          card: "需求卡片",
          research_analysis: "调研报告",
          design: "方案文档",
          prototype: "交互原型",
          prd: "需求文档",
          prd_writing: "需求文档",
        };
        const ORDER = ["card", "research_analysis", "design", "prototype", "prd"];
        const sorted = [...pending].sort(
          (a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)
        );
        const updatedList = sorted.map((s) => labels[s] ?? s).join("、");
        content = `✅ 变更已处理完成，涉及 ${updatedList}。如需进一步调整请继续描述。`;
      }
      setMessages((m) => {
        const last = m[m.length - 1];
        if (last && last.role === "assistant" && last.content === content) return m;
        return [
          ...m,
          {
            id: nextMsgId(),
            role: "assistant",
            content,
            created_at: new Date().toISOString(),
          },
        ];
      });
    })();
  }, [rid]);

  // 已生成输出物（供引用面板使用）。与 requirement-shell 共享 SWR 缓存，不额外轮询。
  const { data: outputs } = useSWR<OutputMeta[]>(
    rid ? `/api/requirements/${rid}/outputs` : null,
    (u: string) => fetch(u).then((r) => r.json()).then((j) => j.data),
    { revalidateOnFocus: false, revalidateOnReconnect: false }
  );
  const existingOutputs = (outputs ?? []).filter((o) => o.exists);

  const [messages, setMessages] = useState<Msg[]>([]);
  // 流式正文（独立渲染源）：仅在 SSE 流期间持有 delta 累积文本，渲染为 messages
  // 列表末尾的独立 trailing 流式气泡。流式期间不写入 messages 数组，避免每条
  // delta 都触发整段消息列表重渲染 + react-markdown 重新解析整段 markdown，
  // 恢复流畅的流式输出（commit 3fe7d15 的设计）。
  const [draft, setDraft] = useState("");
  const [text, setText] = useState("");
  // 对话交互阶段（替代原 busy 的布尔判定，统一发送/停止按钮状态）：
  // idle=可发送，thinking=思考中(可终止)，streaming=流出中(可终止)，
  // persisting=后端落库中(禁用)，doc-generating=文档/重生成流(可终止)，disabled=已完成/归档。
  const [convPhase, setConvPhase] = useState<ConvPhase>("idle");
  const convPhaseRef = useRef<ConvPhase>("idle");
  // 包装 setConvPhase，使 ref 始终反映最新 phase（在 reader 回调的闭包中也能读到实时值）
  const updateConvPhase = useCallback((p: ConvPhase) => {
    convPhaseRef.current = p;
    setConvPhase(p);
  }, []);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 工作流：当后端判定当前阶段产物已完成、可进入下一阶段时，pendingPrompt 非空，
  // 此时在输入框上方展示"阶段完成确认条"。
  const workflow = useWorkflow();
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
  // 当前正在流式的气泡 id：thinkId 是 send() 内闭包变量，渲染层访问不到，
  // 故用 ref 持有。流式期间让渲染层跳过该 messages 节点（被 trailing 接管），
  // reply / done / abort 时清空，渲染层恢复显示该气泡承载最终回复。
  const streamingBubbleIdRef = useRef<number | null>(null);
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
    if (!data) return;
    // 初次挂载且尚未本地发送过消息：用服务端数据完整初始化（沿用原行为）
    if (messages.length === 0 && !hasSentRef.current) {
      // 兜底排序：旧 conversation/route.ts 在 SSE 早期写入了「✅ 变更已处理完成」
      // summary 消息，导致这条 summary 在 DB 里出现在「调研分析/方案文档/... 已更新」
      // 之前。虽然后续重建已迁移落库时机，但 DB 里仍残留历史数据，刷新页面/退出重进
      // 后会看到错位。这里在 UI 层做一次纯函数重排，把 summary 提升到所属变更批次最后。
      // 注意：不影响 id/created_at 字段，仅调整数组展示位置，对话跳转 data-turn 也保持稳定。
      setMessages(reorderForDisplay(data as Msg[]));
      return;
    }
    // 增量同步：data 被重新拉取后，若服务端有本地 state 没有的消息，按 id 去重追加，
    // 并叠加内容去重（覆盖整个数组），避免 GEN_MESSAGE 事件链 + 后端落库双路径并存
    // 时（包括中间插入其他消息导致末尾去重失效）的同内容重复显示。
    // 覆盖场景：requirement-shell 通过 mutate(/conversation) 让 SWR 重新拉取时，把后端
    // addMessage 落库的新消息带回对话面板（按钮手动进入下一阶段的推进提示走这里）。
    // GEN_MESSAGE 事件链已存在做即时显示，本 effect 做兜底持久化同步。
    setMessages((prev) => {
      const knownIds = new Set(prev.map((m) => m.id));
      const knownKeys = new Set(prev.map((m) => `${m.role}::${m.content}`));
      const additions = (data as Msg[]).filter((m) => {
        if (knownIds.has(m.id)) return false;
        if (knownKeys.has(`${m.role}::${m.content}`)) return false;
        return true;
      });
      if (additions.length === 0) return prev;
      return [...prev, ...additions];
    });
  }, [data, messages.length]);
  // [问题2修复] 渲染层防御：**相邻**同 role + content 完全相同的气泡只显示第一条。
  // 变更分支的 changeReply 在时序竞争下会同时被 SSE delta 与 SWR 拉回的
  // 历史数据两条路径持有一条——这两条在数组中相邻，用相邻去重即可消除重复，
  // 且不会误伤「非相邻但内容恰好相同」的合法消息（如连续两轮相同的总结/导航回复）。
  const renderedMessages = useMemo(() => {
    const out: Msg[] = [];
    for (const m of messages) {
      const last = out[out.length - 1];
      if (last && last.role === m.role && last.content === m.content) continue;
      out.push(m);
    }
    return out;
  }, [messages]);

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
    if (!message || convPhase !== "idle") return;
    updateConvPhase("thinking");
    setError(null);
    setText("");
    if (taRef.current) taRef.current.style.height = "auto";
    setRefOpen(false);
    hasSentRef.current = true;

    // 取消上一轮仍在后台读取的对话流（其文字已显示，但卡片抽取 / 落库等后端工作可能还在跑）。
    // 否则上一轮 done 的 finally 会把本轮（新发送）的 convPhase 状态误解除，造成按钮在生成中变可点。
    convAbortRef.current?.abort();
    const ac = new AbortController();
    convAbortRef.current = ac;
    const mySendId = ++convSendIdRef.current;

    // 跨 try/catch/finally 共享：占位气泡 id、累积流式文本、后端正式回复
    const thinkingId = nextMsgId();
    streamingBubbleIdRef.current = thinkingId;
    let acc = "";
    let finalReply = "";

    let currentId = rid;
    try {
      if (!currentId) {
        if (!onFirstSend) return;
        currentId = await onFirstSend(message);
        if (!currentId) {
          updateConvPhase("idle");
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
      // [问题1] 立即显示思考占位气泡：用户消息入列后马上追加一条 assistant 占位，
      // 内容为动态「正在思考…」，首个真实 delta 到达后无缝替换为流式正文。
      setMessages((m) => [
        ...m,
        userMsg,
        {
          id: thinkingId,
          role: "assistant",
          content: "",
          created_at: new Date().toISOString(),
          isThinking: true,
        },
      ]);
      setReferences([]);
      // 后端在 done 前通过 event: reply 下发已清理的正式回复（问题1修复：
      // 模型可能仅输出卡片 JSON 无正文，此时气泡优先使用后端 finalReply）

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
              const cleaned = stripCardFence(acc);
              // 流式正文走独立的 draft state + 末尾 trailing 流式气泡渲染，
              // 不再写入 messages 内的占位气泡 content。这样后续 delta 不触碰
              // messages 数组，其他气泡 React.memo 全数命中，避免 react-markdown
              // 每 token 重复解析整段 markdown，恢复流畅流式输出。
              // 首个 delta 到达时：把思考占位气泡切到「isThinking:false, content:""」
              // 状态——保留其在 messages 内的位置，但渲染层跳过（被 trailing 流式气泡替代）。
              if (convSendIdRef.current === mySendId && convPhaseRef.current === "thinking") {
                updateConvPhase("streaming");
                setMessages((m) =>
                  m.map((msg) =>
                    msg.id === thinkingId && msg.isThinking
                      ? { ...msg, isThinking: false, content: "" }
                      : msg
                  )
                );
              }
              setDraft(cleaned);
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
            // [修正] AI 文字回复已完整下发后，本轮进入「后端落库/卡片抽取中」阶段，
            // 此期间仍禁用发送按钮（persisting），直到收到后端 event: persisted 才解禁。
            // 这彻底消除「文字已显示但后端事务未完」时发消息导致气泡消失、顺序错乱的窗口。
            if (convSendIdRef.current === mySendId) {
              // reply 到达 = 本轮流式正文结束：
              // 1) 清空 draft → 移除末尾 trailing 流式气泡
              // 2) 把 finalReply 写入思考占位气泡 content → 该气泡恢复显示承载最终回复
              // 3) 清空 streamingBubbleIdRef → 渲染层不再跳过它，气泡正常显示
              // 这样定型只在发生在这里一次，不会因后续 setMessages 重渲染而重复解析 markdown。
              if (convPhaseRef.current === "streaming") updateConvPhase("persisting");
              const replyText = finalReply;
              setDraft("");
              streamingBubbleIdRef.current = null;
              setMessages((m) =>
                m.map((msg) =>
                  msg.id === thinkingId
                    ? {
                        ...msg,
                        isThinking: false,
                        content: replyText || stripCardFence(acc) || "好的，已收到。",
                      }
                    : msg
                )
              );
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
          } else if (event === "persisted") {
            // [解禁时机] 后端已确认「文字下发完 + 落库/卡片抽取完成」→ 本轮安全结束，
            // 恢复可发送，彻底消除中间窗口。仅当本轮仍是当前轮时解禁，避免被旧流误触。
            if (convSendIdRef.current === mySendId) updateConvPhase("idle");
          } else if (event === "done") {
            // 本轮正常结束：此前任何瞬时错误都已过时，清除横幅（避免「报错一直显示」）
            if (errTimerRef.current) {
              clearTimeout(errTimerRef.current);
              errTimerRef.current = null;
            }
            setError(null);
            // 兜底解禁：极少数情况下若未收到 persisted（旧后端 / 兼容路径），
            // 仍以 done 作为恢复可发送的信号，避免按钮卡死在 persisting。
            if (convSendIdRef.current === mySendId && convPhaseRef.current !== "idle") {
              updateConvPhase("idle");
            }
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

      // 本轮助手消息定型：reply 事件已先一步完成定型（清空 draft + 写入 finalReply）。
      // 此处仅在 reply 未送达（极少兼容情况，如旧后端）时做兜底定型，避免重复渲染。
      // 无论 reply 是否送达，都要确保 draft 清空，防止残留 trailing 流式气泡。
      setDraft("");
      // reply 已先一步清空 ref 并定型；这里仅在 reply 丢失的极端兜底中再清一次。
      if (!finalReply) {
        const bubbleText = stripCardFence(acc) || "好的，已收到。";
        let placeholderStillOpen = false;
        streamingBubbleIdRef.current = null;
        setMessages((m) =>
          m.map((msg) => {
            if (msg.id === thinkingId) {
              placeholderStillOpen = true;
              return { ...msg, isThinking: false, content: bubbleText };
            }
            return msg;
          })
        );
        // 理论上占位气泡必然存在（send 时已创建）；此处冗余兜底：若因异常未创建则补建一条。
        if (!placeholderStillOpen) {
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
      }
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
      // 被新一轮发送主动取消 / 用户主动停止（AbortError）：属正常流程，不报错、不干扰新一轮状态。
      if (e instanceof DOMException && e.name === "AbortError") {
        // 用户主动停止对话流：清空 draft + ref + 把已流式内容定型到 thinking 占位气泡。
        // 兼容两种 abort 时机：
        //   1) 思考期（isThinking=true，无 draft）→ 显示"（已停止生成）"
        //   2) 流式期（isThinking=false，content=""，draft 有内容）→ 把 draft 累积文本写入
        // 若尚无任何正文则填充一句「已停止生成」，避免气泡永远卡在「正在思考…」。
        const accText = finalReply || stripCardFence(acc);
        setDraft("");
        streamingBubbleIdRef.current = null;
        setMessages((m) =>
          m.map((msg) => {
            if (msg.id === thinkingId) {
              return {
                ...msg,
                isThinking: false,
                content: accText || "（已停止生成）",
              };
            }
            return msg;
          })
        );
        return;
      }
      setError(e instanceof Error ? e.message : "发送失败");
    } finally {
      // 仅当本轮仍是当前轮时才恢复按钮（被取消的旧流不要误触新一轮状态）。
      // 被用户主动停止（aborted）→ 回到 idle 可立即再发；未 abort 但卡在 persisting
      // （极端异常路径）→ 兜底 idle，避免按钮永久禁用。
      if (convSendIdRef.current === mySendId) {
        const aborted = ac.signal.aborted;
        updateConvPhase(aborted || convPhaseRef.current === "persisting" ? "idle" : convPhaseRef.current);
      }
      if (convAbortRef.current === ac) convAbortRef.current = null;
    }
  }

  // 用户主动停止当前流：对话流直接 abort 本地读取；文档/重生成/DC 流通过 STOP_FLOW
  // 事件通知 shell 执行对应 abort。停止后由各自的兜底逻辑回到 idle 可发送。
  function stopFlow() {
    convAbortRef.current?.abort();
    window.dispatchEvent(new CustomEvent(EVT.STOP_FLOW, { detail: { requirementId: rid } }));
  }

  // 监听文档/重生成流的开始与结束，使输入框按钮进入「可终止」态并禁用发送。
  useEffect(() => {
    const onStart = () =>
      setConvPhase((p) => {
        if (p === "idle") {
          convPhaseRef.current = "doc-generating";
          return "doc-generating";
        }
        return p;
      });
    const onEnd = () =>
      setConvPhase((p) => {
        if (p === "doc-generating") {
          convPhaseRef.current = "idle";
          return "idle";
        }
        return p;
      });
    window.addEventListener(EVT.DOC_GEN_START, onStart);
    window.addEventListener(EVT.DOC_GEN_END, onEnd);
    return () => {
      window.removeEventListener(EVT.DOC_GEN_START, onStart);
      window.removeEventListener(EVT.DOC_GEN_END, onEnd);
    };
  }, []);

  // 监听后端合成消息（已落库）→ 实时追加到对话（替代原仅存本地 state 的 generation-complete）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { content: string; requirementId?: string };
      // 统一 String() 后再比较，防御 shell 侧 URL 字符串与 panel 侧 id 的类型漂移
      // （历史出现过 number/string 不一致导致消息静默丢弃）。
      if (String(detail.requirementId) !== String(rid)) return;
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

  // 监听【按钮手动进入下一阶段】专用推进提示事件（无 rid 守卫，必收）。
  // 与 GEN_MESSAGE 监听器互补：本通道用于绕开 rid/双 mount 时序不一致导致的
  // 静默失效问题，确保按钮路径的推进提示一定能 append 到对话列表。
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { content?: string; requirementId?: string };
      const content = detail?.content;
      if (!content) return;
      // 只在 rid 已 set 且与派发端 requirementId 不匹配时丢弃（防止跨页面串扰）
      // String() 统一类型：shell 侧为 URL 字符串、panel 侧 rid 可能为 number。
      if (rid && detail.requirementId && String(detail.requirementId) !== String(rid)) return;
      setMessages((m) => {
        const last = m[m.length - 1];
        if (last && last.role === "assistant" && last.content === content) return m;
        return [
          ...m,
          {
            id: nextMsgId(),
            role: "assistant",
            content,
            created_at: new Date().toISOString(),
          },
        ];
      });
    };
    window.addEventListener(EVT.PROCEED_TIP, handler);
    return () => window.removeEventListener(EVT.PROCEED_TIP, handler);
  }, [rid]);

  // 监听【返回修改】→ 在输入框填入默认修改文案、聚焦并把光标移到末尾，供用户补充修改点
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { defaultText: string };
      const defaultText = detail.defaultText ?? "";
      setText(defaultText);
      // 延迟聚焦并重新计算高度，确保长文案填入后正确撑高；并将光标定位到末尾
      setTimeout(() => {
        if (taRef.current) {
          taRef.current.focus();
          const len = defaultText.length;
          taRef.current.setSelectionRange(len, len);
          autoGrow(taRef.current);
        }
      }, 0);
    };
    window.addEventListener(EVT.REQUEST_MODIFY, handler);
    return () => window.removeEventListener(EVT.REQUEST_MODIFY, handler);
  }, []);

  // 监听变更全部完成事件 → 落库总结消息（替代 conversation/route.ts 内早期 addMessage）。
  //
  // 关键时序：原「变更已处理完成」总结写在 SSE change_update 之后、四路重生成启动之前，
  // 顺序上早于「调研分析/方案文档/... 已更新」入库，导致刷新页面/退出重进后
  // 总结跑到具体更新之前看起来很乱。现改为：等所有重生成完成 → EVT.CHANGE_COMPLETE
  // 触发 → 由前端调 `/api/requirements/[id]/conversation/summary` 落库，并复用
  // 返回值（或本地兜底）追加到对话。
  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        requirementId: string;
        affectedOutputs: string[];
      };
      if (!rid || String(detail.requirementId) !== String(rid)) return;
      if (!Array.isArray(detail.affectedOutputs) || detail.affectedOutputs.length === 0) return;
      // [问题1修复] 同步清空 pendingChangeComplete 兜底缓存（监听器已经处理了，
      // 避免下方 rid-ready flush effect 重复执行导致总结消息出现两次）。
      pendingChangeComplete.delete(rid);

      let content: string | null = null;
      try {
        // 1) 先让后端把总结写到 DB（4 路重生成都已落库后才调，因此 DB id 一定晚于所有
        //    「X已更新」消息——保证 listConversations 按 id ASC 回显顺序正确）。
        const r = await fetch(`/api/requirements/${rid}/conversation/summary`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ affectedOutputs: detail.affectedOutputs }),
        });
        const j = (await r.json()) as
          | { ok?: boolean; data?: { content?: string | null } }
          | undefined;
        if (j?.ok && typeof j.data?.content === "string" && j.data.content) {
          content = j.data.content;
        }
      } catch {
        // 网络/服务异常时不阻塞展示，走下方兜底逻辑。
      }
      if (!content) {
        // 兜底文本与原 conversation/route.ts 中写入的「变更已处理完成」模板保持一致，
        // 仅本次会话可见；下次刷新会因后端未持久化而消失，但不会再次错位。
        const labels: Record<string, string> = {
          card: "需求卡片",
          research_analysis: "调研报告",
          design: "方案文档",
          prototype: "交互原型",
          prd: "需求文档",
          prd_writing: "需求文档",
        };
        const ORDER = ["card", "research_analysis", "design", "prototype", "prd"];
        const sorted = [...detail.affectedOutputs].sort(
          (a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)
        );
        const updatedList = sorted.map((s) => labels[s] ?? s).join("、");
        content = `✅ 变更已处理完成，涉及 ${updatedList}。如需进一步调整请继续描述。`;
      }
      // [兜底修复] 主动触发 SWR mutate 重新拉取 conversation，确保所有「X已更新」通知
      // 也通过 SWR 重新拉取显示（即便 GEN_MESSAGE 事件因 SSE 时序竞争丢失，重新拉取后
      // DB 已落库的合成消息也会通过 useEffect 增量同步追加到 messages 数组）。
      void mutate(`/api/requirements/${rid}/conversation`);
      setMessages((m) => {
        // 防御性去重：同一条变更总结若已被追加（重复派发），不重复追加
        const last = m[m.length - 1];
        if (last && last.role === "assistant" && last.content === content) return m;
        return [
          ...m,
          {
            id: nextMsgId(),
            role: "assistant",
            content,
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
      if (!detail.requirementId || String(detail.requirementId) !== String(rid)) return;
      const msg = detail.message || "自动推进生成失败，请通过上方阶段栏按钮重试。";
      setError(msg);
      // 8 秒后自动消失（可恢复性质）
      if (errTimerRef.current) clearTimeout(errTimerRef.current);
      errTimerRef.current = setTimeout(() => setError(null), 8000);
    };
    window.addEventListener(EVT.GEN_ERROR, handler);
    return () => window.removeEventListener(EVT.GEN_ERROR, handler);
  }, [rid]);

  // 定位来源：从产物条目跳回产生该产物的对话轮次并高亮（对话回溯）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { conversationTurn?: number };
      if (!scrollRef.current) return;
      if (detail.conversationTurn != null) {
        const el = scrollRef.current.querySelector(`[data-turn="${detail.conversationTurn}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("ring-2", "ring-brand", "ring-offset-2");
          setTimeout(() => el.classList.remove("ring-2", "ring-brand", "ring-offset-2"), 2200);
          return;
        }
      }
      // 无对应元素（如对话已被移除）→ 滚动到底部
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    };
    window.addEventListener(EVT.LOCATE_SOURCE, handler);
    return () => window.removeEventListener(EVT.LOCATE_SOURCE, handler);
  }, []);

  // 卸载时清理可恢复错误的自动消失计时器，避免对已卸载组件 setState
  useEffect(() => {
    return () => {
      if (errTimerRef.current) clearTimeout(errTimerRef.current);
    };
  }, []);

  return (
    <div className="flex h-full flex-col bg-white">
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto [scrollbar-gutter:stable] px-6 py-[18px]">
        {renderedMessages.map((m, i) => {
          // 流式期间：本轮 thinking 占位气泡的位置由末尾 trailing 流式气泡接管，
          // 跳过渲染避免与 trailing 流式气泡重复显示。
          // 流式结束后 draft 已清空 + streamingBubbleIdRef 清空，气泡恢复显示承载最终回复。
          if (m.id === streamingBubbleIdRef.current && draft) return null;
          return (
          <div
            key={m.id}
            data-turn={i + 1}
            className={`flex items-start gap-3 ${m.role === "user" ? "flex-row-reverse" : ""}`}
          >
            {m.role === "assistant" ? (
              <span className="-mt-[2px] flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand/10">
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
              {m.role === "user" ? (
                <span className="inline-block whitespace-pre-wrap rounded-bl-[18px] rounded-br-[18px] rounded-tl-[18px] rounded-tr-[5px] bg-brand px-4 py-2.5 text-[15.75px] leading-relaxed text-white">
                  {m.content}
                </span>
              ) : (
                <span className="inline-block rounded-bl-[18px] rounded-br-[18px] rounded-tl-[5px] rounded-tr-[18px] bg-[#F9F8F5] px-4 pb-2.5 pt-2 text-[15.75px] leading-relaxed text-[#111111] ring-1 ring-[#1111111a] [word-break:break-word] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                  {m.meta?.references && m.meta.references.length > 0 && (
                    <div className="-mx-1 mb-2 flex flex-wrap gap-1">
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
                  {m.isThinking ? (
                    // 思考占位态：仅显示三点动画，文案由右上角 phase 提示承载。
                    // 用与一行回复等高的容器（leading-relaxed 行高）把三点垂直居中，
                    // 保证思考态气泡高度 = 一行回复高度。
                    <span className="flex h-[1.625em] items-center text-[#78746C]">
                      <span className="inline-flex items-center gap-1">
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#f66612] [animation-delay:-0.3s]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#f66612] [animation-delay:-0.15s]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#f66612]" />
                      </span>
                    </span>
                  ) : (
                    <MarkdownRenderer content={m.content} disableMermaid />
                  )}
                </span>
              )}
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
          );
        })}
        {/* 末尾 trailing 流式气泡：仅在 SSE 流期间（draft 非空）渲染，承载流式正文。
            draft state 变更只触发本单元重渲染，messages 数组不变 → 其他气泡 React.memo
            全部命中 → 避免每次 delta 都触发 react-markdown 重新解析整段 markdown，
            恢复流畅的流式输出。 */}
        {draft && (
          <div
            data-turn="streaming"
            className="flex items-start gap-3"
          >
            <span className="-mt-[2px] flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand/10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo-orange.png" alt="AskBuddy" className="h-7 w-7 object-contain" />
            </span>
            <div className="flex min-w-0 max-w-[80%] flex-col items-start">
              <span className="inline-block rounded-bl-[18px] rounded-br-[18px] rounded-tl-[5px] rounded-tr-[18px] bg-[#F9F8F5] px-4 py-2.5 text-[15.75px] leading-relaxed text-[#111111] ring-1 ring-[#1111111a] [word-break:break-word] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                <MarkdownRenderer content={draft} disableMermaid />
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

        {/* 输入框药丸：上=输入区，下=功能区(加号常驻左 / 发送常驻右)；默认一行，最多 6 行，超出后内部滚动 */}
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
          {/* 变更更新状态条：产物更新中显示在输入框上方（原位于顶部阶段模块）。
              此时 pendingPrompt 已被置空，阶段完成确认条（下方）自动隐藏，避免误点。 */}
          {workflow?.changeTasks && workflow.changeTasks.length > 0 && (
            <div className="flex h-[56px] items-center gap-2 rounded-t-2xl border-b border-[#1111111a] bg-[#FEF3C7] px-4 text-[13.5px] font-semibold text-[#B45309]">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在自动更新 {workflow.changeTasks.length} 个输出物…
            </div>
          )}
          {/* 阶段完成确认条：平时隐藏，后端判定可进入下一阶段时显示在输入框上方 */}
          {workflow?.pendingPrompt && (() => {
            // 是否为最后阶段（需求文档）：只有需求文档完成后才显示「完成定版」
            // 方案文档完成后的 nextStep 为 null 是因为要进入原型子阶段，不能误判为最后阶段
            const isFinal = workflow.pendingPrompt.step === "prd_writing";
            return (
            <div className="flex h-[56px] items-center justify-between gap-3 rounded-t-2xl border-b border-[#1111111a] bg-[#F2F0EB] px-4">
              <div className="flex min-w-0 items-center gap-2">
                <CheckCircle2 className="h-[18px] w-[18px] shrink-0 text-[#16a34a]" />
                <span className="truncate text-[13.5px] font-semibold text-[#1C1917]">
                  {workflow.pendingPrompt.message ||
                    `${STEP_COMPLETE_LABEL[workflow.pendingPrompt.step] ?? "当前阶段已完成"}${isFinal ? "，可以确认完成定版" : "，可以进入下一阶段"}`}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => workflow.onReturnToModify()}
                  className="rounded-[9px] border border-[#1111111a] bg-white px-3.5 py-2 text-[13.5px] font-semibold text-[#57534E] hover:bg-[#F5F4F1]"
                >
                  返回修改
                </button>
                <button
                  onClick={() => workflow.onProceed()}
                  className="flex items-center gap-1.5 rounded-[9px] bg-[#f66612] px-3.5 py-2 text-[13.5px] font-semibold text-white hover:bg-[#e85d0a]"
                >
                  {isFinal ? "完成定版" : "进入下一阶段"}
                  {!isFinal && <ArrowRight className="h-4 w-4" />}
                </button>
              </div>
            </div>
            );
          })()}
          <textarea
            ref={taRef}
            rows={1}
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
            className="min-h-[40px] w-full resize-none overflow-y-hidden bg-transparent px-4 pt-3 text-[15.75px] leading-6 text-[#111111] outline-none placeholder:text-[#78746C] transition-[height] duration-200 ease-out"
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
            {(() => {
              const isGenerating =
                convPhase === "thinking" ||
                convPhase === "streaming" ||
                convPhase === "doc-generating";
              // 可终止阶段（对话思考/流出/文档生成）→ 显示停止方块；
              // 后端落库中的 persisting、已完成/归档 → 禁用（无操作）。
              const isStoppable = isGenerating;
              if (isStoppable) {
                return (
                  <button
                    type="button"
                    onClick={stopFlow}
                    className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#E5484D] text-white transition-colors hover:bg-[#c93b40]"
                    title="停止生成"
                  >
                    <Square className="h-[15px] w-[15px]" fill="currentColor" strokeWidth={0} />
                  </button>
                );
              }
              const isDisabled =
                convPhase !== "idle" || status === "completed" || status === "archived";
              return (
                <button
                  type="button"
                  onClick={send}
                  disabled={isDisabled}
                  className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                  title={isDisabled ? "生成中，请稍候" : "发送"}
                >
                  <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
                </button>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
