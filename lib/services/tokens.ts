// API Token（PAT）服务：生成（哈希）、列表、撤销。
import crypto from "crypto";
import { db } from "@/lib/db";

// 哈希盐：让 token 哈希不可逆，且不同部署间不通用。可用 PAT_SALT 环境变量覆盖。
const TOKEN_SALT = process.env.PAT_SALT || "prdflow-pat-v1";

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

export async function listTokens(userId: string): Promise<ListTokenRow[]> {
  const rows = await db.list<TokenRow & { token_hash: string }>(
    "api_tokens",
    (r) => r.user_id === userId && !r.revoked_at
  );
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
  return rec;
}
