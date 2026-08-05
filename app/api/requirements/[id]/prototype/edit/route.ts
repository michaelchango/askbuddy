import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";
import { prototypeSSE } from "@/lib/api/prototype-sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 对话式修改原型：基于现有 HTML 应用修改意见，生成新版（流式 SSE）。
export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await authenticate(req);
  if (!user)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  return prototypeSSE(params.id, {
    message: body?.message ?? "",
    baseVersionId: body?.baseVersionId,
    changeNote: body?.changeNote ?? body?.message,
  });
}
