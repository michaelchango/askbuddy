// 会话封装：体验模式从 cookie 读昵称作为 uid；未读到则回退到开发用户。
// 真实模式改为 CloudBase Auth 校验（保持签名一致）。
import { cookies } from "next/headers";
import type { AuthUser } from "@/lib/cloudbase";
import { SESSION_COOKIE } from "@/lib/auth/constants";

// 保持历史导入路径可用：既有代码从 "@/lib/auth/session" 取 SESSION_COOKIE。
export { SESSION_COOKIE };

/** 「体验模式回退用户」——所有未走 /try 的本地 dev / 旧浏览器会话都映射到这里，
 *  保证历史存量数据（owner_id="mock-user-001"）仍可访问。 */
const FALLBACK_DEV_UID = "mock-user-001";

/**
 * 获取当前登录用户。
 *
 * 体验模式：优先从 `askbuddy_session` cookie 读昵称作为 uid。
 *   - cookie 存在但值为空 / 仅空白 → 视为未注册，回退到开发用户（不抛错）。
 *   - cookie 缺失 → 回退到开发用户。
 *
 * 真实 CloudBase Auth 接入后这里改为 `app.auth().verifyToken()` → uid；本函数签名不变。
 */
export async function getSession(): Promise<AuthUser | null> {
  const raw = cookies().get(SESSION_COOKIE)?.value;
  const nick = raw?.trim();
  if (nick) {
    return { uid: nick, email: `${nick}@try.askbuddy.local` };
  }
  // ⚠️ uid 保持 FALLBACK_DEV_UID 不变：现网存量数据均以该 uid 归属，回退了"老现场"。
  return { uid: FALLBACK_DEV_UID, email: "dev@askbuddy.local" };
}

/** 仅用于需要 cookie 存在性校验的场景（如 middleware 已在校验 cookie 名）。 */
export function hasSessionCookie(): boolean {
  return !!cookies().get(SESSION_COOKIE)?.value;
}
