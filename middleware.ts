import { NextRequest, NextResponse } from "next/server";
// 注意：Edge Runtime 不能 import lib/auth/session（其依赖 next/headers），
// 故从纯常量模块取 Cookie 名，保证与服务端读取侧完全一致。
import { SESSION_COOKIE } from "@/lib/auth/constants";

export function middleware(req: NextRequest) {
  const hasSession = req.cookies.get(SESSION_COOKIE);
  if (!hasSession) {
    // feat/try-mode-deploy：体验模式下没 cookie → 跳 /try 走昵称登录；
    // 不跳 /login 是为了不破坏老登录 UI（待正式 Auth 接入后切换）。
    return NextResponse.redirect(new URL("/try", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard", "/dashboard/:path*", "/login", "/login/:path*"],
};
