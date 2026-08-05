import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
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
    const data = await listRequirements(projectId);
    data.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return NextResponse.json({ ok: true, data });
  }
  // 不带 projectId：返回当前用户全部需求（跨项目），按更新时间倒序
  const data = await listRequirementsForOwner(user.uid);
  data.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return NextResponse.json({ ok: true, data });
}

export async function POST(req: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  if (!body?.projectId) {
    return NextResponse.json({ ok: false, error: "projectId required" }, { status: 400 });
  }
  const data = await createRequirement({
    projectId: body.projectId,
    title: body.title ?? "", // 允许空标题，后续对话自动生成
    card: body.card,
  });
  return NextResponse.json({ ok: true, data }, { status: 201 });
}
