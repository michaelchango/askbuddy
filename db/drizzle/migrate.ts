/**
 * db:migrate —— 把 db/drizzle/migrations 下由 drizzle-kit 生成的迁移应用到 CloudBase PostgreSQL。
 *
 * 【前置步骤】先跑 `npm run db:generate` 生成迁移 SQL（离线，只需 schema.ts）。
 * 【运行】DB_BACKEND=postgres npm run db:migrate
 *        或在 .env.local 填好 DATABASE_URL 后 npm run db:migrate
 *
 * 为什么用包装脚本而不是直接 `drizzle-kit migrate`：
 *   - drizzle-kit 的 CLI 不读 @next/env，拿不到 .env.local 里的 DATABASE_URL；
 *   - 这里先做两层防呆（占位串拒绝、迁移目录存在性），报错信息更友好；
 *   - drizzle-kit 0.24.x 生成迁移时会【丢弃】表上的 CHECK 约束（已知缺陷），
 *     因此本脚本在 drizzle migrator 跑完后，从 schema.ts 取出全部 check()
 *     定义，用幂等 DO 块补建，保证线上库与 db/schema.sql 的校验意图一致。
 * 迁移表为 _drizzle_migrations，由 drizzle-orm 的 migrator 自动维护，切勿手改。
 *
 * 注意：脚本体包在 main() 里，因为 tsx 默认按 CJS 编译，不支持顶层 await。
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";
import * as drizzleSchema from "./schema";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "db/drizzle/migrations");

/** 从 schema.ts 取出全部 CHECK 约束，幂等地补建到库里（drizzle-kit 0.24.x 会漏生成）。 */
async function applyChecks(sql: postgres.Sql): Promise<void> {
  let count = 0;
  for (const value of Object.values(drizzleSchema)) {
    let cfg;
    try {
      cfg = getTableConfig(value as PgTable);
    } catch {
      continue; // 非表导出（枚举 / 关系 / sql 辅助等）跳过
    }
    const checks = (cfg as unknown as { checks?: Array<{ name: string; value: unknown }> }).checks;
    if (!checks || checks.length === 0) continue;
    for (const chk of checks) {
      // chk.value 是 drizzle 的 SQL 片段，内嵌进 ALTER 语句由 postgres.js 递归编译成字面量。
      // 用 DO 块包一层 EXCEPTION，重复执行（约束已存在）时静默跳过，保证幂等。
      await sql`
        DO $$ BEGIN
          ALTER TABLE ${sql(cfg.name)} ADD CONSTRAINT ${sql(chk.name)} CHECK (${chk.value as never});
        EXCEPTION
          WHEN duplicate_object THEN null;
        END $$;
      `;
      count++;
    }
  }
  if (count > 0) console.log(`[db:migrate] ✓ 已补建 ${count} 个 CHECK 约束（drizzle-kit 漏生成部分）。`);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url || url.includes("__offline__")) {
    console.error("[db:migrate] ✗ 未配置真实的 DATABASE_URL。");
    console.error("  请在 .env.local 填入 CloudBase PostgreSQL 连接串，形如：");
    console.error("    DATABASE_URL=postgresql://<user>:<password>@<host>:<port>/<db>?sslmode=require");
    console.error("  注意它与 CLOUDBASE_SECRET(ApiKey) 是两套独立凭据，后者不能用于 SQL 连接。");
    process.exit(1);
  }

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`[db:migrate] ✗ 找不到迁移目录 ${MIGRATIONS_DIR}。`);
    console.error("  请先运行 `npm run db:generate` 生成迁移 SQL（离线）。");
    process.exit(1);
  }

  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);

  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    console.log("[db:migrate] ✓ drizzle 迁移已应用。");
    await applyChecks(sql);
    console.log("[db:migrate] ✓ 全部完成。");
  } catch (e) {
    console.error("[db:migrate] ✗ 迁移失败：", e);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main();
