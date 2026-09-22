// 项目知识库 CRUD（M4 知识复利）。
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getProject } from "@/lib/services/projects";
import {
  listKnowledge,
  createKnowledge,
} from "@/lib/services/knowledge";
import { CreateKnowledgeSchema } from "@/lib/schemas/knowledge";

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
  { params }: { params: { id: string } }
) {
  const auth = await authorize(params.id);
  if (!auth.ok) return auth.res;

  const url = new URL(_req.url);
  const category = url.searchParams.get("category") ?? undefined;
  const status = (url.searchParams.get("status") as "active" | "deprecated" | null) ?? undefined;

  const items = await listKnowledge(params.id, { category, status });
  return NextResponse.json({ ok: true, data: items });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authorize(params.id);
  if (!auth.ok) return auth.res;

  const body = await req.json().catch(() => null);
  const parsed = CreateKnowledgeSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_input", message: parsed.error.issues[0]?.message ?? "输入不合法" },
      { status: 400 }
    );
  }

  const item = await createKnowledge(params.id, parsed.data);
  return NextResponse.json({ ok: true, data: item });
}
