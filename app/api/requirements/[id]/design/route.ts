import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { runGeneration, finalizeStep } from "@/lib/ai/orchestrator";
import { getSteps, markStepDone, markStepInProgress, setAwaitingConfirm, isFrontierStep } from "@/lib/services/steps";
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

  // [TRACE] 路由入口诊断日志
  console.log("[route|design] POST 入口", { id: params.id, mode, changeNote: body?.changeNote });

  // 方案设计进入【进行中】
  await markStepInProgress(params.id, "design").catch(() => {});

  const stream = await runGeneration("solution_writing", params.id, {
    message: body?.message ?? "",
    // 变更模式：携带变更点，生成管线切换为"基于现有文档精准修改"
    changeNote: mode === "change" ? (body?.changeNote ?? "") : "",
  });
  const encoder = new TextEncoder();
  let full = "";

  const sse = new ReadableStream({
    async start(controller) {
      try {
        const stepsEarly = await getSteps(params.id);
        controller.enqueue(encoder.encode(`event: step_update\ndata: ${JSON.stringify(stepsEarly)}\n\n`));

        console.log("[trace|design] 开始读取 SSE 流");

        const reader = stream.getReader();
        let chunkCount = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          full += value;
          chunkCount++;
          if (chunkCount <= 3 || chunkCount % 10 === 0) {
            console.log("[trace|design] SSE chunk", { chunkCount, length: value.length, fullLen: full.length });
          }
          controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify(full)}\n\n`));
        }

        console.log("[trace|design] SSE 流读取完成", { chunkCount, fullLen: full.length, fullPreview: full.slice(0, 200) });
        console.log("[trace|design] 即将调用 finalizeStep solution_writing");

        const result = await finalizeStep("solution_writing", params.id, full);
        console.log("[trace|design] finalizeStep 返回", { type: result.type });

        const version = (result.result as { version?: number })?.version;

        // 将版本号同步写回 requirement_steps.output_version（UI 依赖此字段显示版本）
        if (version != null) {
          await db.updateWhere("requirement_steps", { requirement_id: params.id, step: "design" }, { output_version: version }).catch(() => {});
        }

        // 生成完成后不再自动推进，当前节点保持【进行中】，仅打开确认闸门。
        // 方案设计步骤包含"方案文档 → 原型设计"两个子阶段，此处为第一个子阶段（方案文档）。
        const genMessage =
          mode === "normal"
            ? `✅ 方案文档已生成，请在上方的阶段栏确认后进入原型设计。`
            : `✅ 方案文档已更新。`;

        // 落库合成消息，确保退出重进会话后仍能回显
        await addMessage(params.id, "assistant", genMessage).catch(() => {});
        // 生成（或更新）输出物即视为需求的一次更新，刷新「最近更新」时间
        await touchRequirement(params.id).catch(() => {});

        // 变更模式：判断当前是否为前沿阶段，前沿需重开确认闸门，上游自动完成
        let isFrontier = false;
        if (mode === "normal") {
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

        const steps = await getSteps(params.id);
        controller.enqueue(encoder.encode(`event: step_update\ndata: ${JSON.stringify(steps)}\n\n`));
        controller.enqueue(encoder.encode(`event: gen_message\ndata: ${JSON.stringify({ content: genMessage })}\n\n`));
        // 下发确认闸门：normal 模式始终下发；change 模式仅前沿阶段下发。
        // nextStep 为 null + subPhase 为 "prototype"：确认后不标记步骤完成，而是进入原型设计子阶段。
        if (mode === "normal" || isFrontier) {
          controller.enqueue(
            encoder.encode(
              `event: proceed_prompt\ndata: ${JSON.stringify({
                step: "design",
                nextStep: null,
                // 仅在 normal 模式进入原型设计子阶段；change 模式不携带 subPhase，
                // 避免跳过原型设计的变更场景下点击确认后误入原型设计。
                subPhase: mode === "normal" ? "prototype" : undefined,
                canSkip: false,
                message: mode === "normal"
                  ? "方案文档已生成，请确认后进入原型设计。"
                  : "方案文档已更新，请在上方阶段栏确认。",
                version,
              })}\n\n`
            )
          );
        }
        controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ type: result.type })}\n\n`));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[trace|design] SSE 流异常:", e);
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message })}\n\n`));
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
    },
  });
}
