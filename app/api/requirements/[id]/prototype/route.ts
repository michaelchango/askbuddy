import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";
import { getPrototypeHtml, listVersions } from "@/lib/services/prototypes";
import { prototypeSSE } from "@/lib/api/prototype-sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 获取当前原型：HTML + 最新版本号 + 页面结构。
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await authenticate(req);
  if (!user)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const html = await getPrototypeHtml(params.id);
  const versions = await listVersions(params.id).catch(() => []);
  const latest = versions[versions.length - 1];
  return NextResponse.json({
    ok: true,
    data: {
      exists: !!html,
      html,
      version: latest?.version ?? null,
      structure: latest?.structure ?? null,
    },
  });
}

// 生成 / 重新生成原型（流式 SSE）。
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
    changeNote: body?.changeNote,
  });
}
