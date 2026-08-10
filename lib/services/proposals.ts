// M3 · 条目级 HITL 建议卡服务（核心协调层）。
//
// 把 AskBuddy 的「AI 只建议、不写资产、人逐条 accept/edit/ignore」语义适配到
// PRDHub/AskBuddy 基座（lib/db 门面 + 既有 outputs/prototypes 落库函数）。
//
// 数据流（改造后）：
//   AI 生成内容 → createProposal(...) 写 suggestions(pending) + SSE 下发 proposal
//   → 用户决策 → respondProposal(...)：
//       accept/edit → 写产物(落库) + 写 doc_sections/页面 _source + 写 changelog + 记 decisions
//       ignore     → 仅落 decisions(summary='ignored')，不写任何产物（红线）
//
// AD-1：所有读写经 lib/db 门面。
// AD-4：本服务只管「条目级闸门」，阶段级 awaitingConfirm 由 steps.ts 单独管理。

import crypto from "crypto";
import { db } from "@/lib/db";
import { nextStepOf } from "@/lib/steps-meta";
import {
  saveResearchAnalysis,
  saveSolution,
  savePRD,
} from "@/lib/services/outputs";
import { savePrototypeVersion, type PrototypeStructure } from "@/lib/services/prototypes";
import type { ResearchAnalysisOutput } from "@/lib/ai/types";
import { getConversationTurn } from "@/lib/services/conversations";

// ---------------- 类型 ----------------

/** 建议作用的目标产物类型（与 M3 §B.4 一致）。 */
export type ProposalTargetType =
  | "research"
  | "solution"
  | "prototype"
  | "prd"
  | "dev_context";

export type ProposalOp = "add" | "modify" | "remove";
export type ProposalStatus = "pending" | "accepted" | "edited" | "ignored";
export type ProposalDecision = "accept" | "edit" | "ignore";

/** 统一 _source 结构（AD-3，四级产物通用；见 M3 §B.5）。 */
export interface ProposalSource {
  conversation_turn?: number | null;
  decision_id?: string | null;
  knowledge_ids?: string[];
  confirmed_by?: string;
  confirmed_at?: string | null;
}

/** 结构化变更记录（M3 §B.9）。 */
export interface ChangelogEntry {
  suggestion_id: string;
  decision_id: string | null;
  op: ProposalOp;
  target_type: ProposalTargetType;
  target_path: string | null;
  summary: string;
  conversation_turn: number | null;
  confirmed_by: string;
  confirmed_at: string;
}

/** 各 target_type 的建议内容负载。 */
export type ProposalPayload =
  | { report?: string; userStories?: unknown[]; features?: unknown[] } // research
  | { doc?: string } // solution
  | { markdown?: string } // prd
  | { html?: string; structure?: unknown; model?: string }; // prototype

export interface SuggestionRow {
  id: string;
  requirement_id: string;
  target_type: ProposalTargetType;
  target_path: string | null;
  op: ProposalOp;
  payload: ProposalPayload;
  status: ProposalStatus;
  source: ProposalSource | null;
  created_at: string;
}

// ---------------- 内部辅助 ----------------

const VERSION_TABLE: Record<ProposalTargetType, string> = {
  research: "research_analysis_versions",
  solution: "solution_versions",
  prd: "prd_versions",
  prototype: "prototype_versions",
  dev_context: "dev_context_versions",
};

/** target_type → 四步工作流的阶段（用于阶段闸门与 HITL 共存校准）。 */
const TARGET_STEP: Record<ProposalTargetType, string> = {
  research: "research_analysis",
  solution: "design",
  prototype: "design",
  prd: "prd_writing",
  dev_context: "prd_writing", // DevContext 在 PRD 之后生成，复用同一阶段归属
};

/** 把 markdown 按 h2 切分为章节，返回锚点与标题（锚点公式与 markdown-renderer 的 slug 一致）。 */
function splitMarkdownSections(md: string): Array<{ anchor: string; title: string }> {
  const out: Array<{ anchor: string; title: string }> = [];
  const lines = md.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (m && m[1].length === 2) {
      const title = m[2].trim();
      const anchor = title.replace(/\s+/g, "-");
      out.push({ anchor, title });
    }
    i++;
  }
  return out;
}

