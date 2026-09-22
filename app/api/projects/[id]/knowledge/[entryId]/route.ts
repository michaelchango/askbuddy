// 单条知识条目：GET / PATCH / DELETE（软删）。
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getProject } from "@/lib/services/projects";
import {
  getKnowledge,
  updateKnowledge,
  deleteKnowledge,
} from "@/lib/services/knowledge";
import { UpdateKnowledgeSchema } from "@/lib/schemas/knowledge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorize(projectId: string): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  const user = await getSession();
  if (!user) return { ok: false, res: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  const project = await getProject(projectId);
  if (!project || project.ownerId !== user.uid) {
    return { ok: false, res: NextResponse.json({ ok: false, error: "not_found" }, { status: 404 }) };
  }
  return { ok: true };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; entryId: string } }
) {
  const auth = await authorize(params.id);
  if (!auth.ok) return auth.res;

  const item = await getKnowledge(params.id, params.entryId);
  if (!item) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, data: item });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; entryId: string } }
) {
  const auth = await authorize(params.id);
  if (!auth.ok) return auth.res;

  const body = await req.json().catch(() => null);
  const parsed = UpdateKnowledgeSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_input", message: parsed.error.issues[0]?.message ?? "输入不合法" },
      { status: 400 }
    );
  }

  const item = await updateKnowledge(params.id, params.entryId, parsed.data);
  if (!item) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, data: item });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; entryId: string } }
) {
  const auth = await authorize(params.id);
  if (!auth.ok) return auth.res;

  await deleteKnowledge(params.id, params.entryId);
  return NextResponse.json({ ok: true, data: { id: params.entryId } });
}
