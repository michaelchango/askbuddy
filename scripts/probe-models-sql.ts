/**
 * 验证 node-sdk `app.models` 原始 SQL 端点（/v1/sql）能否仅凭 CLOUDBASE_SECRET(API Key) 跑 SQL。
 * 这是「免 DATABASE_URL、免腾讯云密钥」建库/读写的候选黄金路径。
 *
 * 步骤：
 *   1) SELECT 1            —— 确认端点+凭据可用
 *   2) SELECT version()    —— 确认能触达真实 PG
 *   3) CREATE 临时表 + DROP —— 证明 DDL 也可用（建完即删，不留痕迹）
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

async function main() {
  const tcb = (await import("@cloudbase/node-sdk")).default;
  const env = process.env.CLOUDBASE_ENV_ID!;
  const secret = process.env.CLOUDBASE_SECRET!;

  const app = tcb.init({ env, accessKey: secret });
  const models = (app as any).models;

  console.log("models 上的 raw SQL 方法:", Object.keys(models).filter((k: string) => k.startsWith("$")));

  // 1) 基础 SELECT
  const r1 = await models.$runSQL("SELECT 1 AS ok");
  console.log("✓ $runSQL(SELECT 1):", JSON.stringify(r1?.data ?? r1));

  // 2) 触达真实 PG
  const r2 = await models.$runSQLRaw("SELECT version() AS v");
  const v = (r2?.data?.executeResultList ?? [])[0]?.v ?? "(无结果)";
  console.log("✓ $runSQLRaw(version):", v.slice(0, 60));

  // 3) DDL 冒烟：建 + 删
  const tbl = "__probe_models_sql";
  await models.$runSQLRaw(`CREATE TABLE IF NOT EXISTS ${tbl} (id serial primary key, t text)`);
  const r3 = await models.$runSQLRaw(`INSERT INTO ${tbl} (t) VALUES ('hello') RETURNING id, t`);
  console.log("✓ DDL INSERT:", JSON.stringify(r3?.data?.executeResultList ?? r3?.data));
  await models.$runSQLRaw(`DROP TABLE IF EXISTS ${tbl}`);
  console.log("✓ DROP 临时表完成（无残留）");

  console.log("\n结论：app.models.$runSQL/$runSQLRaw 仅凭 CLOUDBASE_SECRET 即可跑 SELECT/DDL。");
}

main().catch((e) => {
  console.error("✗ 失败：", e?.message ?? e);
  process.exit(1);
});
