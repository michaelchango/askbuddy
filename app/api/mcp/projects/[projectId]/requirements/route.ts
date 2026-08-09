import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";
import { getProject } from "@/lib/services/projects";
import { listRequirements } from "@/lib/services/requirements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MCP 平台侧：列出某项目下的需求（需归属校验，避免跨用户越权读取）。
export async function GET(
  _req: Request,
  { params }: { params: { projectId: string } }
) {
  const user = await authenticate(_req);
  if (!user)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const project = await getProject(params.projectId);
  if (!project || project.ownerId !== user.uid)
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const reqs = await listRequirements(params.projectId);
  return NextResponse.json({
    ok: true,
    data: reqs.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      projectId: r.projectId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  });
}
