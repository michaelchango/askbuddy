// DevContext 生成主循环（M2-B4）：与 PRD 同源并列、**独立非流式**通道。
// 流程：装配上游 → 调 AI（callAI）→ 抽 JSON → Zod 校验（失败重试 ≤2）→
//       完整度评分 + 一致性检查 → 决定 status → 落库。返回新版本号。
//
// 与 PRD 的关键差异：PRD 走 SSE 流式（runGeneration），DevContext 走 callAI 非流式，
// 不改 runGeneration（见 M2 设计 §「生成管线」）。
import { getPrompt } from "../prompts";
import { callAI } from "../client";
import { db } from "@/lib/db";
import type { ChatMessage } from "@/lib/ai/types";
import { extractDevContextJson } from "../parse";
import {
  DevContextBodySchema,
  SECTION_KEYS,
  type DevContextBody,
  type SectionKey,
} from "@/lib/schemas/devcontext";
import { buildStepContext } from "../context/builder";
import {
  completenessScore,
  checkConsistency,
  detectUpstreamSignals,
  type CompletenessReport,
  type ConsistencyIssue,
  type SourceResolvers,
} from "@/lib/services/devcontext-validate";
import { clearStale, getDevContext, saveDevContext } from "@/lib/services/devcontext";
import {
  ALL_SECTIONS,
  ALWAYS_RECOMPUTE,
  sortSections,
  type DevContextSection,
} from "@/lib/services/devcontext-impact";
import { filterKnowledgeIds } from "./knowledge-trace";

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
        knowledge: ctx.knowledge,
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

  // ①.5 幻觉 id 白名单过滤：_source.knowledge_ids 只保留本次注入集合内的 id，
  // 模型编造的知识 id 直接丢弃（否则溯源会打红 M3 校验）。
  body = filterKnowledgeIds(body, ctx.knowledge ?? []);

  // ② 三层校验：完整度 + 一致性（决定是否 confirmed）
  const signals = await detectUpstreamSignals(requirementId);
  const score: CompletenessReport = completenessScore(body, signals);
  // 注入默认 knowledgeExists resolver（校验 knowledge_ids 真实存在，允许 deprecated）。
  // 若调用方未提供完整 SourceResolvers，则补全 contextExists/maxConversationTurn 默认值。
  const base = opts.resolvers ?? {
    contextExists: async () => true,
    maxConversationTurn: async () => 0,
  };
  const resolvers: SourceResolvers = {
    ...base,
    knowledgeExists: base.knowledgeExists ?? (async (id: string) => {
      const row = await db.get("knowledge_entries", id).catch(() => null);
      return Boolean(row);
    }),
  };
  const issues: ConsistencyIssue[] = await checkConsistency(body, requirementId, resolvers);

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

// ═══════════════════════════════════════════════════════════════════════════
// M5-D2 定向重算：只重算受影响的那几段，其余段逐字节保留
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一致性规则 → 可能涉及的 section（升级重算时的并集来源）。
 *
 * 与 `devcontext-impact.ts` 的 SECTION_CLOSURE 同源：闭包回答「改了 A 要连带算谁」，
 * 这里回答「校验失败说明谁和谁对不上」。两条都源于同一组一致性规则。
 * 空数组 = 该规则不指向具体段（如溯源悬空），升级时兜底为全量内容段。
 */
const ISSUE_RULE_SECTIONS: Record<string, SectionKey[]> = {
  rule_ac_closure: ["business_rules", "acceptance_criteria"],
  feature_data_closure: ["feature_logic", "data_structures"],
  edge_feature_closure: ["edge_cases", "feature_logic"],
  source_validity: [],
  prd_correspondence: [],
};

export interface RegenerateSectionsResult {
  version: number;
  /** 本次实际重算的段（含 meta/references，值由纯代码重算）。 */
  changed: DevContextSection[];
  /** 逐字节保留的段。 */
  unchanged: DevContextSection[];
  /** 是否发生过「一致性失败 → 扩大范围重算一次」。 */
  escalated: boolean;
  status: "draft" | "confirmed";
}

export interface RegenerateSectionsOptions {
  changeNote?: string;
  trigger?: DevContextTrigger;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetry?: number;
  resolvers?: Parameters<typeof checkConsistency>[2];
}

