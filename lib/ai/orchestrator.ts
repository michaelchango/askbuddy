// Orchestrator（v2 泛化步骤管线）：组装上下文 → 取 prompt → 流式生成 → 解析 → 派发写回。
import { getPrompt } from "./prompts";
import { buildStepContext } from "./context/builder";
import { streamAI, callAI } from "./client";
import { extractReplyAndCard, extractResearchAnalysis, extractMarkdown } from "./parse";
import { saveCardConnector } from "./connectors/internal/save-card";
import { getOutput, saveResearchAnalysis, saveSolution, savePRD, type OutputType } from "@/lib/services/outputs";
import { listConversations, getConversationTurn } from "@/lib/services/conversations";
import { extractCardPrompt } from "./prompts/extract-card";
import {
  createProposal,
  type ProposalTargetType,
  type ProposalOp,
  type ProposalPayload,
} from "@/lib/services/proposals";
import type { ChatMessage, RequirementCardData } from "./types";
import type { AITaskType } from "./models";

export interface ChatReference {
  type: OutputType;
  label: string;
  version: number;
}

// ---- 对话任务（交互式，保留引用链） ----

export async function streamDialogue(
  requirementId: string,
  message: string,
  references: ChatReference[] = []
): Promise<ReadableStream<string>> {
  // 解析被引用的输出物内容
  const refBlocks: string[] = [];
  for (const ref of references) {
    try {
      const out = await getOutput(requirementId, ref.type, ref.version);
      const body =
        out.contentType === "card"
          ? `需求卡片：${JSON.stringify(out.card ?? {}, null, 2)}`
          : out.content ?? "";
      refBlocks.push(`【引用：${ref.label} v${ref.version}】\n${body.slice(0, 6000)}`);
    } catch { /* 引用读取失败不阻断主对话 */ }
  }

  const prompt = getPrompt("dialoguing");
  const ctx = await buildStepContext(requirementId, "dialoguing", { message });

  const messages: ChatMessage[] = [
    { role: "system", content: prompt.system },
    ...(ctx.history ?? []).map((h) => ({ role: h.role as "user" | "assistant", content: h.content })),
    {
      role: "user",
      content: prompt.buildUser({
        message,
        card: ctx.card as Record<string, unknown> | undefined,
        history: ctx.history as ChatMessage[] | undefined,
        references: refBlocks.length ? refBlocks.join("\n\n") : undefined,
        upstream: ctx.upstream,
      }),
    },
  ];
  return streamAI("dialoguing", messages);
}

export interface DialogueFinalize {
  reply: string;
  card: Record<string, string>;
}

// 对话流结束后：解析卡片并派发写回。
export async function finalizeDialogue(
  requirementId: string,
  fullText: string
): Promise<DialogueFinalize> {
  const { reply, card } = extractReplyAndCard(fullText);
  await saveCardConnector.execute({ requirementId, data: card });
  return { reply, card: card as Record<string, string> };
}

// 需求卡片抽取（独立、可靠）：把整段对话压缩为结构化卡片。
// 与 finalizeDialogue 里「依赖模型在回复中夹带 ```json 卡片块」的脆弱路径互补——
// 这里直接拿全部对话历史喂给专门的 extract-card prompt，不依赖模型是否输出 JSON 块，
// 因此即使轻量模型漏写卡片块，背景/目标用户/核心痛点等仍会被逐步记录进需求卡片。
// 返回抽取到的部分卡片；对话为空或 AI 失败/无有效字段时返回 null（调用方据此决定是否跳过）。
export async function extractCard(
  requirementId: string
): Promise<Partial<RequirementCardData> | null> {
  const convs = await listConversations(requirementId);
  if (convs.length === 0) return null;

  const history: ChatMessage[] = convs.map((c) => ({
    role: c.role === "user" ? "user" : "assistant",
    content: c.content,
  }));
  const messages: ChatMessage[] = [
    { role: "system", content: extractCardPrompt.system },
    { role: "user", content: extractCardPrompt.buildUser({ message: "", history }) },
  ];

  try {
    const result = await callAI("dialoguing", messages);
    const { card } = extractReplyAndCard(result.content);
    return Object.keys(card).length ? card : null;
  } catch {
    // AI 异常不阻断对话主流程，交由调用方保持原卡片
    return null;
  }
}

// ---- 通用步骤生成管线（v2：非对话一步式生成） ----

