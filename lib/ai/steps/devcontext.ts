// DevContext 生成主循环（M2-B4）：与 PRD 同源并列、**独立非流式**通道。
// 流程：装配上游 → 调 AI（callAI）→ 抽 JSON → Zod 校验（失败重试 ≤2）→
//       完整度评分 + 一致性检查 → 决定 status → 落库。返回新版本号。
//
// 与 PRD 的关键差异：PRD 走 SSE 流式（runGeneration），DevContext 走 callAI 非流式，
// 不改 runGeneration（见 M2 设计 §「生成管线」）。
import { getPrompt } from "../prompts";
import { callAI } from "../client";
import type { ChatMessage } from "@/lib/ai/types";
import { extractDevContextJson } from "../parse";
import { DevContextBodySchema, type DevContextBody, type SectionKey } from "@/lib/schemas/devcontext";
import { buildStepContext } from "../context/builder";
import {
  completenessScore,
  checkConsistency,
  detectUpstreamSignals,
  type CompletenessReport,
  type ConsistencyIssue,
} from "@/lib/services/devcontext-validate";
import { saveDevContext } from "@/lib/services/devcontext";

export type DevContextTrigger = "prd_writing" | "manual" | "change_analysis";

export interface RunDevContextOptions {
  /** 触发来源（决定 meta.changelog.trigger）。默认 manual。 */
  trigger?: DevContextTrigger;
  /** 变更模式说明（存在则进入「基于现有 DevContext 精准修改」）。 */
  changeNote?: string;
  /** 覆盖默认超时（ms）。 */
  timeoutMs?: number;
  /** 覆盖默认最大重试次数（≤2）。 */
  maxRetry?: number;
  /** 覆盖默认一致性检查 resolver（M3/M4 注入）。 */
  resolvers?: Parameters<typeof checkConsistency>[2];
  /** 外部传入的 AbortSignal（SSE 客户端断开时调用 abort）。 */
  signal?: AbortSignal;
}

/** Promise 超时包裹：超时抛错并 abort，触发重试。 */
function withTimeout<T>(p: Promise<T>, ms: number, controller?: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller?.abort(); // 取消底层流式请求，避免后台泄漏 + 惊群
      reject(new Error(`DevContext 生成超时（>${ms}ms）`));
    }, ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

const DEFAULT_TIMEOUT_MS = 180_000; // hy3-preview 生成大结构化 JSON 通常需 60~120s，留余量
const DEFAULT_MAX_RETRY = 2;
const CONFIRMED_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// 后台任务集中调度：消除「孤儿」DevContext 任务
//
// 历史问题：prd/route.ts 与 conversation/route.ts 用 `void runDevContextGeneration(...)`
// fire-and-forget 触发后台 DC 生成。如果用户在 DC 生成期间切走页面或重启 dev server，
// 这个 fire-and-forget 的 Promise 仍在后台跑，继续吃 token 槽位 + 数据库连接，
// 30~180s 内没人能主动停它（直到超时/失败），造成连接池被多个孤儿任务挤占。
//
// 修复：
// 1. 模块级 Map<requirementId, Promise<number>> 集中管理正在飞的 DC 任务
// 2. 同一 requirementId 并发触发时，**复用现有 Promise**（不再开新任务）——
//    语义正确：用户在 PRD 完成后立即点重新生成，没必要同时跑两份 DC
// 3. SSE route 在客户端断开时调用 abortDcGen(id)，立即取消任务、释放所有 token
// 4. 自动 TTL（5 分钟）兜底，防止外部 caller 异常退出后 Map 永远不释放
// ---------------------------------------------------------------------------
interface DcTaskEntry {
  promise: Promise<number>;
  controller: AbortController;
  startedAt: number;
}
const dcTaskRegistry = new Map<string, DcTaskEntry>();

const DC_TASK_MAX_AGE_MS = 5 * 60 * 1000; // 5 分钟自动清理

/**
 * 启动或复用后台 DC 任务。同一 requirementId 在飞期间再次触发，返回现有 Promise。
 * 新建任务时同时注册 AbortController，方便外部主动取消。
 */
export function scheduleDevContextGeneration(
  requirementId: string,
  opts: RunDevContextOptions = {}
): { promise: Promise<number>; controller: AbortController } {
  // 1. 清理过期孤儿
  const now = Date.now();
  for (const [k, entry] of dcTaskRegistry) {
    if (now - entry.startedAt > DC_TASK_MAX_AGE_MS) {
      entry.controller.abort();
      dcTaskRegistry.delete(k);
    }
  }

  // 2. 复用现有 in-flight 任务
  const existing = dcTaskRegistry.get(requirementId);
  if (existing) {
    return { promise: existing.promise, controller: existing.controller };
  }

  // 3. 新建任务：注册 controller + 任务结束后自动注销
  const controller = new AbortController();
  const promise = runDevContextGeneration(requirementId, {
    ...opts,
    signal: controller.signal, // 外部 controller 的 signal 透传
  })
    .finally(() => {
      dcTaskRegistry.delete(requirementId);
    });
  dcTaskRegistry.set(requirementId, { promise, controller, startedAt: now });
  return { promise, controller };
}

