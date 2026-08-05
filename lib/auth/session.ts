// 会话封装：读取 mock 会话 cookie（prd_session）。
// 真实模式改为 CloudBase Auth 校验（保持签名一致）。
import { cookies } from "next/headers";
import type { AuthUser } from "@/lib/cloudbase";

export const SESSION_COOKIE = "prd_session";

/**
 * 获取当前登录用户。
 *
 * 现状：开发期/过渡期固定返回开发用户 `mock-user-001`，保证应用在无真实登录流程时
 * 仍可正常读写（数据归属该 uid，并持久化到 CloudBase）。
 *
 * 后续任务：接入 CloudBase Auth 多用户登录——需要客户端登录 UI（@cloudbase/js-sdk
 * signIn）将会话令牌写入 cookie，这里再用 app.auth().verifyToken() 校验并返回真实 uid。
 */
export async function getSession(): Promise<AuthUser | null> {
  // 真实 CloudBase Auth 接入前，统一返回开发用户，使业务可持久化测试。
  return { uid: "mock-user-001", email: "dev@prdflow.local" };
}

/** 仅用于需要 cookie 存在性校验的场景（如 middleware 已在校验 cookie 名）。 */
export function hasSessionCookie(): boolean {
  return !!cookies().get(SESSION_COOKIE)?.value;
}
