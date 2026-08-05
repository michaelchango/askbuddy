"use client";

import { useEffect, useRef, useState } from "react";
import type { StepName } from "@/types";
import useSWR from "swr";
import { api } from "@/lib/api/client";
import { EVT } from "@/lib/events";
import { Button } from "@/components/ui/button";

interface Version {
  version: number;
  note?: string;
  created_at?: string;
  structure?: { pages: Array<{ id: string; title: string }> } | null;
}

interface PrototypeData {
  exists: boolean;
  html: string;
  version: number | null;
  structure: { pages: Array<{ id: string; title: string }> } | null;
}

// 读取 SSE 流：每个 delta 事件推送当前完整 HTML；done 事件返回版本与结构。
async function streamPost(
  url: string,
  body: Record<string, unknown>,
  onDelta: (full: string) => void,
  onProceed?: (p: {
    nextStep: StepName | null;
    canSkip: boolean;
    message: string;
    version?: number;
  }) => void,
  requirementId?: string,
  signal?: AbortSignal
): Promise<{ version?: number; structure?: PrototypeData["structure"] }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.body) throw new Error("无可用数据流");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result: { version?: number; structure?: PrototypeData["structure"] } = {};
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop() ?? "";
    for (const evt of events) {
      const ev = evt.match(/^event: (.+)$/m);
      const dm = evt.match(/^data: ([\s\S]*)$/m);
      if (!dm) continue;
      const payload = JSON.parse(dm[1]);
      if (ev && ev[1] === "delta") onDelta(payload as string);
      else if (ev && ev[1] === "done") result = payload;
      else if (ev && ev[1] === "error") throw new Error(payload?.message || "生成失败");
      else if (ev && ev[1] === "proceed_prompt") {
        // 原型属于方案设计的子阶段：生成/修改完成后回传确认闸门给壳层
        onProceed?.({
          nextStep: (payload?.nextStep as StepName | null) ?? null,
          canSkip: !!payload?.canSkip,
          message: (payload?.message as string) ?? "",
          version: payload?.version as number | undefined,
        });
      } else if (ev && ev[1] === "gen_message") {
        // 服务端已落库，此处仅实时转发到对话面板回显
        window.dispatchEvent(
          new CustomEvent(EVT.GEN_MESSAGE, {
            detail: { content: (payload as { content: string }).content, requirementId },
          })
        );
      }
    }
  }
  return result;
}

