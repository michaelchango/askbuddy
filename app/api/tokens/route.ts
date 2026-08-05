import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listTokens, createToken } from "@/lib/services/tokens";

export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const data = await listTokens(user.uid);
  return NextResponse.json({ ok: true, data });
}

export async function POST(req: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  if (!body?.name) {
    return NextResponse.json({ ok: false, error: "name required" }, { status: 400 });
  }
  const expiresInDays = typeof body.expires_in_days === "number" && body.expires_in_days > 0
    ? body.expires_in_days as number
    : undefined;
  const data = await createToken(user.uid, body.name, expiresInDays);
  return NextResponse.json({ ok: true, data }, { status: 201 });
}
