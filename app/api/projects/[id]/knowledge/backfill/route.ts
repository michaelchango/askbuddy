// 知识 embedding 回填触发（M4）：为 active 且未索引的条目批量计算向量。
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getProject } from "@/lib/services/projects";
import { backfillEmbeddings } from "@/lib/services/knowledge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const project = await getProject(params.id);
  if (!project || project.ownerId !== user.uid) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const done = await backfillEmbeddings(params.id);
  return NextResponse.json({ ok: true, data: { backfilled: done } });
}
