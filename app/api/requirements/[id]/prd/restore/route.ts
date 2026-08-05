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

  // 查找目标版本
  const versions = await db.list<{ version: number; markdown: string; cos_key?: string }>(
    "prd_versions",
    (r) => r.requirement_id === params.id && r.version === version
  );

  if (!versions || versions.length === 0) {
    return NextResponse.json({ ok: false, error: "version not found" }, { status: 404 });
  }
  const target = versions[0];

  const now = new Date().toISOString();
  // 更新 prds 主表为恢复的版本（current_version 不变，仅更新内容）
  await db.update("prds", params.id, {
    markdown: target.markdown,
    cos_key: target.cos_key ?? "",
    updated_at: now,
  });

  return NextResponse.json({ ok: true });
}
