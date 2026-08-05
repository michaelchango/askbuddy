import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/bearer";
import { listVersions } from "@/lib/services/prototypes";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = await authenticate(_req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const data = await listVersions(params.id);
  return NextResponse.json({ ok: true, data });
}
