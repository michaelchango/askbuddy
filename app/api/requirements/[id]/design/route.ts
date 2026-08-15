import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { runGeneration, finalizeStep } from "@/lib/ai/orchestrator";
import { getSteps, markStepDone, markStepInProgress, setAwaitingConfirm, setStepGenerating, isFrontierStep } from "@/lib/services/steps";
import { addMessage } from "@/lib/services/conversations";
import { touchRequirement } from "@/lib/services/requirements";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 生成「方案设计」流式接口
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const mode: "normal" | "change" = body?.mode === "change" ? "change" : "normal";

  // 方案设计进入【进行中】，并标记「生成中」开始（跨页面/会话持久化）。
  // 方案文档生成时显式写 design_sub_phase=null，防止上一次原型生成的子阶段残留
  await markStepInProgress(params.id, "design").catch(() => {});
  await setStepGenerating(params.id, "design", true, null).catch(() => {});

  const stream = await runGeneration("solution_writing", params.id, {
    message: body?.message ?? "",
    // 变更模式：携带变更点，生成管线切换为"基于现有文档精准修改"
    changeNote: mode === "change" ? (body?.changeNote ?? "") : "",
  });
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
        console.error(`[trace|design] 生成超时 (${GENERATION_TIMEOUT_MS}ms)，强制清 0: req=${params.id}`);
        send("error", { message: "生成超时，已自动终止" });
        setStepGenerating(params.id, "design", false, null).catch(() => {});
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
        const stepsEarly = await getSteps(params.id);
        send("step_update", stepsEarly);

        const reader = stream.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          full += value;
          send("delta", full);
        }

        // 生成结果直写库（normal 与 change 统一走 finalizeStep，产物直接落库）
        const result = await finalizeStep("solution_writing", params.id, full);
        const version = (result.result as { version?: number })?.version;
        const resultType = result.type;

        // 将版本号同步写回 requirement_steps.output_version
        if (version != null) {
          await db.updateWhere("requirement_steps", { requirement_id: params.id, step: "design" }, { output_version: version }).catch(() => {});
        }

                // 生成完成后不再自动推进，当前节点保持【进行中】并等待用户确认。
        const genMessage =
          mode === "normal"
            ? `✅ 方案文档已生成，请确认后进入原型设计。`
            : `✅ 方案文档已更新。`;

        // 落库合成消息，确保退出重进会话后仍能回显
        await addMessage(params.id, "assistant", genMessage).catch(() => {});
        // 生成（或更新）输出物即视为需求的一次更新，刷新「最近更新」时间
        await touchRequirement(params.id).catch(() => {});

        // 判断当前是否为前沿阶段：前沿需重开确认闸门，上游自动完成。
        // normal 模式首次推进时所有下游均为未开始，天然为前沿阶段。
        let isFrontier = false;
        if (mode === "normal") {
          isFrontier = true;
          await setAwaitingConfirm(params.id, "design", true).catch(() => {});
        } else {
          const allSteps = await getSteps(params.id);
          isFrontier = isFrontierStep(allSteps, "design");
          if (isFrontier) {
            await setAwaitingConfirm(params.id, "design", true).catch(() => {});
          } else {
            await markStepDone(params.id, "design", version).catch(() => {});
          }
        }

        // 必须赶在 getSteps / step_update 之前把 generating 清 0，
        // 否则前端收到的是一个「生成中」的快照，会被 globalMutate(..., false) 写死进 SWR 缓存，
        // 导致详情页右侧栏与进度条永久显示「AI 正在生成…」。
        await setStepGenerating(params.id, "design", false, null).catch(() => {});

        const steps = await getSteps(params.id);
        send("step_update", steps);
        send("gen_message", { content: genMessage });
        // 下发确认闸门：前沿阶段生成完成后等待用户手动确认
        if (isFrontier) {
          send("proceed_prompt", {
            step: "design",
            nextStep: null,
            subPhase: "prototype",
            canSkip: false,
            message:
              mode === "normal"
                ? "方案文档已生成，请确认后进入原型设计。"
                : "方案文档已更新，请确认后进入原型设计。",
            version,
          });
        }
        send("done", { type: resultType });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[trace|design] SSE 流异常:", e);
        send("error", { message });
      } finally {
        clearTimeout(timeoutId);
        // 兜底清除「生成中」标记：成功/失败/断连/超时都必须置 false，避免永久卡在生成中。
        // 同时显式清空 design_sub_phase，保持与方案文档生成语义一致
        if (!timedOut) {
          await setStepGenerating(params.id, "design", false, null).catch(() => {});
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
    },
  });
}
