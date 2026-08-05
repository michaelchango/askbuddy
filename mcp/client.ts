// PrdFlow 平台 HTTP 客户端：MCP Server 通过它调用 PrdFlow 后端 API（携带 PAT）。
const BASE = (process.env.PRDFLOW_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.PRDFLOW_TOKEN || "";

export interface PlatformError extends Error {
  status?: number;
}

export async function callPlatform<T = unknown>(path: string): Promise<T> {
  const url = `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`PrdFlow API ${res.status}: ${text.slice(0, 200)}`) as PlatformError;
    err.status = res.status;
    throw err;
  }

  const json = (await res.json()) as { ok?: boolean; error?: string; data?: T };
  if (json && json.ok === false) {
    throw new Error(json.error || "PrdFlow API error");
  }
  return json.data as T;
}
