import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";
import { getPrototypeHtml } from "@/lib/services/prototypes";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MCP 平台侧：获取原型 HTML + 页面结构
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await authenticate(req);
  if (!user)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const html = await getPrototypeHtml(params.id);
  if (!html)
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const latest = await db.get<{ current_version: number; structure: unknown }>(
    "prototypes",
    params.id
  );
  return NextResponse.json({
    ok: true,
    data: {
      version: latest?.current_version ?? null,
      structure: latest?.structure ?? null,
      html,
    },
  });
}
