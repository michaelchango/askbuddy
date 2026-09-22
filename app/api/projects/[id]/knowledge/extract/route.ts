// 知识沉淀触发（M4）：从已确认 decisions 抽取知识入库。dryRun=true 仅预览不写库。
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getProject } from "@/lib/services/projects";
import { extractFromDecisions } from "@/lib/services/knowledge-extractor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const project = await getProject(params.id);
  if (!project || project.ownerId !== user.uid) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dryRun === true;
  const limit = typeof body?.limit === "number" && body.limit > 0 ? body.limit : undefined;

  const result = await extractFromDecisions(params.id, { dryRun, limit });
  return NextResponse.json({ ok: true, data: result });
}