export async function runGeneration(
  taskType: AITaskType,
  requirementId: string,
  input?: Record<string, unknown>
): Promise<ReadableStream<string>> {
  const prompt = getPrompt(taskType);
  const ctx = await buildStepContext(requirementId, taskType, input);

  const messages: ChatMessage[] = [
    { role: "system", content: prompt.system },
    ...(ctx.history ?? []).slice(-20).map((h) => ({
      role: h.role as "user" | "assistant",
      content: (h.content ?? "").slice(0, 500),
    })),
    {
      role: "user",
      content: prompt.buildUser({
        message: (input?.message as string) ?? "",
        card: ctx.card as Record<string, unknown> | undefined,
        history: ctx.history as ChatMessage[] | undefined,
        upstream: ctx.upstream,
        // 变更模式：携带变更点与现有文档，prompt 切换为精准修改式指令
        changeNote: (input?.changeNote as string) || undefined,
        existingDoc: ctx.existingDoc,
      }),
    },
  ];

  return streamAI(taskType, messages);
}

// 通用步骤结果写回：按 taskType 解析并落库。
export async function finalizeStep(
  taskType: AITaskType,
  requirementId: string,
  fullText: string
): Promise<{ type: string; result: unknown }> {
  if (taskType === "dialoguing") {
    const { reply, card } = extractReplyAndCard(fullText);
    await saveCardConnector.execute({ requirementId, data: card });
    return { type: "card", result: { reply, card } };
  }

  if (taskType === "research_analysis") {
    const output = extractResearchAnalysis(fullText);
    const version = await saveResearchAnalysis(requirementId, output);
    return { type: "research_analysis", result: { ...output, version } };
  }

  if (taskType === "solution_writing") {
    const doc = extractMarkdown(fullText);
    const version = await saveSolution(requirementId, doc);
    return { type: "solution", result: { doc, version } };
  }

  if (taskType === "prd_writing") {
    const markdown = extractMarkdown(fullText);
    const version = await savePRD(requirementId, markdown);
    return { type: "prd", result: { markdown, version } };
  }

  throw new Error(`未知任务类型：${taskType}`);
}

// M3 · 条目级 HITL 生成写回（正常模式）：AI 产出先以「建议卡」形态落 suggestions(pending)，
// 不直写产物表；落库推迟到用户 accept/edit（proposals.respondProposal）。
// 改造前 finalizeStep 按 taskType 直写库；改造后正常生成走此分支，change 模式仍走 finalizeStep。
export interface ProposeResult {
  type: string;
  suggestionId: string;
  targetType: ProposalTargetType;
  targetPath: string | null;
  op: ProposalOp;
  payload: ProposalPayload;
  /** 产生此建议的对话轮次（用于 _source.conversation_turn） */
  conversationTurn: number | null;
}

export async function proposeStep(
  taskType: AITaskType,
  requirementId: string,
  fullText: string
): Promise<ProposeResult> {
  const conversationTurn = await getConversationTurn(requirementId).catch(() => null);

  if (taskType === "research_analysis") {
    const output = extractResearchAnalysis(fullText);
    console.error(
      `[proposeStep|diag] research outputType=${typeof output} reportType=${typeof output.report} reportLen=${output.report?.length} fullTextLen=${fullText?.length}`
    );
    const targetType: ProposalTargetType = "research";
    const payload: ProposalPayload = {
      report: output.report,
      userStories: output.userStories as unknown[],
      features: output.features as unknown[],
    };
    console.error(`[proposeStep|diag] payloadType=${typeof payload} payload=`, JSON.stringify(payload).slice(0, 300));
    const suggestionId = await createProposal({
      requirementId,
      targetType,
      targetPath: null,
      op: "add",
      payload,
      conversationTurn: conversationTurn ?? undefined,
    });
    return { type: targetType, suggestionId, targetType, targetPath: null, op: "add", payload, conversationTurn };
  }

  if (taskType === "solution_writing") {
    const doc = extractMarkdown(fullText);
    const targetType: ProposalTargetType = "solution";
    const payload: ProposalPayload = { doc };
    const suggestionId = await createProposal({
      requirementId,
      targetType,
      targetPath: null,
      op: "add",
      payload,
      conversationTurn: conversationTurn ?? undefined,
    });
    return { type: targetType, suggestionId, targetType, targetPath: null, op: "add", payload, conversationTurn };
  }

  if (taskType === "prd_writing") {
    const markdown = extractMarkdown(fullText);
    const targetType: ProposalTargetType = "prd";
    const payload: ProposalPayload = { markdown };
    const suggestionId = await createProposal({
      requirementId,
      targetType,
      targetPath: null,
      op: "add",
      payload,
      conversationTurn: conversationTurn ?? undefined,
    });
    return { type: targetType, suggestionId, targetType, targetPath: null, op: "add", payload, conversationTurn };
  }

  throw new Error(`未知任务类型：${taskType}`);
}
