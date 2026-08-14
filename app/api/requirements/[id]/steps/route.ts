// 步骤完成度 API：GET 读取 / PATCH 更新。
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getSteps, setStepState } from "@/lib/services/steps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const data = await getSteps(params.id);
  return NextResponse.json({ ok: true, data });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  const { step, state, note, outputVersion, awaitingConfirm, designSubPhase, generating } = body;
  if (!step || !state) {
    return NextResponse.json({ ok: false, error: "step and state required" }, { status: 400 });
  }
  await setStepState(params.id, step, state, {
    note,
    outputVersion,
    awaitingConfirm:
      typeof awaitingConfirm === "boolean" ? awaitingConfirm : undefined,
    generating:
      typeof generating === "boolean" ? generating : undefined,
    designSubPhase:
      designSubPhase === "prototype" || designSubPhase === null
        ? designSubPhase
        : undefined,
  });
  return NextResponse.json({ ok: true });
}
