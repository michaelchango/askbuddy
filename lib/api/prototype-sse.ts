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
  opts: StreamPrototypeOpts,
  signal?: AbortSignal
): Promise<Response> {
  const isEdit = !!(opts.baseVersionId || opts.changeNote);
  const taskType = isEdit ? "prototype_edit" : "prototype_gen";
  // 原型属于 design 组的子产物，复用 design 步骤的「生成中」标记（跨页面/会话持久化），
  // 并同时写入子阶段标识 design_sub_phase='prototype'，供重进页面时区分「方案文档/原型」生成中
  await setStepGenerating(requirementId, "design", true, "prototype").catch(() => {});
  const stream = await streamPrototype(requirementId, { ...opts, signal });
  const encoder = new TextEncoder();
  let full = "";

  // 保险：无论成功/失败/断连/AI hang，最多 N 分钟后强制清 0，避免 dev/HMR/模型异常时永久卡死。
  const GENERATION_TIMEOUT_MS = 5 * 60 * 1000;

  const sse = new ReadableStream({
    async start(controller) {
      // 客户端可能中途断开（切走/关闭页面），此时 controller.enqueue 会抛错。
      // 但生成任务仍应在后台继续跑完并落库，故引入「安全发送」：发送失败仅标记客户端已断开，
      // 不中断后台读取与 finalize，保证 generating 标记在真正完成后才置 false。
      let clientClosed = false;
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        console.error(`[trace|prototype] 生成超时 (${GENERATION_TIMEOUT_MS}ms)，强制清 0: req=${requirementId}`);
        send("error", { message: "生成超时，已自动终止" });
        setStepGenerating(requirementId, "design", false, null).catch(() => {});
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      }, GENERATION_TIMEOUT_MS);

      function send(event: string, data: unknown) {
        if (clientClosed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          clientClosed = true;
        }
      }

      try {
        const reader = stream.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          // 用户主动点「终止」使 req.signal aborted：立即停止读取（后台 AI 调用也已停止），
          // full 即为「终止时刻」已生成的原型内容，不再往前生成。
          if (signal?.aborted) break;
          full += value;
          send("delta", full);
        }

        // 【终止行为修复】用户主动点「终止」：后端 AI 调用已停止，full 为终止时刻内容。
        // 仍把已生成部分落库（原型保留不消失），但不下发「已完成/可确认」信号，
        // 仅下发 gen_stopped 通知前端「已停在半途」。
        if (signal?.aborted) {
          const { html, structure } = extractPrototype(full);
          if (html && html.trim()) {
            const saved = await savePrototypeVersion(
              requirementId,
              { html, structure, model: AI_TASK_MODEL[taskType] },
              opts.baseVersionId
            );
            await touchRequirement(requirementId).catch(() => {});
            send("gen_stopped", { step: "design", subPhase: "prototype", version: saved.version });
          } else {
            send("gen_stopped", { step: "design", subPhase: "prototype", version: undefined });
          }
          return;
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
        }

        // 必须赶在 getSteps / step_update 之前把 generating 清 0，
        // 否则前端收到的是一个「生成中」的快照，会被 globalMutate(..., false) 写死进 SWR 缓存，
        // 导致详情页右侧栏与进度条永久显示「AI 正在生成…」。
        // 注意：原型生成完成后仍处于 design 步骤的「原型子阶段」，保留 design_sub_phase='prototype'，
        // 直到用户在 handleProceed 中确认进入 PRD 才清空。这样用户中途切走再回详情页时，
        // persistedDesignSubPhase 与 pendingPrompt 恢复才能正确识别「原型已完成、等待确认进 PRD」。
        await setStepGenerating(requirementId, "design", false, "prototype").catch(() => {});

        const steps = await getSteps(requirementId).catch(() => null);
        if (steps) {
          send("step_update", steps);
        }
        send("gen_message", { content: genMessage });

        if (!isEdit) {
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
        clearTimeout(timeoutId);
        // 兜底清除 design 步骤的「生成中」标记：成功/失败/断连/超时都必须置 false。
        // 保留 design_sub_phase='prototype'：原型阶段一旦进入就保持该标识，直到用户在 handleProceed
        // 中确认进入 PRD 才清空。这样即便客户端断连重连，也能识别当前处于「原型子阶段」。
        if (!timedOut) {
          await setStepGenerating(requirementId, "design", false, "prototype").catch(() => {});
        }
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
