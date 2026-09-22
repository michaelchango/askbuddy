import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listProjects, createProject } from "@/lib/services/projects";

// 数据库在境内，函数固定在香港区域，缩短每趟 SQL 跨网关往返（覆盖 Vercel 后台 region 设置）。
export const regions = ["hkg1"];

export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const data = await listProjects(user.uid);
  return NextResponse.json({ ok: true, data });
}

export async function POST(req: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ ok: false, error: "name required" }, { status: 400 });
  }
  // 同名校验：同一用户下、未删除的项目中不能重名（忽略大小写）
  const existing = await listProjects(user.uid);
  if (existing.some((p) => p.name.trim().toLowerCase() === name.toLowerCase())) {
    return NextResponse.json(
      { ok: false, error: "name_exists", message: "已存在同名项目，请更换项目名称" },
      { status: 409 }
    );
  }
  const data = await createProject({
    name,
    description: body.description,
    ownerId: user.uid,
  });
  return NextResponse.json({ ok: true, data }, { status: 201 });
}
