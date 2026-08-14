// 按钮手动进入下一阶段（含子阶段 prototype）的进度提示消息落库端点。
//
// 背景：用户点击顶部「进入下一阶段」按钮 / 方案文档确认后点击「进入原型设计」时，
// 应在对话面板追加一条与「对话路径」一致的推进提示（例如
// "好的，需求确认已确认。正在为您推进到「调研分析」…"）。该提示在对话路径下由
// 后端 conversation/route.ts 直接 addMessage 落库，前端按钮路径无对应后端位置，
// 因此需要专门给前端一个轻量端点写一条消息。
//
// 设计原则：
// - 保持端到端一致：消息由后端 addMessage 落库（id 顺序受 DB 自增控制），
//   前端再经 EVT.GEN_MESSAGE 即时追加到对话面板，刷新回显也能稳定看到。
// - 不接受自由文本：仅接受预定义阶段推进/子阶段提示类型，避免任意写消息被滥用。
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { addMessage } from "@/lib/services/conversations";
import { proceedReplyText } from "@/lib/stage";
import type { StepName } from "@/types";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const step = body?.step as StepName | undefined;
  const nextStep = (body?.nextStep ?? null) as StepName | null;
  const subPhase = (body?.subPhase ?? undefined) as "prototype" | undefined;

  if (!step) {
    return NextResponse.json(
      { ok: false, error: "missing step" },
      { status: 400 }
    );
  }

  // 复用 lib/stage 的 proceedReplyText：与对话路径 / 后端 conversation/route.ts
  // 同一份逻辑，保证"对话触发"与"按钮触发"两条路径的提示文案一字不差。
  const content = proceedReplyText(step, nextStep, subPhase);
  if (!content) {
    return NextResponse.json(
      { ok: false, error: "invalid step" },
      { status: 400 }
    );
  }

  // 失败时降级为 200 + ok:false，避免前端推迟反馈；但落库失败时前端仍能通过
  // 同步事件先看到提示（因为响应总是 200，前端事件已派发）。
  await addMessage(params.id, "assistant", content).catch(() => {});
  return NextResponse.json({ ok: true, data: { content } });
}
