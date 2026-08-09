import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";
import { getDevContext, getDevContextSection } from "@/lib/services/devcontext";
import { SECTION_KEYS, type SectionKey } from "@/lib/schemas/devcontext";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MCP 平台侧：获取开发上下文（DevContext）。
// 不传 section → 返回整套 DevContext（content 为完整 JSON）；
// 传 section=business_rules|data_structures|api_requirements|acceptance_criteria
//   → 仅返回该段内容（供 4 个 dev_context_* 工具共享此路由）。
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await authenticate(req);
  if (!user)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const rec = await getDevContext(params.id);
  if (!rec)
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const url = new URL(req.url);
  const sectionParam = url.searchParams.get("section");

  if (sectionParam) {
    if (!(SECTION_KEYS as readonly string[]).includes(sectionParam)) {
      return NextResponse.json({ ok: false, error: "bad_section" }, { status: 400 });
    }
    const sec = await getDevContextSection(params.id, sectionParam as SectionKey);
    return NextResponse.json({
      ok: true,
      data: {
        section: sectionParam,
        content: sec,
        version: rec.current_version,
        status: rec.status,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    data: {
      content: rec.content,
      status: rec.status,
      completeness_score: rec.completeness_score,
      applicable_count: rec.applicable_count,
      present_count: rec.present_count,
      version: rec.current_version,
      updated_at: rec.updated_at,
    },
  });
}
