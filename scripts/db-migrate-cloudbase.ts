// cloudbase 网关库迁移脚本（drizzle 的 migrate 不会自动跑到 cloudbase 真实库）。
// 读取 db/drizzle/migrations/*.sql，按 --> statement-breakpoint 拆成单条语句，
// 逐条在 cloudbase 网关上幂等执行（CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
// DO $$ ... EXCEPTION WHEN duplicate_object ... 等均为幂等）。
// 这样以后任何新迁移（0004、0005...）加的列都会自动补到真实库。
//
// 用法：
//   npx tsx scripts/db-migrate-cloudbase.ts        # 迁移所有未应用的 DDL
// 由 start_dev.bat 在启动 dev server 前自动调用。

import { loadEnvConfig } from "@next/env";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

loadEnvConfig(process.cwd());

const ENV_ID = process.env.CLOUDBASE_ENV_ID;
const API_KEY = process.env.CLOUDBASE_SECRET;
const BASE = ENV_ID ? `https://${ENV_ID}.api.tcloudbasegateway.com` : "";
const ROLE = "cloudbase_postgres";
const MIGRATIONS_DIR = join(process.cwd(), "db", "drizzle", "migrations");

if (!ENV_ID || !API_KEY || !BASE) {
  console.error("[migrate] 缺少 CLOUDBASE_ENV_ID / CLOUDBASE_SECRET，跳过 cloudbase 迁移。");
  process.exit(0); // 非 cloudbase 后端时不阻塞启动
}

const TRANSIENT = /EMAXCONNSESSION|max clients reached|DATABASE_XX000|429|503|ECONNRESET|ETIMEDOUT|timed out/i;
const MAX_ATTEMPTS = 12;

async function execPgSql(sqlText: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${BASE}/v1/rdb/exec-pgsql`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          Connection: "close",
        },
        body: JSON.stringify({ Sql: sqlText, Role: ROLE }),
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text();
        if (TRANSIENT.test(text)) {
          lastErr = new Error(`exec-pgsql HTTP ${res.status}: ${text}`);
          throw lastErr;
        }
        // 非瞬时错误直接抛出（会终止迁移并暴露真实问题）
        throw new Error(`exec-pgsql HTTP ${res.status}: ${text}\nSQL: ${sqlText.slice(0, 200)}`);
      }
      return;
    } catch (e) {
      lastErr = e;
      if (!TRANSIENT.test(e instanceof Error ? e.message : String(e))) throw e;
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) =>
          setTimeout(r, 400 * Math.pow(2, attempt) + Math.floor(Math.random() * 200))
        );
      }
    }
  }
  throw lastErr;
}

function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.replace(/--.*$/gm, "").trim()) // 去注释
    .filter((s) => s.length > 0);
}

export async function runMigrate(): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && /^\d+_/.test(f))
    .sort();

  console.log(`[migrate] 发现 ${files.length} 个迁移文件，开始对 cloudbase 网关库应用（幂等）...`);
  let total = 0;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const stmts = splitStatements(sql);
    for (const stmt of stmts) {
      await execPgSql(stmt);
      total++;
    }
    console.log(`  ✓ ${file} (${stmts.length} 条语句)`);
  }
  console.log(`[migrate] 完成，共执行 ${total} 条语句。`);
}

async function main() {
  await runMigrate();
}

// 仅当作为入口直接运行时才自执行（被其他脚本 import 时不触发）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("[migrate] 失败：", e);
    process.exit(1);
  });
}