/** 只保留 16 个内容段（meta/references 永远不走 LLM）。 */
function contentSectionsOf(sections: DevContextSection[]): SectionKey[] {
  const content = new Set<string>(SECTION_KEYS);
  return [...new Set(sections)].filter((s): s is SectionKey => content.has(s));
}

/** 取合并后 JSON 的「纯内容段」视图：Validator 的入参是 DevContextBodySchema（strict）。 */
function pickContentSections(
  content: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SECTION_KEYS) {
    if (content[k] !== undefined) out[k] = content[k];
  }
  return out;
}

/** 调模型生成指定的 section 子集（重试 + 超时，与全量生成同一套路）。 */
async function generateSectionSubset(
  requirementId: string,
  targets: SectionKey[],
  existingContent: Record<string, unknown>,
  opts: RegenerateSectionsOptions
): Promise<Record<string, unknown>> {
  const ctx = await buildStepContext(
    requirementId,
    "devcontext",
    opts.changeNote ? { changeNote: opts.changeNote } : undefined
  );
  const prompt = getPrompt("devcontext");

  // 只把「目标段 + 它们的现有内容」给模型：既省 token，也不给它重写别处的机会。
  const existingSubset: Record<string, unknown> = {};
  for (const s of targets) existingSubset[s] = existingContent[s] ?? null;

  const messages: ChatMessage[] = [
    { role: "system", content: prompt.system },
    {
      role: "user",
      content: prompt.buildUser({
        message: "",
        card: ctx.card,
        history: ctx.history,
        upstream: ctx.upstream,
        changeNote:
          opts.changeNote ??
          "上游产物已变更，请依据最新上游产物修正这些 section。",
        existingDoc: JSON.stringify(existingSubset, null, 2),
        knowledge: ctx.knowledge,
        sections: targets,
      }),
    },
  ];

  const timeoutMs =
    opts.timeoutMs ?? Number(process.env.DEVCONTEXT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const maxRetry = opts.maxRetry ?? Number(process.env.DEVCONTEXT_MAX_RETRY ?? DEFAULT_MAX_RETRY);

  let parsedBody: Record<string, unknown> | null = null;
  let lastErr: unknown = null;
  let prevController: AbortController | undefined;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    if (opts.signal?.aborted) throw new Error("DevContext 定向重算被外部取消（signal aborted）");
    prevController?.abort();
    const controller = new AbortController();
    prevController = controller;
    try {
      const res = await withTimeout(
        callAI("devcontext", messages, controller.signal),
        timeoutMs,
        controller
      );
      const json = extractDevContextJson(res.content);
      if (!json) throw new Error("无法从模型输出解析 DevContext JSON（缺少 ```json 围栏或合法对象）");
      const parsed = DevContextBodySchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(
          "DevContext Schema 校验失败：" +
            parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")
        );
      }
      parsedBody = parsed.data as Record<string, unknown>;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!parsedBody) {
    throw new Error(
      `DevContext 定向重算失败（已重试 ${maxRetry} 次）：${(lastErr as Error)?.message ?? String(lastErr)}`
    );
  }

  // 越权段直接丢弃：模型可能顺手多写（prompt 只是软约束，代码必须硬约束）
  const filtered: Record<string, unknown> = {};
  const allowed = new Set<string>(targets);
  for (const [k, v] of Object.entries(parsedBody)) {
    if (allowed.has(k)) filtered[k] = v;
    else console.warn(`[dc-regen] 丢弃越权 section：${k}（本次只重算 ${targets.join(",")}）`);
  }
  return filtered;
}

/**
 * 定向重算（M5-D2 · P2-4 核心）。
 *
 * 7 步：读现值 → 组装目标子集 → 调 Agent（只输出指定段）→ 逐段替换合并
 * （未列段**逐字节保留**，含其 `_source`）→ meta/references 纯代码重算 →
 * 三层校验（一致性失败**只升级一次**，再失败降 draft）→ 落库 + 快照 + 结构化 changelog。
 *
 * ⚠️ 合并是「逐 section 替换」而非深合并：深合并会把已删除的旧条目留下来，
 * 模型删掉一条规则而下游 AC 还在，正是三层校验要抓的矛盾。
 */
