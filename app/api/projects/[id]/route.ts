import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  archiveProject,
  updateProject,
  isProjectNameTaken,
  getProject,
} from "@/lib/services/projects";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const project = await getProject(params.id);
  if (!project || project.ownerId !== user.uid) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, data: project });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  // 无 body 或 action=archive → 软删除（兼容现有删除调用）
  const body = await req.json().catch(() => null);
  if (!body || body.action === "archive") {
    await archiveProject(params.id);
    return NextResponse.json({ ok: true, data: { id: params.id, status: "archived" } });
  }

  // 编辑改名：校验同名冲突（排除自身）
  if (typeof body.name === "string" && body.name.trim()) {
    const taken = await isProjectNameTaken(user.uid, body.name, params.id);
    if (taken) {
      return NextResponse.json(
        { ok: false, error: "name_exists", message: "已存在同名项目，请更换项目名称" },
        { status: 409 }
      );
    }
  }

  const updated = await updateProject(params.id, {
    name: body.name,
    description: body.description,
  });
  return NextResponse.json({ ok: true, data: updated });
}
