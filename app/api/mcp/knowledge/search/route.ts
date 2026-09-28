import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";
import { searchKnowledgeEntries } from "@/lib/services/knowledge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MCP 平台侧：知识库语义检索（M4 接入，项目级）。
// 兼容旧 GET（M2 占位时的 ?q=），但推荐 POST（携带 projectId + query + topK）。
export async function POST(req: Request) {
  const user = await authenticate(req);
  if (!user)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const projectId = String(body?.projectId ?? "");
  const query = String(body?.query ?? "").trim();
  if (!projectId || !query) {
    return NextResponse.json(
      { ok: false, error: "invalid_input", message: "projectId 与 query 必填" },
      { status: 400 }
    );
  }
  const topK = typeof body?.topK === "number" ? Math.min(Math.max(body.topK, 1), 20) : 8;

  const { results, degraded } = await searchKnowledgeEntries({
    projectId,
    query,
    topK,
    minSimilarity: 0,
  });

  // 裁剪输出：不携带 embedding（1024 维向量无意义且巨大）。
  return NextResponse.json({
    ok: true,
    data: {
      query,
      results: results.map((r) => ({
        id: r.id,
        title: r.title,
        content: r.content,
        category: r.category,
        score: r.score,
      })),
      degraded,
    },
  });
}

// 兼容旧 GET（M2 占位路径）：仍接受 ?q=，但知识库是项目级，需额外 projectId。
export async function GET(req: Request) {
  const user = await authenticate(req);
  if (!user)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const projectId = url.searchParams.get("projectId") ?? "";
  if (!projectId || !q) {
    return NextResponse.json(
      { ok: false, error: "invalid_input", message: "知识检索需 projectId 与 q（或改用 POST）" },
      { status: 400 }
    );
  }
  const { results, degraded } = await searchKnowledgeEntries({
    projectId,
    query: q,
    topK: 8,
    minSimilarity: 0,
  });
  return NextResponse.json({
    ok: true,
    data: {
      query: q,
      results: results.map((r) => ({
        id: r.id,
        title: r.title,
        content: r.content,
        category: r.category,
        score: r.score,
      })),
      degraded,
    },
  });
}
