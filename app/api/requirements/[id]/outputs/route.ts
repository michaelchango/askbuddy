import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listOutputs } from "@/lib/services/outputs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/requirements/:id/outputs —— 返回 6 类输出物元数据（是否存在、最新版本）。
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const data = await listOutputs(params.id);
  return NextResponse.json({ ok: true, data });
}
