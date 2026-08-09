import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MCP 平台侧：知识库检索（M2 占位）。
// 后续版本接入知识库后，此处返回真实检索结果；当前一律返回空结果 + 占位说明，
// 以免 MCP 客户端侧出现未定义行为。
export async function GET(req: Request) {
  const user = await authenticate(req);
  if (!user)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";

  return NextResponse.json({
    ok: true,
    data: {
      query: q,
      results: [],
      notice: "知识库检索尚未上线（M2 占位），敬请期待。",
    },
  });
}
