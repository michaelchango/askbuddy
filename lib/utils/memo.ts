// 通用内存缓存工具：用于减少对 CloudBase PG 连接池的频繁访问。
//
// 设计要点：
// - 简单 TTL 过期（不主动失效）：适合「读多写少」场景；
//   写操作稀少时，数据 5s 内可能略陈旧，但这是连接池存活与数据新鲜度的合理折中。
// - 命中失败/拒绝时原样透传给底层函数（不破坏错误语义）。
// - 大对象不缓存（防止内存泄漏）：>256KB 的结果不缓存。
// - 同一 key 并发命中自动复用 in-flight Promise（防止雪崩）。
//
// 用法：
//   const cached = memo(
//     (projectId: string) => `listReq:${projectId}`,  // keyFn: 从参数生成缓存 key
//     5_000,
//     async (projectId: string) => fetchList(projectId)
//   );
//   const data = await cached("proj-123");
//
//   // 失效：
//   invalidateCache("listReq:proj-123");  // 删精确 key
//   invalidateCache("listReq:*");         // 删前缀匹配全部

const MAX_CACHE_SIZE_BYTES = 256 * 1024; // 256 KB

interface CacheEntry<T> {
  value: T | undefined;
  expiresAt: number;
  inflight?: Promise<T>;
}

const store = new Map<string, CacheEntry<unknown>>();

/** 简易大小估算（防止巨大对象吃光内存）。 */
function estimateSize(v: unknown): number {
  try {
    return JSON.stringify(v).length;
  } catch {
    return 0;
  }
}

/**
 * 构造一个带缓存 + in-flight 复用的异步函数包装器。
 *
 * @param keyFn 从参数生成缓存 key（不同参数自然得到不同 key）
 * @param ttlMs 过期时间（ms）
 * @param fn 实际的异步函数（接收与外层一致的参数）
 * @returns 包装后的函数（同参数列表，返回 Promise<T>）
 */
export function memo<Args extends unknown[], T>(
  keyFn: (...args: Args) => string,
  ttlMs: number,
  fn: (...args: Args) => Promise<T>
): (...args: Args) => Promise<T> {
  return async (...args: Args): Promise<T> => {
    const key = keyFn(...args);
    const now = Date.now();
    const hit = store.get(key) as CacheEntry<T> | undefined;

    // 命中且未过期 → 直接返回
    if (hit && hit.expiresAt > now && !hit.inflight) {
      return hit.value as T;
    }

    // 命中且有 in-flight Promise → 复用（防止雪崩）
    if (hit?.inflight) {
      return hit.inflight;
    }

    // 失效或不存在 → 启动新 Promise
    const p = fn(...args).finally(() => {
      const e = store.get(key);
      if (e) e.inflight = undefined;
    });
    store.set(key, { value: undefined, expiresAt: now + ttlMs, inflight: p });

    try {
      const value = await p;
      // 大对象不缓存（直接返回）
      if (estimateSize(value) > MAX_CACHE_SIZE_BYTES) {
        store.delete(key);
        return value;
      }
      store.set(key, { value, expiresAt: now + ttlMs });
      return value;
    } catch (e) {
      store.delete(key);
      throw e;
    }
  };
}

/** 失效指定 key（精确匹配或 prefix:* 通配）。 */
export function invalidateCache(keyOrPrefix: string): number {
  let n = 0;
  if (keyOrPrefix.endsWith("*")) {
    const prefix = keyOrPrefix.slice(0, -1);
    for (const k of store.keys()) {
      if (k.startsWith(prefix)) {
        store.delete(k);
        n++;
      }
    }
  } else {
    if (store.delete(keyOrPrefix)) n = 1;
  }
  return n;
}

/** 清空全部缓存（调试 / 测试用）。 */
export function clearAllCache(): void {
  store.clear();
}

/** 当前缓存大小（用于调试 / 监控）。 */
export function cacheSize(): number {
  return store.size;
}