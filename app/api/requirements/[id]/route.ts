import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  getRequirement,
  getRequirementWithStatus,
  updateRequirementTitle,
  mergeRequirementCard,
  deleteRequirement,
} from "@/lib/services/requirements";
import { getProject } from "@/lib/services/projects";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const req = await getRequirementWithStatus(params.id);
  if (!req) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const project = await getProject(req.projectId);
  if (!project || project.ownerId !== user.uid) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, data: req });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  if (body?.title !== undefined) {
    await updateRequirementTitle(params.id, body.title, "manual");
  }
  if (body?.card !== undefined) {
    await mergeRequirementCard(params.id, body.card);
  }
  return NextResponse.json({ ok: true, data: { id: params.id } });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const req = await getRequirement(params.id);
  if (!req) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const project = await getProject(req.projectId);
  if (!project || project.ownerId !== user.uid) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  await deleteRequirement(params.id);
  return NextResponse.json({ ok: true, data: { id: params.id } });
}
