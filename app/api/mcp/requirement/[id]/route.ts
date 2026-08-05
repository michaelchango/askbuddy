import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";
import { getRequirementWithStatus } from "@/lib/services/requirements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MCP 平台侧：获取需求基本信息（卡片 + 步骤状态）
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await authenticate(req);
  if (!user)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const data = await getRequirementWithStatus(params.id);
  if (!data)
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  return NextResponse.json({ ok: true, data });
}
