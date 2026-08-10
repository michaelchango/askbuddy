// M3 数据库迁移：把 M3 新增的表与列增量应用到（已存在的）CloudBase PostgreSQL。
//
// 背景：db/schema.sql / db/drizzle/schema.ts 已描述完整目标结构，但 db-setup-cloudbase.ts
// 对「已存在的表」会跳过（already exists），所以已上线库不会自动获得新增列。
// 本脚本用幂等的 IF NOT EXISTS 把 M3 的增量结构补齐，可重复执行。
//
// 用法：npm run db:migrate:m3
//
// 仅改结构（ADD COLUMN / CREATE TABLE），不碰数据；与 db-setup-cloudbase.ts 共用 B 通道。

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const ENV_ID = process.env.CLOUDBASE_ENV_ID;
const API_KEY = process.env.CLOUDBASE_SECRET;
const BASE = ENV_ID ? `https://${ENV_ID}.api.tcloudbasegateway.com` : "";
const ROLE = "cloudbase_postgres";

if (!ENV_ID || !API_KEY || !BASE) {
  console.error("缺少 CLOUDBASE_ENV_ID / CLOUDBASE_SECRET，无法迁移。");
  process.exit(1);
}

async function execPgSql<T = unknown>(sqlText: string): Promise<T[]> {
  const res = await fetch(`${BASE}/v1/rdb/exec-pgsql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ Sql: sqlText, Role: ROLE }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`exec-pgsql HTTP ${res.status}: ${text}\nSQL: ${sqlText.slice(0, 200)}`);
  }
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? data : [];
}

// 幂等 DDL：列/表已存在即跳过（PG 的 IF NOT EXISTS 不报错，仅给 notice）。
const STATEMENTS: string[] = [
  // 新增表（若尚未由 db-setup:cloudbase 创建）
  `CREATE TABLE IF NOT EXISTS suggestions (
    id TEXT NOT NULL PRIMARY KEY,
    requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('research','solution','prototype','prd','dev_context')),
    target_path TEXT NULL,
    op TEXT NOT NULL CHECK (op IN ('add','modify','remove')),
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','edited','ignored')),
    source JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS decisions (
    id TEXT NOT NULL PRIMARY KEY,
    requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    suggestion_id TEXT NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
    summary TEXT NULL,
    conversation_turn INTEGER NULL,
    confirmed_by TEXT NULL,
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS doc_sections (
    id TEXT NOT NULL PRIMARY KEY,
    requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('research','solution','prd')),
    version INTEGER NULL,
    anchor TEXT NOT NULL,
    title TEXT NULL,
    source JSONB NOT NULL
  )`,

  // 已有版本表新增 changelog 列（结构化变更记录）
  `ALTER TABLE card_versions ADD COLUMN IF NOT EXISTS card_source JSONB NULL`,
  `ALTER TABLE card_versions ADD COLUMN IF NOT EXISTS changelog JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE research_analysis_versions ADD COLUMN IF NOT EXISTS changelog JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE solution_versions ADD COLUMN IF NOT EXISTS changelog JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE prototype_versions ADD COLUMN IF NOT EXISTS changelog JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE prd_versions ADD COLUMN IF NOT EXISTS changelog JSONB NOT NULL DEFAULT '[]'::jsonb`,
];

async function main(): Promise<void> {
  let ok = 0;
  for (const stmt of STATEMENTS) {
    const preview = stmt.replace(/\s+/g, " ").slice(0, 80);
    try {
      await execPgSql(stmt);
      ok++;
      console.log(`  ✓ ${preview}`);
    } catch (e) {
      console.error(`  ✗ ${preview}\n    ${(e as Error).message.slice(0, 200)}`);
      process.exit(1);
    }
  }
  console.log(`[migrate-m3] 完成：${ok}/${STATEMENTS.length} 条增量 DDL 已应用 ✓`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
