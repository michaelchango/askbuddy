import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "prd_session";

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
