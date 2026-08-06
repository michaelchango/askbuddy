// 一次性热修：requirements.title_source 的 CHECK 约束值域与代码契约不一致。
//
// 问题：代码 TitleSource = "auto" | "manual" | null（types/index.ts），
// 但库里旧约束只允许 ('manual','ai')，导致 UPDATE ... title_source='auto' 触发
// DATABASE_23514 check constraint 违规。
//
// 修复：删掉旧的 title_source CHECK（旧 auto 名 requirements_title_source_check，
// 以及可能由 drizzle migrate 建的 ck_req_title_source），重建为显式名
// ck_req_title_source，值域 ('manual','auto')。与 db/schema.sql、db/drizzle/schema.ts 对齐。
//
// 用法：npx tsx scripts/db-fix-title-source-check.ts
// 依赖 .env.local 的 CLOUDBASE_ENV_ID / CLOUDBASE_SECRET（走 B 通道，免 DATABASE_URL）。

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const ENV_ID = process.env.CLOUDBASE_ENV_ID;
const API_KEY = process.env.CLOUDBASE_SECRET;
const BASE = ENV_ID ? `https://${ENV_ID}.api.tcloudbasegateway.com` : "";
const ROLE = "cloudbase_postgres";

if (!ENV_ID || !API_KEY || !BASE) {
  console.error("缺少 CLOUDBASE_ENV_ID / CLOUDBASE_SECRET，无法执行热修。");
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

async function main(): Promise<void> {
  // 列出 requirements 表上的全部 CHECK 约束
  const cons = await execPgSql<{ conname: string }>(
    `SELECT c.conname FROM pg_constraint c
     JOIN pg_class t ON c.conrelid = t.oid
     WHERE t.relname = 'requirements' AND c.contype = 'c'`
  );
  console.log(`[fix] requirements 现有 CHECK 约束：${cons.map((c) => c.conname).join(", ") || "(无)"}`);

  // 删除与 title_source 相关的旧约束（无论旧名还是 drizzle 名），再重建为正确版本
  for (const c of cons) {
    if (c.conname === "requirements_title_source_check" || c.conname === "ck_req_title_source") {
      console.log(`[fix] DROP CONSTRAINT ${c.conname}`);
      await execPgSql(`ALTER TABLE requirements DROP CONSTRAINT IF EXISTS "${c.conname}"`);
    }
  }

  console.log(`[fix] ADD CONSTRAINT ck_req_title_source CHECK (title_source IN ('manual','auto'))`);
  await execPgSql(
    `ALTER TABLE requirements ADD CONSTRAINT ck_req_title_source
     CHECK (title_source IS NULL OR title_source IN ('manual', 'auto'))`
  );

  // 校验
  const after = await execPgSql<{ conname: string }>(
    `SELECT c.conname FROM pg_constraint c
     JOIN pg_class t ON c.conrelid = t.oid
     WHERE t.relname = 'requirements' AND c.contype = 'c' AND c.conname = 'ck_req_title_source'`
  );
  if (after.length === 0) {
    console.error("[fix] ✗ 修复后未找到 ck_req_title_source，热修失败");
    process.exit(1);
  }
  console.log("[fix] ✓ ck_req_title_source 已就位，值域 ('manual','auto')");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
