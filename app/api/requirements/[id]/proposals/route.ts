import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getRequirement } from "@/lib/services/requirements";
import { getProject } from "@/lib/services/projects";
import { listSuggestions, type ProposalStatus } from "@/lib/services/proposals";

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

// GET：列出某需求的建议卡（可按 status 过滤；默认返回全部）。
// 前端对话面板据此渲染 pending 建议卡，并在响应后即时刷新。
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authorize(params.id);
  if (auth.error) return auth.error;

  const statusParam = new URL(req.url).searchParams.get("status");
  const status = statusParam && ["pending", "accepted", "edited", "ignored"].includes(statusParam)
    ? (statusParam as ProposalStatus)
    : undefined;

  const list = await listSuggestions(params.id, status);
  return NextResponse.json({ ok: true, data: list });
}