export function PrototypePanel({
  requirementId,
  onProceed,
}: {
  requirementId: string;
  onProceed?: (p: {
    nextStep: StepName | null;
    canSkip: boolean;
    message: string;
    version?: number;
  }) => void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [structure, setStructure] = useState<PrototypeData["structure"]>(null);
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);
  const [genMsg, setGenMsg] = useState("");
  const [editMsg, setEditMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  // 生成流的 AbortController，组件卸载时中止后台 SSE
  const genAbortRef = useRef<AbortController | null>(null);

  // 组件卸载时中止仍在后台运行的原型生成流
  useEffect(() => {
    return () => {
      genAbortRef.current?.abort();
      genAbortRef.current = null;
    };
  }, []);

  const { data: versions, mutate } = useSWR<Version[]>(
    `/api/requirements/${requirementId}/prototype/versions`,
    (u: string) => api<Version[]>(u)
  );

  async function preview() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<PrototypeData>(
        `/api/requirements/${requirementId}/prototype`
      );
      setHtml(r.html || null);
      setStructure(r.structure || null);
      setCurrentVersion(r.version);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    genAbortRef.current = controller;
    try {
      const res = await streamPost(
        `/api/requirements/${requirementId}/prototype`,
        { message: genMsg },
        setHtml,
        onProceed,
        requirementId,
        controller.signal
      );
      if (res.version) {
        setStructure(res.structure || null);
        setCurrentVersion(res.version);
        await mutate();
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      genAbortRef.current = null;
      setBusy(false);
    }
  }

  async function modify() {
    if (!editMsg.trim()) return;
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    genAbortRef.current = controller;
    try {
      const res = await streamPost(
        `/api/requirements/${requirementId}/prototype/edit`,
        { message: editMsg, baseVersionId: currentVersion ?? undefined },
        setHtml,
        onProceed,
        requirementId,
        controller.signal
      );
      if (res.version) {
        setStructure(res.structure || null);
        setCurrentVersion(res.version);
        setEditMsg("");
        await mutate();
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      genAbortRef.current = null;
      setBusy(false);
    }
  }

  async function share() {
    try {
      const r = await api<{ token: string; url: string }>(
        `/api/requirements/${requirementId}/prototype/share`,
        { method: "POST" }
      );
      const full = `${window.location.origin}${r.url}`;
      await navigator.clipboard?.writeText(full);
      setShareUrl(full);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function restore(version: number) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/requirements/${requirementId}/prototype/restore`, {
        method: "POST",
        body: JSON.stringify({ version }),
      });
      await preview();
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={generate} disabled={busy}>
          {busy ? "生成中…" : "生成原型"}
        </Button>
        <Button
          variant="outline"
          onClick={preview}
          disabled={busy || !versions?.length}
        >
          预览当前
        </Button>
        <Button variant="outline" onClick={share} disabled={busy}>
          分享链接
        </Button>
        <div className="ml-auto flex items-center gap-1 text-sm">
          <span className="text-muted-foreground">导出：</span>
          <a
            className="text-primary underline-offset-2 hover:underline"
            href={`/api/requirements/${requirementId}/prototype/export?format=html`}
            target="_blank"
            rel="noreferrer"
          >
            HTML
          </a>
          <span className="text-muted-foreground">/</span>
          <a
            className="text-primary underline-offset-2 hover:underline"
            href={`/api/requirements/${requirementId}/prototype/export?format=json`}
          >
            JSON
          </a>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <input
          value={genMsg}
          onChange={(e) => setGenMsg(e.target.value)}
          placeholder="生成时的额外要求（可选），如：增加设置页、配色改为蓝色"
          className="rounded border px-3 py-2 text-sm"
        />
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </div>
      )}

      {shareUrl && (
        <div className="rounded border bg-muted px-3 py-2 text-sm">
          分享链接已复制：
          <a className="ml-1 text-primary underline" href={shareUrl} target="_blank" rel="noreferrer">
            {shareUrl}
          </a>
        </div>
      )}

      {html && (
        <iframe
          sandbox="allow-scripts allow-forms allow-popups allow-modals"
          title="prototype"
          className="h-[520px] w-full rounded border bg-white"
          srcDoc={html}
        />
      )}

      {structure?.pages?.length ? (
        <div>
          <h3 className="mb-1 text-sm font-medium">页面结构</h3>
          <div className="flex flex-wrap gap-2">
            {structure.pages.map((p) => (
              <span
                key={p.id}
                className="rounded-full border px-3 py-1 text-xs text-muted-foreground"
              >
                {p.title}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div>
        <h3 className="mb-2 text-sm font-medium">对话式修改</h3>
        <div className="flex gap-2">
          <input
            value={editMsg}
            onChange={(e) => setEditMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) modify();
            }}
            placeholder="例如：把顶部导航改成深色、列表项增加头像"
            className="flex-1 rounded border px-3 py-2 text-sm"
          />
          <Button onClick={modify} disabled={busy || !versions?.length}>
            应用修改
          </Button>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium">版本历史</h3>
        <div className="space-y-1">
          {versions?.map((v) => (
            <div
              key={v.version}
              className="flex items-center justify-between rounded border px-3 py-2 text-sm"
            >
              <span>
                v{v.version} · {v.note || "—"}
                {currentVersion === v.version ? "（当前）" : ""}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => restore(v.version)}
                disabled={busy}
              >
                回退
              </Button>
            </div>
          ))}
          {versions && versions.length === 0 && (
            <div className="text-sm text-muted-foreground">暂无版本</div>
          )}
        </div>
      </div>
    </div>
  );
}