/**
 * 主动取消某个 requirementId 的 in-flight DC 任务。
 * SSE route 在客户端断开时调用，立即释放 token + 数据库连接。
 */
export function abortDcGen(requirementId: string): boolean {
  const entry = dcTaskRegistry.get(requirementId);
  if (!entry) return false;
  entry.controller.abort();
  dcTaskRegistry.delete(requirementId);
  return true;
}

/** 调试用：列出所有 in-flight DC 任务。 */
export function listDcGenTasks(): Array<{ requirementId: string; startedAt: number; ageMs: number }> {
  const now = Date.now();
  return Array.from(dcTaskRegistry.entries()).map(([requirementId, entry]) => ({
    requirementId,
    startedAt: entry.startedAt,
    ageMs: now - entry.startedAt,
  }));
}

/**
 * 生成一份 DevContext 并落库。失败（JSON 抽不出 / Schema 校验不过）时重试 ≤ maxRetry 次。
 * 全部失败则抛错（不落库脏数据）。
 */
export async function runDevContextGeneration(
  requirementId: string,
  opts: RunDevContextOptions = {}
): Promise<number> {
  const trigger = opts.trigger ?? "manual";
  const timeoutMs = opts.timeoutMs ?? Number(process.env.DEVCONTEXT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const maxRetry = opts.maxRetry ?? Number(process.env.DEVCONTEXT_MAX_RETRY ?? DEFAULT_MAX_RETRY);

  const ctx = await buildStepContext(
    requirementId,
    "devcontext",
    opts.changeNote ? { changeNote: opts.changeNote } : undefined
  );
  const prompt = getPrompt("devcontext");

  const messages: ChatMessage[] = [
    { role: "system", content: prompt.system },
    {
      role: "user",
      content: prompt.buildUser({
        message: "",
        card: ctx.card,
        history: ctx.history,
        upstream: ctx.upstream,
        changeNote: opts.changeNote,
        existingDoc: ctx.existingDoc,
      }),
    },
  ];

  // ① 生成 + 解析 + Zod 校验（重试，每次超时自动 abort 上一次）
  let body: DevContextBody | null = null;
  let lastErr: unknown = null;
  let prevController: AbortController | undefined;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    // 外部 signal 已 abort → 立即终止，不重试
    if (opts.signal?.aborted) throw new Error("DevContext 生成被外部取消（signal aborted）");
    // 确保上一次的流已取消（避免并发多路抢占模型配额）
    prevController?.abort();
    const controller = new AbortController();
    prevController = controller;
    try {
      const res = await withTimeout(callAI("devcontext", messages, controller.signal), timeoutMs, controller);
      const json = extractDevContextJson(res.content);
      if (!json) throw new Error("无法从模型输出解析 DevContext JSON（缺少 ```json 围栏或合法对象）");
      const parsed = DevContextBodySchema.safeParse(json);
      if (!parsed.success) {
        throw new Error("DevContext Schema 校验失败：" + parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
      }
      body = parsed.data;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!body) {
    throw new Error(`DevContext 生成失败（已重试 ${maxRetry} 次）：${(lastErr as Error)?.message ?? String(lastErr)}`);
  }

  // ② 三层校验：完整度 + 一致性（决定是否 confirmed）
  const signals = await detectUpstreamSignals(requirementId);
  const score: CompletenessReport = completenessScore(body, signals);
  const issues: ConsistencyIssue[] = await checkConsistency(body, requirementId, opts.resolvers);

  const hasError = issues.some((i) => i.level === "error");
  const status: "draft" | "confirmed" =
    score.score >= CONFIRMED_THRESHOLD && !hasError ? "confirmed" : "draft";

  // ③ 落库（+ 二次 Schema 校验在 saveDevContext 内）
  const version = await saveDevContext(requirementId, body, {
    score,
    issues,
    status,
    trigger,
    note: opts.changeNote,
  });

  return version;
}

/** 仅做评分/一致性（不落库），供 UI 预览或调试。 */
export async function previewDevContextScoring(
  requirementId: string,
  body: DevContextBody
): Promise<{ score: CompletenessReport; issues: ConsistencyIssue[]; status: "draft" | "confirmed"; applicable: SectionKey[] }> {
  const signals = await detectUpstreamSignals(requirementId);
  const score = completenessScore(body, signals);
  const issues = await checkConsistency(body, requirementId);
  const hasError = issues.some((i) => i.level === "error");
  const status: "draft" | "confirmed" = score.score >= CONFIRMED_THRESHOLD && !hasError ? "confirmed" : "draft";
  return { score, issues, status, applicable: score.applicable };
}
