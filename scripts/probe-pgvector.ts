import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
const ENV_ID = process.env.CLOUDBASE_ENV_ID!;
const API_KEY = process.env.CLOUDBASE_SECRET!;
const BASE = `https://${ENV_ID}.api.tcloudbasegateway.com`;
async function main() {
  // 1) pgvector 可用性（决定 M4 方案）
  const r1 = await fetch(`${BASE}/v1/rdb/exec-pgsql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ Sql: "SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name IN ('vector','vectorscale','zhparser','pg_jieba') ORDER BY name", Role: "cloudbase_postgres" }),
  });
  console.log("[pgvector/扩展] HTTP", r1.status, (await r1.text()).replace(/\s+/g, " "));
  // 2) 当前数据库名 + 已存在表（确认我们建的表还没建）
  const r2 = await fetch(`${BASE}/v1/rdb/exec-pgsql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ Sql: "SELECT current_database() AS db, (SELECT count(*) FROM information_schema.tables WHERE table_schema='public') AS tbl_count", Role: "cloudbase_postgres" }),
  });
  console.log("[db/表数] HTTP", r2.status, (await r2.text()).replace(/\s+/g, " "));
}
main();
