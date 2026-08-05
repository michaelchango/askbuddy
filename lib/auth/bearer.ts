// 统一鉴权：Bearer Token（PAT）优先，否则回落到 mock 会话。
// 用于让 MCP 等外部调用方用 PAT 访问资源接口，同时不破坏浏览器 cookie 登录。
import { getSession } from "./session";
import { verifyToken } from "@/lib/services/tokens";

export interface AuthUser {
  uid: string;
  tokenId?: string;
}

export async function authenticate(req: Request): Promise<AuthUser | null> {
  const auth =
    req.headers.get("authorization") || req.headers.get("Authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    const rec = await verifyToken(token);
    if (!rec) return null; // Bearer 提供但无效 → 直接拒绝
    return { uid: rec.user_id, tokenId: rec.id };
  }
  const session = await getSession();
  return session ? { uid: session.uid } : null;
}
