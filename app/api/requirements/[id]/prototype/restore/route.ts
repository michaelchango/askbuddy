import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";
import { restoreVersion } from "@/lib/services/prototypes";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await authenticate(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  if (!body?.version) {
    return NextResponse.json({ ok: false, error: "version required" }, { status: 400 });
  }
  await restoreVersion(params.id, body.version);
  return NextResponse.json({ ok: true });
}
