"use client";

// DevContext 过期提示条（M5-D2 · P2-7）。
//
// 三个出口，缺一不可：
//   「重算这 N 段」   —— 主路径：只花受影响那几段的 token
//   「全部重算」      —— 逃生舱：用户不信任定向结果时用
//   「标记为无需更新」—— 承认映射表会误报的**人工纠正**出口
//
// 为什么必须有人工出口：确定性映射表宁可多算不可漏算，误报是设计的一部分；
// 若没有便宜的纠正手段，用户就会被迫为自己认为无关的标记反复付 token。
//
// 完成后把 `change_update` 里的 changed/unchanged 直接显示出来
//（「本次更新 3 段，其余 7 段未变」）——把验收标准做进 UI，用户每次都能亲眼验证。

import { useState } from "react";
import { Loader2, RefreshCw, XCircle, ChevronDown } from "lucide-react";
import { SECTION_LABELS, type SectionKey } from "@/lib/schemas/devcontext";

/** 影响源 → 中文名（用于「因『约束』变更」这类文案）。 */
const TRIGGER_LABELS: Record<string, string> = {
  "card.background": "需求背景",
  "card.targetUsers": "目标用户",
  "card.painPoints": "用户痛点",
  "card.scope": "功能范围",
  "card.nonFunctional": "非功能要求",
  "card.constraints": "约束条件",
  "research.report": "调研报告",
  "research.user_stories": "用户故事",
  "research.features": "功能清单",
  "solution.doc": "方案文档",
  "prototype.structure": "原型结构",
  "prd.markdown": "需求文档",
  "decision.accepted": "条目决策",
  "knowledge.changed": "项目知识",
};

function sectionLabel(key: string): string {
  return SECTION_LABELS[key as SectionKey] ?? key;
}

function triggerLabel(t: string): string {
  return TRIGGER_LABELS[t] ?? t;
}

export interface StaleResult {
  changed: string[];
  unchanged: string[];
  escalated: boolean;
  version: number;
  mode: "targeted" | "full";
}

/** 读一段 SSE 响应直到结束。返回最后一次 change_update 的载荷。 */
async function consumeSse(
  res: Response,
  onProgress: (text: string) => void
): Promise<StaleResult | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buf = "";
  let result: StaleResult | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split("\n\n");
    buf = blocks.pop() ?? "";
    for (const block of blocks) {
      const eventLine = block.split("\n").find((l) => l.startsWith("event:"));
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice(6).trim();
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      if (event === "gen_message" && typeof payload.content === "string") {
        onProgress(payload.content);
      } else if (event === "change_update") {
        const dc = payload.devContext as Record<string, unknown> | undefined;
        if (dc) {
          result = {
            changed: (dc.changed ?? []) as string[],
            unchanged: (dc.unchanged ?? []) as string[],
            escalated: dc.escalated === true,
            version: (dc.version ?? 0) as number,
            mode: (dc.mode as "targeted" | "full") ?? "targeted",
          };
        }
      } else if (event === "error") {
        throw new Error(typeof payload.message === "string" ? payload.message : "重算失败");
      }
    }
  }
  return result;
}

export function DevContextStaleBar({
  requirementId,
  sections,
  reason,
  onDone,
}: {
  requirementId: string;
  /** 已过期的 section 键（中文名在组件内映射，避免调用方重复维护标签表）。 */
  sections: string[];
  /** { section: [trigger, ...] }，用于生成「因『约束』变更」tooltip。 */
  reason: Record<string, string[]>;
  /** 重算/清除完成后回调（父组件据此重新拉取 DC）。 */
  onDone: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<"" | "targeted" | "full" | "dismiss">("");
  const [progress, setProgress] = useState("");
  const [err, setErr] = useState("");
  const [result, setResult] = useState<StaleResult | null>(null);
  const [showAll, setShowAll] = useState(false);

  const url = `/api/requirements/${requirementId}/dev-context/refresh`;

  async function run(mode: "targeted" | "full") {
    setBusy(mode);
    setErr("");
    setProgress("");
    setResult(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, sections: mode === "targeted" ? sections : undefined }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setErr(j?.message || `重算请求失败（HTTP ${res.status}）`);
        return;
      }
      const r = await consumeSse(res, setProgress);
      if (r) setResult(r);
      await onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
      setProgress("");
    }
  }

  async function dismiss() {
    setBusy("dismiss");
    setErr("");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "dismiss" }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setErr(j?.message || `操作失败（HTTP ${res.status}）`);
        return;
      }
      setResult(null);
      await onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12.5px] font-medium text-amber-800">
          ● 可能已过期（{sections.length} 处）
          <span className="ml-1 font-normal text-amber-700">
            上游产物已变更，这些段落尚未重算
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => run("targeted")}
            disabled={!!busy}
            className="flex h-7 items-center gap-1 rounded-md bg-amber-500 px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
          >
            {busy === "targeted" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            重算这 {sections.length} 段
          </button>
          <button
            type="button"
            onClick={dismiss}
            disabled={!!busy}
            title="本次变更确认不影响开发上下文，直接清除过期标记"
            className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-50"
          >
            {busy === "dismiss" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <XCircle className="h-3.5 w-3.5" />
            )}
            标记为无需更新
          </button>
        </div>
      </div>

      {/* 逾期段落（带「因何过期」tooltip） */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {(showAll ? sections : sections.slice(0, 6)).map((s) => {
          const triggers = (reason[s] ?? []).map(triggerLabel);
          return (
            <span
              key={s}
              title={
                triggers.length
                  ? `因「${triggers.join("、")}」变更，此段可能已过期`
                  : "上游产物已变更，此段可能已过期"
              }
              className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[11px] text-amber-800 ring-1 ring-amber-200"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              {sectionLabel(s)}
            </span>
          );
        })}
        {sections.length > 6 && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] text-amber-700 hover:bg-amber-100"
          >
            {showAll ? "收起" : `+${sections.length - 6}`}
            <ChevronDown className="h-3 w-3" />
          </button>
        )}
      </div>

      {progress && (
        <div className="mt-2 flex items-center gap-1.5 text-[12px] text-amber-700">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {progress}
        </div>
      )}

      {err && (
        <div role="alert" className="mt-2 text-[12px] text-red-600">
          {err}
        </div>
      )}

      {result && (
        <div className="mt-2 text-[12px] text-amber-800">
          本次更新 {result.changed.length} 段，其余 {result.unchanged.length} 段未变（v
          {result.version}
          {result.escalated ? "，因一致性校验失败已扩大重算范围一次" : ""}）。
        </div>
      )}

      {/* 全部重算：折叠在「更多」里，避免与主按钮争夺注意力 */}
      <div className="mt-2">
        <button
          type="button"
          onClick={() => run("full")}
          disabled={!!busy}
          className="text-[11.5px] text-amber-700 underline-offset-2 hover:underline disabled:opacity-50"
        >
          {busy === "full" ? "正在全量重算…" : "不信任定向结果？全部重算"}
        </button>
      </div>
    </div>
  );
}
