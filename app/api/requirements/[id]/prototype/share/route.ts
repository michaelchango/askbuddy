import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";
import { createShareToken, getShareToken } from "@/lib/services/prototypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 查询当前已存在的分享链接
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await authenticate(req);
  if (!user)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const token = await getShareToken(params.id);
  return NextResponse.json({
    ok: true,
    data: token ? { token, url: `/share/prototype/${token}` } : null,
  });
}

// 创建分享链接
export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await authenticate(req);
  if (!user)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const res = await createShareToken(
    params.id,
    typeof body?.expiresInDays === "number" ? body.expiresInDays : undefined
  );
  return NextResponse.json({ ok: true, data: res });
}
