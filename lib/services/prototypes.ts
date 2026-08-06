// 原型服务：HTML 原型的持久化、版本管理、分享链接。
// 真实 AI 生成发生在 lib/ai/steps/prototype.ts（streamPrototype），本模块只负责数据存取。
import crypto from "crypto";
import { db } from "@/lib/db";
import { putObject, getObject } from "@/lib/storage";

export interface PrototypeStructure {
  pages: Array<{ id: string; title: string; path?: string }>;
}

export interface PrototypeData {
  html: string;
  structure: PrototypeStructure | null;
  model?: string;
}

export interface PrototypeVersion {
  version: number;
  note?: string;
  created_at?: string;
  html_storage_key?: string;
  structure: PrototypeStructure | null;
  model?: string | null;
}

function htmlKeyFor(requirementId: string, version: number): string {
  return `proto-html/v${version}/${requirementId}`;
}

// 取原型 HTML：默认取最新版本；指定 version 时取该历史版本。
export async function getPrototypeHtml(
  requirementId: string,
  version?: number
): Promise<string> {
  let rec:
    | { html_storage_key?: string }
    | null
    | undefined;
  if (version != null) {
    // 用记录真实 id（requirementId-vN）精确查找，避免 version 字段数字与字符串
    // 严格相等不匹配（mock 下 db.get 用 === 比较），导致取回空内容。
    rec = await db.get<{ html_storage_key?: string }>(
      "prototype_versions",
      `${requirementId}-v${version}`
    );
  } else {
    rec = await db.get<{ html_storage_key?: string }>("prototypes", requirementId, "requirement_id");
  }
  if (!rec || !rec.html_storage_key) return "";
  const html = await getObject(rec.html_storage_key);
  return html ?? "";
}

// 列出某需求的全部原型版本。
export async function listVersions(requirementId: string): Promise<PrototypeVersion[]> {
  // 下推：命中 idx_proto_ver_req (requirement_id, version)
  const rows = await db.findMany<{
    version: number;
    note?: string;
    created_at?: string;
    html_storage_key?: string;
    structure: PrototypeStructure | null;
    model?: string | null;
  }>("prototype_versions", {
    where: { requirement_id: { eq: requirementId } },
    orderBy: [["version", "asc"]],
  });
  return rows.map((r) => ({
    version: r.version,
    note: r.note,
    created_at: r.created_at,
    html_storage_key: r.html_storage_key,
    structure: r.structure ?? null,
    model: r.model ?? null,
  }));
}

// 落库一个新原型版本（自增版本号），并返回版本号与结构。
export async function savePrototypeVersion(
  requirementId: string,
  data: PrototypeData,
  _baseVersionId?: number
): Promise<{ version: number; html_storage_key: string; structure: PrototypeStructure | null }> {
  const now = new Date().toISOString();
  const current = await db.get<{ current_version: number }>("prototypes", requirementId, "requirement_id");
  const version = (current?.current_version ?? 0) + 1;
  const key = htmlKeyFor(requirementId, version);

  await putObject(key, data.html);

  await db.insert("prototype_versions", {
    id: `${requirementId}-v${version}`,
    requirement_id: requirementId,
    version,
    structure: data.structure ?? null,
    html_storage_key: key,
    model: data.model ?? null,
    created_at: now,
  });

  const latest = {
    id: requirementId,
    requirement_id: requirementId,
    current_version: version,
    version,
    structure: data.structure ?? null,
    html_storage_key: key,
    model: data.model ?? null,
    upstream_ids: [],
    maybe_stale: 0,
    updated_at: now,
  };
  if (current) {
    await db.update("prototypes", requirementId, latest, "requirement_id");
  } else {
    await db.insert("prototypes", latest);
  }

  return { version, html_storage_key: key, structure: data.structure ?? null };
}

// 回退到指定版本：将该版本内容设为最新。
export async function restoreVersion(
  requirementId: string,
  version: number
): Promise<{ version: number }> {
  const v = await db.get<{
    version: number;
    structure: PrototypeStructure | null;
    html_storage_key?: string;
    model?: string | null;
  }>("prototype_versions", `${requirementId}-v${version}`);
  if (!v) throw new Error("版本不存在");
  const now = new Date().toISOString();
  await db.update("prototypes", requirementId, {
    current_version: v.version,
    version: v.version,
    structure: v.structure ?? null,
    html_storage_key: v.html_storage_key ?? null,
    model: v.model ?? null,
    updated_at: now,
  }, "requirement_id");
  return { version: v.version };
}

// ---------- 分享链接 ----------

export async function createShareToken(
  requirementId: string,
  expiresInDays?: number
): Promise<{ token: string; url: string }> {
  const token = crypto.randomBytes(16).toString("hex");
  const now = new Date().toISOString();
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86400000).toISOString()
    : null;
  await db.insert("share_tokens", {
    id: token,
    requirement_id: requirementId,
    type: "prototype",
    created_at: now,
    expires_at: expiresAt,
  });
  return { token, url: `/share/prototype/${token}` };
}

export async function getShareToken(requirementId: string): Promise<string | null> {
  // 下推：命中 idx_share_req (requirement_id, type, created_at DESC)，只取最新一条
  const rows = await db.findMany<{ id: string; created_at: string }>("share_tokens", {
    where: { requirement_id: { eq: requirementId }, type: { eq: "prototype" } },
    orderBy: [["created_at", "desc"]],
    limit: 1,
  });
  return rows[0]?.id ?? null;
}

// 凭分享 token 解析原型（公开访问，无需登录）。token 本身即访问凭据。
export async function resolveSharedPrototype(
  token: string
): Promise<{ html: string; structure: PrototypeStructure | null; requirementId: string } | null> {
  const rec = await db.get<{
    requirement_id: string;
    expires_at?: string;
  }>("share_tokens", token);
  if (!rec) return null;
  if (rec.expires_at && new Date(rec.expires_at).getTime() < Date.now()) return null;

  const html = await getPrototypeHtml(rec.requirement_id);
  if (!html) return null;
  const latest = await db.get<{ structure: PrototypeStructure | null }>(
    "prototypes",
    rec.requirement_id,
    "requirement_id"
  );
  return {
    html,
    structure: latest?.structure ?? null,
    requirementId: rec.requirement_id,
  };
}
