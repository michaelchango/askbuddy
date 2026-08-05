import { NextRequest, NextResponse } from "next/server";
// 注意：Edge Runtime 不能 import lib/auth/session（其依赖 next/headers），
// 故从纯常量模块取 Cookie 名，保证与服务端读取侧完全一致。
import { SESSION_COOKIE } from "@/lib/auth/constants";

export function middleware(req: NextRequest) {
  const hasSession = req.cookies.get(SESSION_COOKIE);
  if (!hasSession) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard", "/dashboard/:path*"],
};
