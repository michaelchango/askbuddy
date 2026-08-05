import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { revokeToken } from "@/lib/services/tokens";

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  await revokeToken(user.uid, params.id);
  return NextResponse.json({ ok: true });
}
