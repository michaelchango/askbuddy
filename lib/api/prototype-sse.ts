// 原型生成/修改的 SSE 响应构造器：读取流式 HTML → 解析 → 落库 → 推送完成事件。
import { NextResponse } from "next/server";
import { streamPrototype, type StreamPrototypeOpts } from "@/lib/ai/steps/prototype";
import { extractPrototype } from "@/lib/ai/parse";
import { savePrototypeVersion } from "@/lib/services/prototypes";
import { AI_TASK_MODEL } from "@/lib/ai/models";
import { getSteps, setAwaitingConfirm, nextStepOf } from "@/lib/services/steps";
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

        const saved = await savePrototypeVersion(
          requirementId,
          { html, structure, model: AI_TASK_MODEL[taskType] },
          opts.baseVersionId
        );

        // 原型属于「方案设计」步骤的第二个子阶段。生成/修改完成后打开方案设计步骤的确认闸门，
        // 用户确认后由前端标记 design 步骤完成并进入 PRD 写作。设置 awaitingConfirm 以便退出重进后仍能恢复闸门。
        await setAwaitingConfirm(requirementId, "design", true).catch(() => {});

        const genMessage = isEdit
          ? "✅ 原型已更新，可继续修改，或在上方阶段栏确认后进入下一阶段。"
          : "✅ 原型已生成，可继续修改，或在上方阶段栏确认后进入下一阶段。";
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
        // 原型子阶段确认闸门：nextStep 指向 prd_writing，无 subPhase → 确认后标记 design 完成并推进
        controller.enqueue(
          encoder.encode(
            `event: proceed_prompt\ndata: ${JSON.stringify({
              step: "design",
              nextStep: nextStepOf("design"),
              canSkip: false,
              message: "原型已就绪，确认后进入需求文档阶段。",
            })}\n\n`
          )
        );

        controller.enqueue(
          encoder.encode(
            `event: done\ndata: ${JSON.stringify({
              version: saved.version,
              structure: saved.structure,
            })}\n\n`
          )
        );
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