export async function regenerateSections(
  requirementId: string,
  sections: DevContextSection[],
  opts: RegenerateSectionsOptions = {}
): Promise<RegenerateSectionsResult> {
  const rec = await getDevContext(requirementId);
  if (!rec) {
    throw new Error("该需求还没有 DevContext，无法定向重算（请先做一次全量生成）");
  }
  const existing = rec.content as unknown as Record<string, unknown>;

  let targets = contentSectionsOf(sections);
  if (targets.length === 0) targets = [...SECTION_KEYS]; // 只给了 meta/references → 视为全量

  let escalated = false;
  let version = 0;
  let status: "draft" | "confirmed" = "draft";
  let merged: Record<string, unknown> = existing;
  let changedSections: DevContextSection[] = [];

  for (let round = 0; round < 2; round++) {
    const generated = await generateSectionSubset(requirementId, targets, existing, opts);
    merged = { ...existing, ...generated };

    const signals = await detectUpstreamSignals(requirementId);
    const bodyOnly = pickContentSections(merged);
    const score: CompletenessReport = completenessScore(bodyOnly as DevContextBody, signals);

    const base = opts.resolvers ?? {
      contextExists: async () => true,
      maxConversationTurn: async () => 0,
    };
    const resolvers: SourceResolvers = {
      ...base,
      knowledgeExists:
        base.knowledgeExists ??
        (async (id: string) => Boolean(await db.get("knowledge_entries", id).catch(() => null))),
    };
    const issues: ConsistencyIssue[] = await checkConsistency(
      bodyOnly as DevContextBody,
      requirementId,
      resolvers
    );

    const hasError = issues.some((i) => i.level === "error");
    if (!hasError || round === 1) {
      status = score.score >= CONFIRMED_THRESHOLD && !hasError ? "confirmed" : "draft";
      changedSections = sortSections([...targets, ...ALWAYS_RECOMPUTE]);

      const unchangedSections = sortSections(
        ALL_SECTIONS.filter((s) => !changedSections.includes(s))
      );
      // 版本快照里的 changelog = 结构化记录（验收标准「只有受影响 section 被重算」
      // 需要一个可读取的断言对象，而不是靠比对 content 字符串）
      const changelogDetail = {
        trigger: Object.fromEntries(
          targets.map((t) => [t, ["change_analysis"]])
        ),
        changed_sections: changedSections,
        unchanged_sections: unchangedSections,
        escalated,
        note: opts.changeNote ?? "",
      };

      version = await saveDevContext(
        requirementId,
        merged as DevContextBody,
        {
          score,
          issues,
          status,
          trigger: opts.trigger ?? "change_analysis",
          note: opts.changeNote,
          clearStale: false, // 只重算了部分段，交下面精确清理
          changelogDetail,
          // 只给被重算的段补填 conversation_turn：未受影响段的 _source 必须逐字节不变
          //（A1 验收标准；e2e 场景 02 会发现漏传——这正是它存在的意义）
          injectTurnsFor: targets,
        }
      );

      // 清掉本次已重算的段的失效标记；其余段仍然过期（maybe_stale 由剩余清单反推）
      await clearStale(requirementId, changedSections).catch(() => {});

      return { version, changed: changedSections, unchanged: unchangedSections, escalated, status };
    }

    // 一致性失败 → 把失败项涉及的段并入集合，**只升级一次**。
    // 无限升级只会烧 token（矛盾可能本就源于上游信息打架，那是 PM 的锅），
    // 第二次仍失败就降 draft 把决策交还给人——符合「不硬发」原则。
    escalated = true;
    const fromIssues = issues.flatMap((i) => ISSUE_RULE_SECTIONS[i.rule] ?? []);
    const widened = contentSectionsOf([...(fromIssues as DevContextSection[])]);
    targets = widened.length > 0 ? [...new Set([...targets, ...widened])] : [...SECTION_KEYS];
    console.warn(
      `[dc-regen] 一致性校验失败，升级重算一次：${targets.join("、")}（失败项 ${issues
        .filter((i) => i.level === "error")
        .map((i) => i.rule)
        .join("、")}）`
    );
  }

  // 理论不可达（循环内必 return）；保留以让 TS 控制流闭合
  return {
    version,
    changed: changedSections,
    unchanged: [],
    escalated,
    status,
  };
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
