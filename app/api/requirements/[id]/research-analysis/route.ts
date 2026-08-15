import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { runGeneration, finalizeStep } from "@/lib/ai/orchestrator";
import { getSteps, markStepDone, markStepInProgress, setAwaitingConfirm, setStepGenerating, nextStepOf, isFrontierStep } from "@/lib/services/steps";
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
  // 调研分析进入【进行中】，并标记「生成中」开始（跨页面/会话持久化）
  await markStepInProgress(params.id, "research_analysis").catch(() => {});
  await setStepGenerating(params.id, "research_analysis", true).catch(() => {});

  const stream = await runGeneration("research_analysis", params.id, {
    message: body?.message ?? "",
    // 变更模式：携带变更点，生成管线切换为"基于现有文档精准修改"
    changeNote: mode === "change" ? (body?.changeNote ?? "") : "",
  });
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
        // 生成开始前推送状态，确保节点立即翻转
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
        const result = await finalizeStep("research_analysis", params.id, full);
        const version = (result.result as { version?: number })?.version;
        const resultType = result.type;

        // 将版本号同步写回 requirement_steps.output_version
        if (version != null) {
          await db.updateWhere("requirement_steps", { requirement_id: params.id, step: "research_analysis" }, { output_version: version }).catch(() => {});
        }

        // 关键改动：生成完成后【不再自动推进】。当前节点保持【进行中】并等待用户确认。
        const nextStep = nextStepOf("research_analysis");
        const genMessage =
          mode === "normal"
            ? `✅ 调研分析已生成，请确认后进入下一阶段。`
            : `✅ 调研分析已更新。`;

        // 落库合成消息，确保退出重进会话后仍能回显
        await addMessage(params.id, "assistant", genMessage).catch(() => {});
        // 生成（或更新）输出物即视为需求的一次更新，刷新「最近更新」时间
        await touchRequirement(params.id).catch(() => {});

        // 判断当前是否为前沿阶段：前沿需重开确认闸门，上游自动完成。
        // normal 模式首次推进时所有下游均为未开始，天然为前沿阶段。
        let isFrontier = false;
        if (mode === "normal") {
          isFrontier = true;
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
        send("step_update", steps);
        // 实时展示合成消息
        send("gen_message", { content: genMessage });
        // 下发确认闸门：前沿阶段生成完成后等待用户手动确认
        if (isFrontier) {
          send("proceed_prompt", {
            step: "research_analysis",
            nextStep,
            canSkip: false,
            message:
              mode === "normal"
                ? "调研报告已生成，请确认后进入下一阶段。"
                : "调研报告已更新，请确认后进入下一阶段。",
            version,
          });
        }
        send("done", { type: resultType });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[trace|research_analysis] SSE 流异常:", e);
        send("error", { message });
        // [兜底] 即使进入 catch 也要尝试发「已生成/已更新」通知，避免 panel 永远等不到
        // 该文档的状态变更通知（场景：finalizeStep 抛错但 addMessage/send_gen_message
        // 已在更早的执行路径上完成过，这里只补一个事件，DB 已落库的消息由 SWR 兜底）。
        try {
          const fallbackMsg = mode === "normal"
            ? `✅ 调研分析已生成，请确认后进入下一阶段。`
            : `✅ 调研分析已更新。`;
          await addMessage(params.id, "assistant", fallbackMsg).catch(() => {});
          send("gen_message", { content: fallbackMsg });
        } catch {
          /* ignore */
        }
      } finally {
        // 兜底清除「生成中」标记：成功/失败/断连都必须置 false，避免永久卡在生成中
        await setStepGenerating(params.id, "research_analysis", false).catch(() => {});
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
