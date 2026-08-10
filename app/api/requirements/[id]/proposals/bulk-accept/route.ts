import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getRequirement } from "@/lib/services/requirements";
import { getProject } from "@/lib/services/projects";
import {
  bulkAccept,
  resolvedStagePrompts,
} from "@/lib/services/proposals";
import { setAwaitingConfirm } from "@/lib/services/steps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorize(id: string) {
  const user = await getSession();
  if (!user) return { error: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  const req = await getRequirement(id);
  if (!req) return { error: NextResponse.json({ ok: false, error: "not_found" }, { status: 404 }) };
  const project = await getProject(req.projectId);
  if (!project || project.ownerId !== user.uid) {
    return { error: NextResponse.json({ ok: false, error: "not_found" }, { status: 404 }) };
  }
  return { error: null as NextResponse | null, user };
}

// POST：全部接受（R7 缓解）。一次性 accept 该需求下所有 pending 建议。
// 全部决策后，为「已无 pending 建议」的各阶段打开 awaitingConfirm，
// 并返回 proceed_prompt 列表供前端弹出门控双按钮。
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authorize(params.id);
  if (auth.error) return auth.error;

  try {
    const count = await bulkAccept(params.id);
    const prompts = await resolvedStagePrompts(params.id);
    for (const p of prompts) {
      await setAwaitingConfirm(params.id, p.step as Parameters<typeof setAwaitingConfirm>[1], true).catch(() => {});
    }
    return NextResponse.json({
      ok: true,
      data: { count, proceedPrompts: prompts },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
