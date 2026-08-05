// 公开分享页：凭 token 直接返回原型 HTML（token 本身即访问凭据，无需登录）。
import { resolveSharedPrototype } from "@/lib/services/prototypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { token: string } }
) {
  const data = await resolveSharedPrototype(params.token);
  if (!data) {
    return new Response("原型不存在或链接已失效", {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return new Response(data.html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
