// 原型生成/修改的 SSE 响应构造器：读取流式 HTML → 解析 → 落库 → 推送完成事件。
import { NextResponse } from "next/server";
import { streamPrototype, type StreamPrototypeOpts } from "@/lib/ai/steps/prototype";
import { extractPrototype } from "@/lib/ai/parse";
import { savePrototypeVersion } from "@/lib/services/prototypes";
import { AI_TASK_MODEL } from "@/lib/ai/models";
import { getSteps, setAwaitingConfirm, setStepGenerating, nextStepOf } from "@/lib/services/steps";
import { addMessage } from "@/lib/services/conversations";
import { touchRequirement } from "@/lib/services/requirements";

export async function prototypeSSE(
  requirementId: string,
  opts: StreamPrototypeOpts
): Promise<Response> {
  const isEdit = !!(opts.baseVersionId || opts.changeNote);
  const taskType = isEdit ? "prototype_edit" : "prototype_gen";
  // 原型属于 design 组的子产物，复用 design 步骤的「生成中」标记（跨页面/会话持久化）
  await setStepGenerating(requirementId, "design", true).catch(() => {});
  const stream = await streamPrototype(requirementId, opts);
  const encoder = new TextEncoder();
  let full = "";

  const sse = new ReadableStream({
    async start(controller) {
      // 客户端可能中途断开（切走/关闭页面），此时 controller.enqueue 会抛错。
      // 但生成任务仍应在后台继续跑完并落库，故引入「安全发送」：发送失败仅标记客户端已断开，
      // 不中断后台读取与 finalize，保证 generating 标记在真正完成后才置 false。
      let clientClosed = false;
      const send = (event: string, data: unknown) => {
        if (clientClosed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          clientClosed = true;
        }
      };

      try {
        const reader = stream.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          full += value;
          send("delta", full);
        }

        const { html, structure } = extractPrototype(full);
        if (!html || !html.trim()) {
          throw new Error("模型未返回有效的 HTML 原型");
        }

        // 文案格式与其他文档（设计/PRD/调研）的已更新/已生成一致：
        // 变更/编辑模式 → 简短"已更新"结尾；首次生成模式 → 提示在阶段栏确认后进入下一阶段
        const genMessage = isEdit
          ? "✅ 原型已更新。"
          : "✅ 原型已生成，请在下方确认后进入下一阶段。";
        await addMessage(requirementId, "assistant", genMessage).catch(() => {});
        // 生成（或更新）原型即视为需求的一次更新，刷新「最近更新」时间
        await touchRequirement(requirementId).catch(() => {});

        const steps = await getSteps(requirementId).catch(() => null);
        if (steps) {
          send("step_update", steps);
        }
        send("gen_message", { content: genMessage });

        // 生成（或更新）原型直接落库：编辑模式基于 baseVersionId 出新版本
        const saved = await savePrototypeVersion(
          requirementId,
          { html, structure, model: AI_TASK_MODEL[taskType] },
          opts.baseVersionId
        );

        // 原型子阶段确认闸门：nextStep 指向 prd_writing，无 subPhase → 确认后标记 design 完成并推进。
        // 仅 normal 模式下发：变更 / 编辑模式下原型只是"更新已有产物"，
        // 不应推进流程、也不应重开 design 闸门（否则会把顶部按钮翻成"原型已完成，确认后进入需求文档"，
        // 点击后又会把已经生成过的需求文档再生成一遍）。design / prd 路由已在各自 change 分支里正确
        // 区分了前沿 / 上游，此处原型需与之一致。
        if (!isEdit) {
          await setAwaitingConfirm(requirementId, "design", true).catch(() => {});
          send("proceed_prompt", {
            step: "design",
            nextStep: nextStepOf("design"),
            canSkip: false,
            message: "原型已就绪，确认后进入需求文档阶段。",
          });
        }

        send("done", { version: saved.version, structure: saved.structure });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        send("error", { message });
      } finally {
        // 兜底清除 design 步骤的「生成中」标记：成功/失败/断连都必须置 false
        await setStepGenerating(requirementId, "design", false).catch(() => {});
        try {
          controller.close();
        } catch {
          /* 客户端已断开时 controller 可能已关闭，忽略 */
        }
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
