import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MCP 平台侧：获取调研分析结论（报告 + 用户故事 + 功能清单）
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await authenticate(req);
  if (!user)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const ra = await db.get<{
    report?: string;
    user_stories?: unknown[];
    features?: unknown[];
  }>("research_analysis", params.id);
  if (!ra)
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  return NextResponse.json({
    ok: true,
    data: {
      report: ra.report ?? "",
      userStories: ra.user_stories ?? [],
      features: ra.features ?? [],
    },
  });
}
