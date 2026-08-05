import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { runGeneration, finalizeStep } from "@/lib/ai/orchestrator";
import { getSteps, markStepDone, markStepInProgress, setAwaitingConfirm, nextStepOf, isFrontierStep } from "@/lib/services/steps";
import { addMessage } from "@/lib/services/conversations";
import { touchRequirement } from "@/lib/services/requirements";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 生成「调研分析」流式接口
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const mode: "normal" | "change" = body?.mode === "change" ? "change" : "normal";

  // 进入调研分析即代表「需求确认」已完成（change 模式下 dialoguing 已是 done，幂等）
  if (mode === "normal") {
    await markStepDone(params.id, "dialoguing").catch(() => {});
  }
  // 调研分析进入【进行中】
  await markStepInProgress(params.id, "research_analysis").catch(() => {});

  const stream = await runGeneration("research_analysis", params.id, {
    message: body?.message ?? "",
    // 变更模式：携带变更点，生成管线切换为"基于现有文档精准修改"
    changeNote: mode === "change" ? (body?.changeNote ?? "") : "",
  });
  const encoder = new TextEncoder();
  let full = "";

  const sse = new ReadableStream({
    async start(controller) {
      try {
        // 生成开始前推送状态，确保节点立即翻转
        const stepsEarly = await getSteps(params.id);
        controller.enqueue(encoder.encode(`event: step_update\ndata: ${JSON.stringify(stepsEarly)}\n\n`));

        const reader = stream.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          full += value;
          controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify(full)}\n\n`));
        }

        const result = await finalizeStep("research_analysis", params.id, full);
        const version = (result.result as { version?: number })?.version;

        // 将版本号同步写回 requirement_steps.output_version（UI 依赖此字段显示版本）
        if (version != null) {
          await db.updateWhere("requirement_steps", { requirement_id: params.id, step: "research_analysis" }, { output_version: version }).catch(() => {});
        }

        // 关键改动：生成完成后【不再自动推进】。当前节点保持【进行中】，
        // 仅打开"确认闸门"，等待用户在阶段栏点击【确认并进入下一阶段】。
        const nextStep = nextStepOf("research_analysis");
        const genMessage =
          mode === "normal"
            ? `✅ 调研分析已生成，请在上方的阶段栏确认后进入下一阶段。`
            : `✅ 调研分析已更新。`;

        // 落库合成消息，确保退出重进会话后仍能回显
        await addMessage(params.id, "assistant", genMessage).catch(() => {});
        // 生成（或更新）输出物即视为需求的一次更新，刷新「最近更新」时间
        await touchRequirement(params.id).catch(() => {});

        // 变更模式：判断当前是否为前沿阶段，前沿需重开确认闸门，上游自动完成
        let isFrontier = false;
        if (mode === "normal") {
          await setAwaitingConfirm(params.id, "research_analysis", true).catch(() => {});
        } else {
          const allSteps = await getSteps(params.id);
          isFrontier = isFrontierStep(allSteps, "research_analysis");
          if (isFrontier) {
            await setAwaitingConfirm(params.id, "research_analysis", true).catch(() => {});
          } else {
            await markStepDone(params.id, "research_analysis", version).catch(() => {});
          }
        }

        const steps = await getSteps(params.id);
        controller.enqueue(encoder.encode(`event: step_update\ndata: ${JSON.stringify(steps)}\n\n`));
        // 实时展示合成消息
        controller.enqueue(encoder.encode(`event: gen_message\ndata: ${JSON.stringify({ content: genMessage })}\n\n`));
        // 下发确认闸门：normal 模式始终下发；change 模式仅前沿阶段下发
        if (mode === "normal" || isFrontier) {
          controller.enqueue(
            encoder.encode(
              `event: proceed_prompt\ndata: ${JSON.stringify({
                step: "research_analysis",
                nextStep,
                canSkip: false,
                message: mode === "normal"
                  ? "调研分析已生成，请确认后进入下一阶段。"
                  : "调研分析已更新，请在上方阶段栏确认后进入下一阶段。",
                version,
              })}\n\n`
            )
          );
        }
        controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ type: result.type })}\n\n`));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[trace|research_analysis] SSE 流异常:", e);
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
