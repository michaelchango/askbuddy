import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";
import { getOutput } from "@/lib/services/outputs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MCP 平台侧：获取方案设计文档（Markdown）。
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = await authenticate(_req);
  if (!user)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const out = await getOutput(params.id, "design", undefined, "solution");
  if (!out || !out.content)
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  return NextResponse.json({
    ok: true,
    data: { version: out.version, doc: out.content, versions: out.versions },
  });
}
