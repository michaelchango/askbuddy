// 客户端统一请求封装：解析 ApiResult，失败抛错。
export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    // 默认 no-store（调用方仍可用 init.cache 覆盖）。
    // 本项目接口全是「当前状态」语义（需求卡片、步骤、对话…），必须读最新值。
    // 服务端响应未带 Cache-Control 时浏览器会做启发式缓存，SWR revalidate 也会
    // 因此拿到旧响应，表现为「后端已经更新、界面却不动」。
    cache: "no-store",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const json = (await res.json()) as ApiResult<T>;
  if (!json.ok) throw new Error(json.error || "request failed");
  return json.data as T;
}
