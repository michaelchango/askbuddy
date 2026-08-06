/**
 * verify:embedding —— 校验 embedding 维度与向量存储策略（M1 既定方案）。
 *
 * 【背景】当前 CloudBase PostgreSQL 实例未提供 pgvector 扩展（CREATE EXTENSION vector 被拒，
 * 见 docs/ops/pgvector-enabled.md）。因此 M1 的向量检索骨架（lib/db/postgres.ts:searchVector）
 * 用 PostgreSQL 原生 real[]（float4[]）存储 embedding，相似度在 Node 应用层用余弦距离计算。
 * 本脚本做两件事：
 *   1. 校验 EMBEDDING_DIM 是合法正整数（默认 1024，与主流 text-embedding-3-small/large 对齐）。
 *   2. 若提供了真实 DATABASE_URL + DB_BACKEND=postgres，探测 pgvector 是否可用，
 *      并打印明确结论：不可用 → 确认 real[] 回落是必选项；可用 → 提示 M4 可下推但 M1 不启用。
 *
 * 退出码：0 维度合法（无论 pgvector 是否可用）；1 维度非法或探测异常。
 *
 * 运行：npm run verify:embedding
 *       npx tsx scripts/verify-embedding.ts
 *
 * 注意：脚本体包在 main() 里，因为 tsx 默认按 CJS 编译，不支持顶层 await。
 */
import postgres from "postgres";

const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 1024);

function fail(msg: string): never {
  console.error(`[verify:embedding] ✗ ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!Number.isInteger(EMBEDDING_DIM) || EMBEDDING_DIM <= 0) {
    fail(`EMBEDDING_DIM 非法："${process.env.EMBEDDING_DIM}"，必须是正整数（默认 1024）。`);
  }

  console.log(`[verify:embedding] EMBEDDING_DIM = ${EMBEDDING_DIM}`);

  const url = process.env.DATABASE_URL?.trim();
  const backend = process.env.DB_BACKEND?.trim().toLowerCase();

  if (!url || !url.includes("postgresql") || backend !== "postgres" || url.includes("__offline__")) {
    console.log(
      "[verify:embedding] 未提供真实 PG 连接（DATABASE_URL + DB_BACKEND=postgres），" +
        "跳过 pgvector 可用性探测。"
    );
    console.log(
      "[verify:embedding] ✓ 按 M1 既定方案：embedding 以 real[] 存储，应用层余弦相似度。" +
        "（pgvector 可用后改造路径见 lib/db/postgres.ts:searchVector 注释）"
    );
    return;
  }

  const sql = postgres(url, { max: 1 });
  try {
    const rows = await sql`SELECT 1 AS ok FROM pg_available_extensions WHERE name = 'vector'`;
    const hasVector = (rows as unknown[]).length > 0;
    if (hasVector) {
      console.log(
        "[verify:embedding] ℹ️ 本实例已提供 pgvector 扩展。" +
          "但 M1 仍采用 real[] 应用层余弦（schema 已落定、无需回退），" +
          "M4 知识复利接入时如需下推可启用 vector 类型（ALTER COLUMN ... TYPE vector(1024)）。"
      );
    } else {
      console.log(
        "[verify:embedding] ✓ 确认 pgvector 不可用（与 docs/ops/pgvector-enabled.md 一致）。" +
          "M1 采用 real[] + 应用层余弦相似度为必选项。"
      );
    }
  } catch (e) {
    console.error("[verify:embedding] ✗ 探测过程异常：", e);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main();
