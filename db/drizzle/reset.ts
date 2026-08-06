/**
 * db:reset —— 开发/测试用：DROP 全部 16 张表 + drizzle 迁移表，回到空库。
 *
 * ⚠️ 危险操作，会清空所有数据。防呆三道闸（任一不满足都不执行）：
 *   1. 生产环境（NODE_ENV=production）直接拒绝；
 *   2. 必须显式设置 DB_RESET_CONFIRM=1；
 *   3. 仅在拿到真实 DATABASE_URL 时执行（拒绝离线占位串）。
 *
 * 用法：DB_RESET_CONFIRM=1 npm run db:reset
 * 之后通常接：npm run db:generate && npm run db:migrate && npm run db:seed
 */
import postgres from "postgres";

// 与 lib/db/field-map.ts 的 TABLES 保持一致。这里独立列出一份是为了 reset 不依赖
// 启动整个 Next 应用栈（reset 是纯运维脚本，越轻量越好）。
const TABLES = [
  "projects",
  "requirements",
  "conversations",
  "requirement_steps",
  "card_versions",
  "research_analysis",
  "research_analysis_versions",
  "solutions",
  "solution_versions",
  "prototypes",
  "prototype_versions",
  "prds",
  "prd_versions",
  "api_tokens",
  "share_tokens",
  "objects",
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url || url.includes("__offline__")) {
    console.error("[db:reset] ✗ 未配置真实的 DATABASE_URL，拒绝执行。");
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production") {
    console.error("[db:reset] ✗ 拒绝在生产环境执行 reset。");
    process.exit(1);
  }
  if (process.env.DB_RESET_CONFIRM !== "1") {
    console.error("[db:reset] ⚠️ 危险操作：将 DROP 全部 16 张表（含 _drizzle_migrations）。");
    console.error("  确认要清空数据库，请设置 DB_RESET_CONFIRM=1 后重试。");
    process.exit(1);
  }

  const sql = postgres(url, { max: 1 });
  try {
    // 表间有外键，用 CASCADE 一次性级联删除最省心。
    await sql.unsafe(`DROP TABLE IF EXISTS ${TABLES.join(", ")} CASCADE;`);
    await sql.unsafe(`DROP TABLE IF EXISTS _drizzle_migrations CASCADE;`);
    console.log(`[db:reset] ✓ 已清空 ${TABLES.length} 张表 + 迁移表。`);
  } catch (e) {
    console.error("[db:reset] ✗ 失败：", e);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main();
