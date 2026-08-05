import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";
import { getPrototypeHtml, listVersions } from "@/lib/services/prototypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 导出原型：?format=html 导出 HTML 文件；?format=json 导出 {version, structure, html}。
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await authenticate(req);
  if (!user)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const format = url.searchParams.get("format") || "html";

  const html = await getPrototypeHtml(params.id);
  if (!html)
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  if (format === "json") {
    const versions = await listVersions(params.id).catch(() => []);
    const latest = versions[versions.length - 1];
    const payload = JSON.stringify(
      {
        version: latest?.version ?? null,
        structure: latest?.structure ?? null,
        html,
      },
      null,
      2
    );
    return new NextResponse(payload, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="prototype-${params.id}.json"`,
      },
    });
  }

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="prototype-${params.id}.html"`,
    },
  });
}
