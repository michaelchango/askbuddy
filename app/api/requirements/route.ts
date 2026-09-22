import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getProject } from "@/lib/services/projects";
import {
  listRequirements,
  listRequirementsForOwner,
  createRequirement,
} from "@/lib/services/requirements";

export async function GET(req: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (projectId) {
    // 体验模式安全：先校验 projectId 归属当前 user，否则被人塞个别人 projectId 也能读
    const project = await getProject(projectId);
    if (!project || project.ownerId !== user.uid) {
      return NextResponse.json({ ok: false, error: "project_not_found" }, { status: 404 });
    }
    // listRequirements 已按 updatedAt DESC 排序（idx_req_project 索引下推），
    // route 层不再做内存 sort，避免无意义的 CPU 浪费。
    const data = await listRequirements(projectId);
    return NextResponse.json({ ok: true, data });
  }
  // 不带 projectId：返回当前用户全部需求（跨项目），按更新时间倒序
  const data = await listRequirementsForOwner(user.uid);
  return NextResponse.json({ ok: true, data });
}

export async function POST(req: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  const projectId = body?.projectId;
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "projectId required" }, { status: 400 });
  }
  // 体验模式安全修复：防止别人塞个别人的 projectId 进来写需求。
  // 不存在 / 不归属当前 user 一律视为"不存在"，避免泄露对方 projectId 是否真实存在。
  const project = await getProject(projectId);
  if (!project || project.ownerId !== user.uid) {
    return NextResponse.json({ ok: false, error: "project_not_found" }, { status: 404 });
  }
  const data = await createRequirement({
    projectId,
    title: body.title ?? "", // 允许空标题，后续对话自动生成
    card: body.card,
  });
  return NextResponse.json({ ok: true, data }, { status: 201 });
}
