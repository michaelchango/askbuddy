// 知识语义检索（M4）：POST，支持 Bearer/PAT 鉴权（MCP 调用），也支持 cookie 会话。
import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";
import { getProject } from "@/lib/services/projects";
import { searchKnowledgeEntries } from "@/lib/services/knowledge";
import { SearchKnowledgeSchema } from "@/lib/schemas/knowledge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await authenticate(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const project = await getProject(params.id);
  if (!project || project.ownerId !== user.uid) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const parsed = SearchKnowledgeSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_input", message: parsed.error.issues[0]?.message ?? "查询词不能为空" },
      { status: 400 }
    );
  }

  const { results, degraded } = await searchKnowledgeEntries({
    projectId: params.id,
    query: parsed.data.query,
    topK: parsed.data.topK,
    category: parsed.data.category,
    minSimilarity: parsed.data.minSimilarity,
  });

  return NextResponse.json({
    ok: true,
    data: results,
    degraded,
  });
}