function slugifyHeading(text: string): string {
  return text.trim().replace(/\s+/g, "-");
}

/** 把 payload 落库为对应产物，返回新版本号。 */
async function applyPayload(
  targetType: ProposalTargetType,
  requirementId: string,
  payload: ProposalPayload
): Promise<number | null> {
  switch (targetType) {
    case "research": {
      const p = payload as { report?: string; userStories?: unknown[]; features?: unknown[] };
      return await saveResearchAnalysis(requirementId, {
        report: p.report ?? "",
        userStories: (p.userStories as ResearchAnalysisOutput["userStories"]) ?? [],
        features: (p.features as ResearchAnalysisOutput["features"]) ?? [],
      });
    }
    case "solution": {
      const p = payload as { doc?: string };
      return await saveSolution(requirementId, p.doc ?? "");
    }
    case "prd": {
      const p = payload as { markdown?: string };
      return await savePRD(requirementId, p.markdown ?? "");
    }
    case "prototype": {
      const p = payload as { html?: string; structure?: unknown; model?: string };
      const r = await savePrototypeVersion(requirementId, {
        html: p.html ?? "",
        structure: (p.structure as PrototypeStructure | null) ?? null,
        model: p.model,
      });
      return r.version;
    }
    default:
      return null;
  }
}

/** 接受后把 _source 与 changelog 落到产物（AD-3 分级溯源）。 */
async function attachSource(
  targetType: ProposalTargetType,
  requirementId: string,
  version: number | null,
  payload: ProposalPayload,
  source: ProposalSource,
  changelog: ChangelogEntry[]
): Promise<void> {
  // 1) MD 章节级溯源（research / solution / prd）：正文保持纯净，anchor→source 写 doc_sections。
  if (targetType === "research" || targetType === "solution" || targetType === "prd") {
    const md =
      targetType === "research"
        ? ((payload as { report?: string }).report ?? "")
        : targetType === "solution"
        ? ((payload as { doc?: string }).doc ?? "")
        : ((payload as { markdown?: string }).markdown ?? "");
    if (md) {
      const sections = splitMarkdownSections(md);
      for (const s of sections) {
        await db
          .insert("doc_sections", {
            id: crypto.randomUUID(),
            requirement_id: requirementId,
            target_type: targetType,
            version,
            anchor: s.anchor,
            title: s.title,
            source,
          })
          .catch(() => {});
      }
    }
  }

  // 2) 原型页面级溯源：structure.pages[] 每页挂 _source。
  if (targetType === "prototype" && version != null) {
    const row = await db.get<{ structure?: { pages?: unknown[] } }>(
      "prototype_versions",
      `${requirementId}-v${version}`
    );
    const pages = row?.structure?.pages;
    if (Array.isArray(pages)) {
      const newPages = pages.map((p) =>
        typeof p === "object" && p !== null ? { ...(p as Record<string, unknown>), _source: source } : p
      );
      await db
        .update("prototype_versions", `${requirementId}-v${version}`, {
          structure: { ...(row?.structure ?? {}), pages: newPages },
        })
        .catch(() => {});
    }
  }

  // 3) 结构化变更记录：写对应版本表的 changelog 列。
  if (version != null) {
    await db
      .updateWhere(VERSION_TABLE[targetType], { requirement_id: requirementId, version }, { changelog })
      .catch(() => {});
  }
}

// ---------------- 对外 API ----------------

export interface CreateProposalInput {
  requirementId: string;
  targetType: ProposalTargetType;
  targetPath?: string | null;
  op: ProposalOp;
  payload: ProposalPayload;
  /** 产生此建议的对话轮次（来自 conversations 序）。不传则自动推算。 */
  conversationTurn?: number;
  confirmedBy?: string;
}

