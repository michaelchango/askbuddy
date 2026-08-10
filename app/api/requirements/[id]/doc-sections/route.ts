import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getRequirement } from "@/lib/services/requirements";
import { getProject } from "@/lib/services/projects";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorize(id: string) {
  const user = await getSession();
  if (!user) return { error: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  const req = await getRequirement(id);
  if (!req) return { error: NextResponse.json({ ok: false, error: "not_found" }, { status: 404 }) };
  const project = await getProject(req.projectId);
  if (!project || project.ownerId !== user.uid) {
    return { error: NextResponse.json({ ok: false, error: "not_found" }, { status: 404 }) };
  }
  return { error: null as NextResponse | null, user };
}

// GET：查询某产物版本的章节级溯源映射（doc_sections）。
// 参数：targetType（research | solution | prd）、version（缺省取最新）。
// 供 output-viewer 的「来源」侧栏按 h2 锚点定位并跳转回对话轮次。
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authorize(params.id);
  if (auth.error) return auth.error;

  const targetType = new URL(req.url).searchParams.get("targetType");
  if (!targetType || !["research", "solution", "prd"].includes(targetType)) {
    return NextResponse.json({ ok: false, error: "invalid_target_type" }, { status: 400 });
  }

  try {
    // 取该产物最新版本号（无 version 参数时）
    let version: number | null = null;
    const versionParam = new URL(req.url).searchParams.get("version");
    if (versionParam) {
      version = Number(versionParam);
    } else {
      const verTable: Record<string, string> = {
        research: "research_analysis_versions",
        solution: "solution_versions",
        prd: "prd_versions",
      };
      const rows = await db
        .findMany<{ version: number }>(verTable[targetType], {
          where: { requirement_id: { eq: params.id } },
          orderBy: [["version", "desc"]],
          limit: 1,
        })
        .catch(() => []);
      version = rows[0]?.version ?? null;
    }
    if (version == null) return NextResponse.json({ ok: true, data: [] });

    const sections = await db
      .findMany<{
        id: string;
        anchor: string;
        title: string;
        source: { conversation_turn?: number | null; decision_id?: string | null } | null;
      }>("doc_sections", {
        where: {
          requirement_id: { eq: params.id },
          target_type: { eq: targetType },
          version: { eq: version },
        },
        orderBy: [["anchor", "asc"]],
      })
      .catch(() => []);

    return NextResponse.json({ ok: true, data: sections });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
