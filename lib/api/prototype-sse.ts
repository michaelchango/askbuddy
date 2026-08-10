// 原型生成/修改的 SSE 响应构造器：读取流式 HTML → 解析 → 落库 → 推送完成事件。
import { NextResponse } from "next/server";
import { streamPrototype, type StreamPrototypeOpts } from "@/lib/ai/steps/prototype";
import { extractPrototype } from "@/lib/ai/parse";
import { savePrototypeVersion } from "@/lib/services/prototypes";
import { AI_TASK_MODEL } from "@/lib/ai/models";
import { getSteps } from "@/lib/services/steps";
import { createProposal } from "@/lib/services/proposals";
import { getConversationTurn } from "@/lib/services/conversations";
import { addMessage } from "@/lib/services/conversations";
import { touchRequirement } from "@/lib/services/requirements";

export async function prototypeSSE(
  requirementId: string,
  opts: StreamPrototypeOpts
): Promise<Response> {
  const isEdit = !!(opts.baseVersionId || opts.changeNote);
  const taskType = isEdit ? "prototype_edit" : "prototype_gen";
  const stream = await streamPrototype(requirementId, opts);
  const encoder = new TextEncoder();
  let full = "";

  const sse = new ReadableStream({
    async start(controller) {
      try {
        const reader = stream.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          full += value;
          controller.enqueue(
            encoder.encode(`event: delta\ndata: ${JSON.stringify(full)}\n\n`)
          );
        }

        const { html, structure } = extractPrototype(full);
        if (!html || !html.trim()) {
          throw new Error("模型未返回有效的 HTML 原型");
        }

        // 文案格式与其他文档（设计/PRD/调研）的已更新/已生成一致：
        // 变更/编辑模式 → 简短"已更新"结尾；首次生成模式 → 提示在建议卡确认后进入下一阶段
        const genMessage = isEdit
          ? "✅ 原型已更新。"
          : "✅ 原型已生成，请在下方建议卡中确认（接受 / 编辑 / 忽略）后进入需求文档阶段。";
        await addMessage(requirementId, "assistant", genMessage).catch(() => {});
        // 生成（或更新）原型即视为需求的一次更新，刷新「最近更新」时间
        await touchRequirement(requirementId).catch(() => {});

        const steps = await getSteps(requirementId).catch(() => null);
        if (steps) {
          controller.enqueue(
            encoder.encode(`event: step_update\ndata: ${JSON.stringify(steps)}\n\n`)
          );
        }
        controller.enqueue(
          encoder.encode(
            `event: gen_message\ndata: ${JSON.stringify({ content: genMessage })}\n\n`
          )
        );

        if (isEdit) {
          // 编辑 / 变更模式：直接落库更新原型（M3 仅对正常生成开启建议卡闸门）
          const saved = await savePrototypeVersion(
            requirementId,
            { html, structure, model: AI_TASK_MODEL[taskType] },
            opts.baseVersionId
          );
          controller.enqueue(
            encoder.encode(
              `event: done\ndata: ${JSON.stringify({
                version: saved.version,
                structure: saved.structure,
              })}\n\n`
            )
          );
        } else {
          // M3 · 正常生成：先下发改建议卡（原型），阶段闸门延后到用户决策后再触发（AD-4 叠加）
          const proposalTurn = await getConversationTurn(requirementId).catch(() => null);
          const suggestionId = await createProposal({
            requirementId,
            targetType: "prototype",
            targetPath: null,
            op: "add",
            payload: { html, structure, model: AI_TASK_MODEL[taskType] },
            conversationTurn: proposalTurn ?? undefined,
          });
          controller.enqueue(
            encoder.encode(
              `event: proposal\ndata: ${JSON.stringify({
                suggestionId,
                targetType: "prototype",
                targetPath: null,
                op: "add",
                payload: { html, structure, model: AI_TASK_MODEL[taskType] },
                status: "pending",
                conversationTurn: proposalTurn,
                requiresConfirmation: true,
              })}\n\n`
            )
          );
          controller.enqueue(
            encoder.encode(
              `event: done\ndata: ${JSON.stringify({
                version: null,
                structure,
              })}\n\n`
            )
          );
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ message })}\n\n`
          )
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(sse, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
