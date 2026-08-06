import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";
import { db } from "@/lib/db";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await authenticate(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const version = body?.version as number | undefined;
  if (!version) {
    return NextResponse.json({ ok: false, error: "version required" }, { status: 400 });
  }

  // 查找目标版本（下推：命中 idx_prd_ver_req (requirement_id, version)）
  const versions = await db.findMany<{ version: number; markdown: string }>(
    "prd_versions",
    {
      where: { requirement_id: { eq: params.id }, version: { eq: version } },
      limit: 1,
    }
  );

  if (!versions || versions.length === 0) {
    return NextResponse.json({ ok: false, error: "version not found" }, { status: 404 });
  }
  const target = versions[0];

  const now = new Date().toISOString();
  // 更新 prds 主表为恢复的版本（current_version 不变，仅更新内容）
  await db.update("prds", params.id, {
    markdown: target.markdown,
    updated_at: now,
  }, "requirement_id");

  return NextResponse.json({ ok: true });
}
