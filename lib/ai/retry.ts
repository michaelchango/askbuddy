// AI 重试与错误分类（M5-D3）。
//
// 参数直接移植 askbuddy-legacy 已验证的取值：3 次 / 800ms 基数指数退避。
// 抖动（jitter）必须可关闭，否则会破坏 mock 的确定性——确定性是 D4/D5 全部
// 验收断言的地基，任何一处随机都会造成 flaky test，而 flaky 的 CI 等于没有 CI。

export const MAX_ATTEMPTS = 3;
export const BASE_BACKOFF_MS = 800;
/** 抖动上限（用调用序号派生，不用 Math.random）。 */
const JITTER_MAX_MS = 200;

export type AIErrorCode = "AI_TIMEOUT" | "AI_RATE_LIMITED" | "AI_UNAVAILABLE" | "AI_BAD_REQUEST";

export interface ClassifiedAIError {
  code: AIErrorCode;
  status: number;
  message: string;
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * 错误分类 → HTTP 语义。
 *   timeout            → 504
 *   限流 / 429         → 429
 *   其他 4xx（客户端）  → 400
 *   其余（含 5xx/网络） → 502
 *
 * 注意：`ServiceNotActivated`（服务未开通）被归到 502——它是**服务端**状态，
 * 不是用户请求错了；把它当 400 会引导用户去改参数，方向完全错。
 */
export function classifyAIError(e: unknown): ClassifiedAIError {
  const message = messageOf(e);
  const low = message.toLowerCase();

  if (/timeout|timed out|etimedout|超时|aborted|aborterror/.test(low)) {
    return { code: "AI_TIMEOUT", status: 504, message };
  }
  if (/429|rate ?limit|too many requests|限流|频率限制/.test(low)) {
    return { code: "AI_RATE_LIMITED", status: 429, message };
  }
  // 显式 4xx（排除 408/429，上面已处理）
  const m = message.match(/\b(4\d{2})\b/);
  if (m && m[1] !== "408" && m[1] !== "429") {
    return { code: "AI_BAD_REQUEST", status: 400, message };
  }
  return { code: "AI_UNAVAILABLE", status: 502, message };
}

/** 是否值得重试：超时 / 限流 / 5xx / 网络抖动 / 已知可恢复的服务端错误。 */
export function isRetryableAIError(e: unknown): boolean {
  const low = messageOf(e).toLowerCase();
  if (/4\d{2}/.test(low) && !/408|429/.test(low)) return false; // 明确 4xx 不重试
  return /timeout|timed out|etimedout|econnreset|econnrefused|socket|429|rate ?limit|5\d{2}|servicenotactivated|emaxconnsession|unavailable|超时|限流/.test(
    low
  );
}

/** 已分类的 AI 调用错误：调用方（SSE 路由）据此决定 HTTP 状态码。 */
export class AICallError extends Error {
  readonly code: AIErrorCode;
  readonly status: number;

  constructor(classified: ClassifiedAIError) {
    super(classified.message);
    this.name = "AICallError";
    this.code = classified.code;
    this.status = classified.status;
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  /** 退避基数（ms）。测试传 0 即可跳过等待。 */
  baseBackoffMs?: number;
  isRetryable?: (e: unknown) => boolean;
  /** 取消信号：aborted 后立即停止重试（不再无意义地烧配额）。 */
  signal?: AbortSignal;
  /** 每次失败后的回调（供结构化日志记录 attempts）。 */
  onAttemptFailed?: (e: unknown, attempt: number) => void;
}

/**
 * 指数退避重试：`BASE * 2^(n-1) + jitter`。
 *
 * jitter 由**调用序号**派生（不是 Math.random）：
 *   - 多实例同时重试时能错开峰值（抖动存在的唯一理由）；
 *   - 同一调用序列的结果可复现，测试可断言。
 * `AI_RETRY_JITTER=0` 或 `baseBackoffMs=0` 时抖动为 0。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  // 退避基数可经 AI_RETRY_BASE_MS 覆盖（测试置 0 即可跳过真实等待——
  // 否则一次重试用例要白等 2.4s，CI 会被这类等待拖垮）
  const base =
    opts.baseBackoffMs ??
    (process.env.AI_RETRY_BASE_MS !== undefined
      ? Number(process.env.AI_RETRY_BASE_MS) || 0
      : BASE_BACKOFF_MS);
  const isRetryable = opts.isRetryable ?? isRetryableAIError;
  const jitterEnabled = base > 0 && process.env.AI_RETRY_JITTER !== "0";

  let attempt = 0;
  let lastErr: unknown;
  let callIndex = 0;

  for (; attempt < maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new Error("AI 调用已取消（signal aborted）");
    try {
      return await fn(attempt + 1);
    } catch (e) {
      lastErr = e;
      opts.onAttemptFailed?.(e, attempt + 1);
      const isLast = attempt === maxAttempts - 1;
      if (isLast || !isRetryable(e) || opts.signal?.aborted) break;
      const backoff = base * Math.pow(2, attempt);
      const jitter = jitterEnabled ? (callIndex++ * 37) % JITTER_MAX_MS : 0;
      await sleep(backoff + jitter).catch(() => undefined);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
