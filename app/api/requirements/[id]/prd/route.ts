import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { runGeneration, finalizeStep } from "@/lib/ai/orchestrator";
import { getSteps, markStepDone, markStepInProgress, setStepState, setStepGenerating, nextStepOf, isFrontierStep } from "@/lib/services/steps";
import { addMessage } from "@/lib/services/conversations";
import { touchRequirement } from "@/lib/services/requirements";
import { db } from "@/lib/db";
import { scheduleDevContextGeneration, abortDcGen } from "@/lib/ai/steps/devcontext";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 生成「需求文档」流式接口
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const mode: "normal" | "change" = body?.mode === "change" ? "change" : "normal";

  // 需求文档进入【进行中】，并标记「生成中」开始（跨页面/会话持久化）
  await markStepInProgress(params.id, "prd_writing").catch(() => {});
  await setStepGenerating(params.id, "prd_writing", true).catch(() => {});

  // 【P0 修遗留】客户端断开 → 立即取消后台 DC 任务，释放 token + DB 连接
  // 否则 fire-and-forget 任务会跑满 180s 没人能停，挤占连接池
  req.signal.addEventListener("abort", () => abortDcGen(params.id));

  const stream = await runGeneration("prd_writing", params.id, {
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
        const result = await finalizeStep("prd_writing", params.id, full);
        const version = (result.result as { version?: number })?.version;
        const resultType = result.type;

        // 将版本号同步写回 requirement_steps.output_version
        if (version != null) {
          await db.updateWhere("requirement_steps", { requirement_id: params.id, step: "prd_writing" }, { output_version: version }).catch(() => {});
        }

        // 生成完成后不再自动推进，当前节点保持【进行中】并等待用户确认。
        const nextStep = nextStepOf("prd_writing"); // null（最后一步）
        const genMessage =
          mode === "normal"
            ? `✅ 需求文档已生成，确认后即可完成整个需求分析。`
            : `✅ 需求文档已更新。`;

        // 落库合成消息，确保退出重进会话后仍能回显
        await addMessage(params.id, "assistant", genMessage).catch(() => {});
        // 生成（或更新）输出物即视为需求的一次更新，刷新「最近更新」时间
        await touchRequirement(params.id).catch(() => {});

        // 判断当前是否为前沿阶段：前沿需重开确认闸门，上游自动完成。
        // 注：prd_writing 为末阶段，无下游，永远是 frontier。
        // normal 模式首次推进时所有下游均为未开始，天然为前沿阶段。
        let isFrontier = false;
        if (mode === "normal") {
          isFrontier = true;
          await setStepState(params.id, "prd_writing", "in_progress", {
            outputVersion: version,
            awaitingConfirm: true,
          }).catch(() => {});
        } else {
          const allSteps = await getSteps(params.id);
          isFrontier = isFrontierStep(allSteps, "prd_writing");
          if (isFrontier) {
            await setStepState(params.id, "prd_writing", "in_progress", {
              outputVersion: version,
              awaitingConfirm: true,
            }).catch(() => {});
          } else {
            await markStepDone(params.id, "prd_writing", version).catch(() => {});
          }
        }

        const steps = await getSteps(params.id);
        send("step_update", steps);
        send("gen_message", { content: genMessage });
        // 下发确认闸门：前沿阶段生成完成后等待用户手动确认
        if (isFrontier) {
          send("proceed_prompt", {
            step: "prd_writing",
            nextStep,
            canSkip: false,
            message:
              mode === "normal"
                ? "需求文档已生成，请确认后进入下一步。"
                : "需求文档已更新，请确认后进入下一步。",
            version,
          });
        }
        send("done", { type: resultType });

        // M2：PRD 生成完成后，同源并列触发 DevContext 生成。
        // 关键修复：DevContext 改为「后台异步、不阻塞 SSE」。
        // 真实 AI 生成 16 段结构化 DevContext 可能耗时 30~90s；若在此 await，
        // 会一直撑着 SSE 连接不关闭，而客户端「左栏可点击 / 完成通知」都写在
        // reader 循环之后（连接关闭后才执行），导致 PRD 明明已好却「卡很久」。
        // 因此 fire-and-forget，SSE 立即关闭；DevContext 完成后由前端面板轮询刷新。
        // 注：客户端断开后不再发送 devcontext_update，避免 controller.close 抛错。
        if (!clientClosed) {
          send("devcontext_update", { version: null, pending: true });
          // 【P0 修遗留】改用 scheduleDevContextGeneration：注册到集中任务表，
          // 同一 requirementId 并发触发时复用现有 Promise，外部可主动 abort。
          const { promise } = scheduleDevContextGeneration(params.id, {
            trigger: "prd_writing",
            timeoutMs: Number(process.env.DEVCONTEXT_TIMEOUT_MS ?? 180000),
          });
          promise
            .then((v) => console.log(`[devcontext] requirement=${params.id} 生成完成 v${v}`))
            .catch((e) =>
              console.error(
                `[devcontext] requirement=${params.id} 生成失败：`,
                e instanceof Error ? e.message : e
              )
            );
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        send("error", { message });
      } finally {
        // 兜底清除「生成中」标记：成功/失败/断连都必须置 false，避免永久卡在生成中
        await setStepGenerating(params.id, "prd_writing", false).catch(() => {});
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
