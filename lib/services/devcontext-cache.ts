// DevContext GET 的服务端短时缓存（M5-D2 抽出为共享模块）。
//
// 为什么抽出来：定向重算 API 跑完后必须让读取端**立刻**看到新内容。缓存原本是
// dev-context/route.ts 的模块私有变量，重算路由够不到它 → 面板会在重算后
// 最多 5 秒内读到旧 JSON（用户看到「点了重算但没变化」，是最难被理解的假故障）。
//
// TTL 5s 与面板轮询 5s 恰好 1:1 去重：既省跨网关查询，又不会积压过期数据。
import { NextResponse } from "next/server";

const DC_CACHE_TTL_MS = 5000;

interface DcCacheEntry {
  json: string;
  ts: number;
}

const dcCache = new Map<string, DcCacheEntry>();

/** 命中则直接返回可复用的响应（零 DB 连接）。 */
export function getCachedDc(id: string): NextResponse<unknown> | null {
  const entry = dcCache.get(id);
  if (!entry) return null;
  if (Date.now() - entry.ts > DC_CACHE_TTL_MS) {
    dcCache.delete(id);
    return null;
  }
  return new NextResponse(entry.json, {
    status: 200,
    headers: { "Content-Type": "application/json", "X-Cache": "hit" },
  });
}

export function setCachedDc(id: string, data: unknown): void {
  dcCache.set(id, { json: JSON.stringify(data), ts: Date.now() });
}

/** 写操作（重算 / 全量生成）后必须调用，否则读取端会看到旧快照。 */
export function invalidateDcCache(id: string): void {
  dcCache.delete(id);
}