/** 创建一条 pending 建议（AI 产出先落 suggestions，不写产物）。 */
export async function createProposal(input: CreateProposalInput): Promise<string> {
  const turn =
    input.conversationTurn ??
    (await getConversationTurn(input.requirementId).catch(() => null)) ??
    null;
  const source: ProposalSource = {
    conversation_turn: turn,
    decision_id: null,
    knowledge_ids: [],
    confirmed_by: input.confirmedBy ?? "user",
    confirmed_at: null,
  };
  const row: SuggestionRow = {
    id: crypto.randomUUID(),
    requirement_id: input.requirementId,
    target_type: input.targetType,
    target_path: input.targetPath ?? null,
    op: input.op,
    payload: input.payload,
    status: "pending",
    source,
    created_at: new Date().toISOString(),
  };
  await db.insert("suggestions", row);
  return row.id;
}

export interface RespondProposalInput {
  suggestionId: string;
  decision: ProposalDecision;
  /** edit 决策携带的已编辑负载（覆盖原 payload）。 */
  editedPayload?: ProposalPayload;
  confirmedBy?: string;
}

export interface RespondProposalResult {
  action: ProposalDecision;
  targetType: ProposalTargetType;
  version: number | null;
  decisionId: string;
  step: string;
  /** 该阶段是否还有未决建议（用于阶段闸门共存）。 */
  stageResolved: boolean;
}

/** 响应用户对某条建议的决策（accept/edit/ignore）。 */
export async function respondProposal(input: RespondProposalInput): Promise<RespondProposalResult> {
  const sug = await db.get<SuggestionRow>("suggestions", input.suggestionId);
  if (!sug) throw new Error("建议不存在");
  if (sug.status !== "pending") throw new Error("该建议已被响应");

  const confirmedBy = input.confirmedBy ?? sug.source?.confirmed_by ?? "user";
  const confirmedAt = new Date().toISOString();
  const decisionId = crypto.randomUUID();

  // 记决策（ignore 仅此一步，不写产物）
  await db.insert("decisions", {
    id: decisionId,
    requirement_id: sug.requirement_id,
    suggestion_id: sug.id,
    summary: input.decision === "ignore" ? "ignored" : null,
    conversation_turn: sug.source?.conversation_turn ?? null,
    confirmed_by: confirmedBy,
    confirmed_at: confirmedAt,
  });

  if (input.decision === "ignore") {
    await db.update("suggestions", sug.id, { status: "ignored" });
    const stageResolved = await isStageResolved(sug.target_type, sug.requirement_id);
    return {
      action: "ignore",
      targetType: sug.target_type,
      version: null,
      decisionId,
      step: TARGET_STEP[sug.target_type],
      stageResolved,
    };
  }

  // accept / edit：用有效负载写产物
  const effective = input.decision === "edit" && input.editedPayload ? input.editedPayload : sug.payload;
  const source: ProposalSource = {
    ...(sug.source ?? {}),
    decision_id: decisionId,
    confirmed_by: confirmedBy,
    confirmed_at: confirmedAt,
  };
  const version = await applyPayload(sug.target_type, sug.requirement_id, effective);
  const changelog: ChangelogEntry[] = [
    {
      suggestion_id: sug.id,
      decision_id: decisionId,
      op: sug.op,
      target_type: sug.target_type,
      target_path: sug.target_path,
      summary: buildSummary(sug.target_type, sug.op, input.decision),
      conversation_turn: source.conversation_turn ?? null,
      confirmed_by: confirmedBy,
      confirmed_at: confirmedAt,
    },
  ];
  await attachSource(sug.target_type, sug.requirement_id, version, effective, source, changelog);

  await db.update("suggestions", sug.id, { status: input.decision === "edit" ? "edited" : "accepted" });
  const stageResolved = await isStageResolved(sug.target_type, sug.requirement_id);
  return {
    action: input.decision,
    targetType: sug.target_type,
    version,
    decisionId,
    step: TARGET_STEP[sug.target_type],
    stageResolved,
  };
}

