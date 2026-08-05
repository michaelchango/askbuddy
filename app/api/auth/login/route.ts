import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";

export async function POST(_req: NextRequest) {
  // Mock：固定开发用户，设置 httpOnly 会话 cookie
  const res = NextResponse.json({ ok: true, data: { uid: "mock-user-001" } });
  res.cookies.set(SESSION_COOKIE, "mock-user-001", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  return res;
}
