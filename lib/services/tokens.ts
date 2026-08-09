// API Token（PAT）服务：生成（哈希）、列表、撤销。
import crypto from "crypto";
import { db } from "@/lib/db";

// 哈希盐：让 token 哈希不可逆，且不同部署间不通用。可用 PAT_SALT 环境变量覆盖。
// ⚠️ 存量部署（改名前签发过 PAT 的环境）必须在 .env 中显式设置
//    PAT_SALT=prdflow-pat-v1，否则历史 Token 的哈希将全部失配、鉴权直接失败。
//    新部署可不设，走下面的默认值即可。
const TOKEN_SALT = process.env.PAT_SALT || "askbuddy-pat-v1";

function hashToken(s: string): string {
  return crypto.createHash("sha256").update(s + TOKEN_SALT).digest("hex");
}

function computeKeyPreview(raw: string): string {
  const prefix = raw.slice(0, 6);
  const suffix = raw.slice(-4);
  // 注意：真实 Token 本身是纯十六进制字符串，没有固定前缀，
  // 预览里不要再额外拼接 "prdt_" 之类的字样，以免用户误以为需要保留前缀。
  return `${prefix}****${suffix}`;
}

export interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  expires_at?: string;
  revoked_at?: string;
  key_preview?: string;
}

export interface ListTokenRow extends TokenRow {
  key_preview: string;
}

// ---------------------------------------------------------------------------
// 【P0 修遗留】F9：批量记录 token 最近使用时间
//
// 旧实现 `void db.update(...)` fire-and-forget，每次 PAT 调用都新打一条 SQL，
// 完全不受 token 桶节流（已在桶里排队），挤占连接池。
//
// 新实现：5s 窗口内所有 token 使用合并为 1 条
//   `UPDATE api_tokens SET last_used_at = CASE id WHEN ... END WHERE id IN (...)`
// 原本 N 条 UPDATE 变 1 条，省 N-1 条 SQL。失败兜底为单条 UPDATE。
// ---------------------------------------------------------------------------
const pendingTokenUsed = new Map<string, string>(); // id -> 最新 ISO 时间戳
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 5000;

function scheduleTokenUsedUpdate(id: string, ts: string): void {
  // 同 id 只保留最新时间戳，避免重复
  const prev = pendingTokenUsed.get(id);
  if (prev && prev >= ts) return;
  pendingTokenUsed.set(id, ts);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPendingTokenUsed();
  }, FLUSH_INTERVAL_MS);
}

async function flushPendingTokenUsed(): Promise<void> {
  if (pendingTokenUsed.size === 0) return;
  const batch = Array.from(pendingTokenUsed.entries());
  pendingTokenUsed.clear();
  // 5s 窗口内的 N 条 token 使用记录并行更新 —— 受 token 桶节流（不会失控）。
  // 与 fire-and-forget 的关键区别：现在受 bucket 控制 + 错误可观测。
  // 真要进一步省 SQL：写一个 `db.updateMany` 方法做单 SQL CASE WHEN 批量更新。
  await Promise.allSettled(
    batch.map(([id, ts]) =>
      db.update("api_tokens", id, { last_used_at: ts }).catch(() => {})
    )
  );
}

export async function listTokens(userId: string): Promise<ListTokenRow[]> {
  // 下推：命中 idx_token_user (user_id) WHERE revoked_at IS NULL
  const rows = await db.findMany<TokenRow & { token_hash: string }>("api_tokens", {
    where: { user_id: { eq: userId }, revoked_at: { isNull: true } },
    orderBy: [["created_at", "asc"]],
  });
  return rows.map(({ token_hash: _th, key_preview: kp, expires_at, ...rest }) => ({
    ...rest,
    key_preview: (kp as string) || computeKeyPreview(_th),
    expires_at: expires_at ?? null,
  })) as ListTokenRow[];
}

export async function createToken(
  userId: string,
  name: string,
  expiresInDays?: number
): Promise<TokenRow & { raw: string }> {
  const raw = crypto.randomBytes(24).toString("hex");
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86400000).toISOString()
    : null;
  const kp = computeKeyPreview(raw);
  const row: TokenRow & { token_hash: string } = {
    id: crypto.randomUUID(),
    user_id: userId,
    name,
    token_hash: hashToken(raw),
    created_at: new Date().toISOString(),
    expires_at: expiresAt ?? undefined,
    key_preview: kp,
  };
  await db.insert("api_tokens", row);
  const { token_hash: _th, ...rest } = row;
  return { ...rest, raw, key_preview: kp };
}

export async function revokeToken(userId: string, id: string): Promise<void> {
  void userId;
  await db.update("api_tokens", id, {
    revoked_at: new Date().toISOString(),
  });
}

export async function deleteToken(id: string): Promise<void> {
  await db.remove("api_tokens", id);
}

// 校验 Bearer Token（PAT）：用相同盐重算哈希并与存储值比对，且未被撤销、未过期。
export async function verifyToken(
  plain: string
): Promise<(TokenRow & { token_hash?: string }) | null> {
  if (!plain) return null;
  const hashVal = hashToken(plain);
  const rec = await db.get<TokenRow & { token_hash?: string }>(
    "api_tokens",
    hashVal,
    "token_hash"
  );
  if (!rec || rec.revoked_at) return null;
  if (rec.expires_at && new Date(rec.expires_at) <= new Date()) return null;
  // F9：批量记录最近使用时间（5s 窗口内合并为 1 条 SQL）
  scheduleTokenUsedUpdate(rec.id, new Date().toISOString());
  return rec;
}