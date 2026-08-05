// Orchestrator（v2 泛化步骤管线）：组装上下文 → 取 prompt → 流式生成 → 解析 → 派发写回。
import { getPrompt } from "./prompts";
import { buildStepContext } from "./context/builder";
import { streamAI } from "./client";
import { extractReplyAndCard, extractResearchAnalysis, extractMarkdown } from "./parse";
import { saveCardConnector } from "./connectors/internal/save-card";
import { getOutput, saveResearchAnalysis, saveSolution, savePRD, type OutputType } from "@/lib/services/outputs";
import type { ChatMessage } from "./types";
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
