import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { runGeneration, finalizeStep, proposeStep } from "@/lib/ai/orchestrator";
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

        const reader = stream.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          full += value;
          controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify(full)}\n\n`));
        }

        // M3 · 正常模式走「建议卡」路径（先建议后写库）；变更模式保持直写库。
        let version: number | undefined = undefined;
        let suggestionId: string | null = null;
        let proposalTarget: string | null = null;
        let proposalPayload: unknown = null;
        let proposalTurn: number | null = null;
        let resultType = "";
        if (mode === "normal") {
          const result = await proposeStep("solution_writing", params.id, full);
          suggestionId = result.suggestionId;
          proposalTarget = result.targetType;
          proposalPayload = result.payload;
          proposalTurn = result.conversationTurn;
          resultType = result.type;
        } else {
          const result = await finalizeStep("solution_writing", params.id, full);
          version = (result.result as { version?: number })?.version;
          resultType = result.type;
        }

        // 将版本号同步写回 requirement_steps.output_version（仅变更模式有版本；正常模式为 null）
        if (version != null) {
          await db.updateWhere("requirement_steps", { requirement_id: params.id, step: "design" }, { output_version: version }).catch(() => {});
        }

        // 生成完成后不再自动推进，当前节点保持【进行中】。
        // · 正常模式：先下发改建议卡（方案文档），阶段闸门延后到用户决策后再触发（AD-4 叠加）。
        // · 变更模式：保持既有前沿/上游自动推进语义。
        const genMessage =
          mode === "normal"
            ? `✅ 方案文档已生成，请在下方建议卡中确认（接受 / 编辑 / 忽略）后再进入原型设计。`
            : `✅ 方案文档已更新。`;

        // 落库合成消息，确保退出重进会话后仍能回显
        await addMessage(params.id, "assistant", genMessage).catch(() => {});
        // 生成（或更新）输出物即视为需求的一次更新，刷新「最近更新」时间
        await touchRequirement(params.id).catch(() => {});

        // 变更模式：判断当前是否为前沿阶段，前沿需重开确认闸门，上游自动完成
        let isFrontier = false;
        if (mode !== "normal") {
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
        // M3 · 正常模式：下发建议卡（pending），由用户在对话面板逐条决策
        if (mode === "normal" && suggestionId && proposalTarget) {
          controller.enqueue(
            encoder.encode(
              `event: proposal\ndata: ${JSON.stringify({
                suggestionId,
                targetType: proposalTarget,
                targetPath: null,
                op: "add",
                payload: proposalPayload,
                status: "pending",
                conversationTurn: proposalTurn,
                requiresConfirmation: true,
              })}\n\n`
            )
          );
        }
        // 下发确认闸门：仅变更模式的前沿阶段下发（正常模式闸门由 respond API 触发）
        if (mode !== "normal" && isFrontier) {
          controller.enqueue(
            encoder.encode(
              `event: proceed_prompt\ndata: ${JSON.stringify({
                step: "design",
                nextStep: null,
                subPhase: "prototype",
                canSkip: false,
                message: "方案文档已更新，请在上方阶段栏确认。",
                version,
              })}\n\n`
            )
          );
        }
        controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ type: resultType })}\n\n`));
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
