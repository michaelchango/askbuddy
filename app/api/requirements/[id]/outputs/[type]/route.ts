import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getOutput, type OutputType } from "@/lib/services/outputs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/requirements/:id/outputs/:type?version=2&subType=prototype
const VALID: OutputType[] = ["card", "research_analysis", "design", "prd"];

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; type: string } }
) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!VALID.includes(params.type as OutputType)) {
    return NextResponse.json({ ok: false, error: "unknown output type" }, { status: 400 });
  }
  const v = req.nextUrl.searchParams.get("version");
  const s = req.nextUrl.searchParams.get("subType") ?? undefined;
  const data = await getOutput(
    params.id,
    params.type as OutputType,
    v ? Number(v) : undefined,
    s
  );
  return NextResponse.json({ ok: true, data });
}