/** 批量接受某需求下所有 pending 建议（R7「全部接受」缓解）。 */
export async function bulkAccept(requirementId: string, confirmedBy = "user"): Promise<number> {
  const pending = await listSuggestions(requirementId, "pending");
  let count = 0;
  for (const s of pending) {
    await respondProposal({ suggestionId: s.id, decision: "accept", confirmedBy }).catch(() => {});
    count++;
  }
  return count;
}

/** 列出某需求的建议（可按状态过滤）。 */
export async function listSuggestions(
  requirementId: string,
  status?: ProposalStatus
): Promise<SuggestionRow[]> {
  const all = await db.findMany<SuggestionRow>("suggestions", {
    where: { requirement_id: { eq: requirementId } },
    orderBy: [["created_at", "asc"]],
  });
  return status ? all.filter((s) => s.status === status) : all;
}

/** 某阶段是否还有未决建议（阶段闸门共存判定）。 */
export async function isStageResolved(
  targetType: ProposalTargetType,
  requirementId: string
): Promise<boolean> {
  const step = TARGET_STEP[targetType];
  const pending = await listSuggestions(requirementId, "pending");
  const remaining = pending.filter((s) => TARGET_STEP[s.target_type] === step);
  return remaining.length === 0;
}

function buildSummary(
  targetType: ProposalTargetType,
  op: ProposalOp,
  decision: ProposalDecision
): string {
  const label: Record<ProposalTargetType, string> = {
    research: "调研报告",
    solution: "方案文档",
    prototype: "交互原型",
    prd: "需求文档",
    dev_context: "开发上下文",
  };
  const verb = op === "remove" ? "移除" : op === "modify" ? "更新" : "新增";
  return `${decision === "edit" ? "编辑后" : ""}${verb}${label[targetType]}`;
}

// ---------------- 阶段闸门（AD-4 共存） ----------------

/** 某 target_type 的建议全部决策后，构造对应的「确认闸门」proceed_prompt 负载。 */
export interface ProceedPrompt {
  step: string;
  nextStep: string | null;
  subPhase?: string;
  canSkip: boolean;
  message: string;
  version: number | null;
}

const STAGE_LABEL: Record<ProposalTargetType, string> = {
  research: "调研分析",
  solution: "方案文档",
  prototype: "交互原型",
  prd: "需求文档",
  dev_context: "开发上下文",
};

export function buildProceedPrompt(
  targetType: ProposalTargetType,
  version: number | null
): ProceedPrompt | null {
  const step = TARGET_STEP[targetType];
  if (targetType === "solution") {
    // 方案文档确认后进入「原型设计」子阶段（不标记 design 完成）
    return {
      step: "design",
      nextStep: null,
      subPhase: "prototype",
      canSkip: false,
      message: `${STAGE_LABEL.solution}已确认，请进入原型设计。`,
      version,
    };
  }
  if (targetType === "prototype") {
    return {
      step: "design",
      nextStep: nextStepOf("design"),
      canSkip: false,
      message: `${STAGE_LABEL.prototype}已确认，请进入需求文档阶段。`,
      version,
    };
  }
  return {
    step,
    nextStep: nextStepOf(step as Parameters<typeof nextStepOf>[0]),
    canSkip: false,
    message: `${STAGE_LABEL[targetType] ?? "产物"}已确认。`,
    version,
  };
}

/** 列出该需求下「已无 pending 建议」的阶段对应的 proceed_prompt（供全部接受后批量弹出闸门）。 */
export async function resolvedStagePrompts(requirementId: string): Promise<ProceedPrompt[]> {
  const pending = await listSuggestions(requirementId, "pending");
  const all = await listSuggestions(requirementId);
  const resolved = new Set<ProposalTargetType>();
  for (const s of all) {
    if (!pending.some((p) => p.target_type === s.target_type)) resolved.add(s.target_type);
  }
  const prompts: ProceedPrompt[] = [];
  for (const t of resolved) {
    const p = buildProceedPrompt(t, null);
    if (p) prompts.push(p);
  }
  return prompts;
}

export { slugifyHeading };
