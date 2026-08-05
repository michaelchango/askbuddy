import { getPrompt } from "../prompts";
import { streamAI } from "../client";
import type { ChatMessage } from "../types";
import type { AITaskType } from "../models";
import { buildPrototypeContext } from "./build-prototype-context";

export interface StreamPrototypeOpts {
  message?: string;
  baseVersionId?: number;
  changeNote?: string;
}

// 生成/修改原型的流式接口：返回文本块流（ReadableStream<string>），供 SSE 边生成边推送。
// 修改模式（baseVersionId / changeNote 存在）使用 prototype_edit 任务，否则 prototype_gen。
export async function streamPrototype(
  requirementId: string,
  opts: StreamPrototypeOpts
): Promise<ReadableStream<string>> {
  const isEdit = !!opts.baseVersionId || !!opts.changeNote;
  const taskType: AITaskType = isEdit ? "prototype_edit" : "prototype_gen";
  const ctx = await buildPrototypeContext(requirementId, taskType, opts);
  const prompt = getPrompt(taskType);

  const messages: ChatMessage[] = [
    { role: "system" as const, content: prompt.system },
    {
      role: "user" as const,
      content: prompt.buildUser({
        message: opts.message ?? "",
        card: ctx.card,
        upstream: ctx.upstream,
        history: ctx.history,
        existingDoc: ctx.existingHtml,
        changeNote: opts.changeNote,
      }),
    },
  ];

  return streamAI(taskType, messages);
}
