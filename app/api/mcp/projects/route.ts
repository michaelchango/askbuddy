import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";
import { listProjects } from "@/lib/services/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MCP 平台侧：列出当前用户的所有（未归档）项目。
export async function GET(_req: Request) {
  const user = await authenticate(_req);
  if (!user)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const projects = await listProjects(user.uid);
  return NextResponse.json({
    ok: true,
    data: projects.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description ?? "",
      status: p.status,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
  });
}
