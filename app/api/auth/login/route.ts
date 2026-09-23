import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { NICK_MAX_LEN, SESSION_COOKIE_MAX_AGE } from "@/lib/auth/constants";
import { recordVisit } from "@/lib/services/visits";

// 体验模式：昵称字符规则——字母/数字/_/-/空格，1-NICK_MAX_LEN 字。
// 拒绝 emoji 与控制字符，避免后续 SQL/JSONB 序列化与日志污染。
const NICK_RE = /^[\p{L}\p{N}_\- ]{1,20}$/u;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const raw = typeof body?.nickname === "string" ? body.nickname.trim() : "";
  const nickname = raw.slice(0, NICK_MAX_LEN);
  if (!NICK_RE.test(nickname)) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_nickname",
        message: "昵称仅支持字母/数字/_/-/空格，长度 1-20",
      },
      { status: 400 }
    );
  }
  // 记录一次体验访问（埋点失败不影响登录；await 以保证 serverless 下写库完成）。
  await recordVisit({
    nickname,
    userAgent: req.headers.get("user-agent"),
    referer: req.headers.get("referer"),
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  const res = NextResponse.json({ ok: true, data: { uid: nickname } });
  res.cookies.set(SESSION_COOKIE, nickname, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE,
  });
  return res;
}
