import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";
import { getPrototypeSummary, getPrototypeHtml } from "@/lib/services/prototypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MCP 平台侧：获取原型（轻量默认：仅结构 + 版本列表；
// 传 includeHtml=true 才返回完整 HTML 字符串，避免大体积负载拖慢 AI 上下文）。
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await authenticate(req);
  if (!user)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const summary = await getPrototypeSummary(params.id);
  if (!summary.version)
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const url = new URL(req.url);
  const includeHtml = url.searchParams.get("includeHtml") === "true";
  const html = includeHtml ? await getPrototypeHtml(params.id) : undefined;

  return NextResponse.json({
    ok: true,
    data: {
      version: summary.version,
      structure: summary.structure,
      versions: summary.versions,
      updatedAt: summary.updatedAt,
      ...(includeHtml ? { html: html ?? "" } : {}),
    },
  });
}
