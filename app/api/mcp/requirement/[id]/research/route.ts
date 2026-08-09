import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";
import { getOutput } from "@/lib/services/outputs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MCP 平台侧：获取调研分析结论（Markdown）。经 outputs.getOutput 复用统一版本/降级逻辑。
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = await authenticate(_req);
  if (!user)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const out = await getOutput(params.id, "research_analysis");
  if (!out || !out.content)
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  return NextResponse.json({
    ok: true,
    data: { version: out.version, markdown: out.content, versions: out.versions },
  });
}
