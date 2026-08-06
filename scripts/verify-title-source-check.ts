import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
const ENV_ID = process.env.CLOUDBASE_ENV_ID;
const API_KEY = process.env.CLOUDBASE_SECRET;
const BASE = `https://${ENV_ID}.api.tcloudbasegateway.com`;
const ROLE = "cloudbase_postgres";

async function execPgSql<T = unknown>(sqlText: string): Promise<T[]> {
  const res = await fetch(`${BASE}/v1/rdb/exec-pgsql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ Sql: sqlText, Role: ROLE }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? data : [];
}

async function main(): Promise<void> {
  const rows = await execPgSql<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ck_req_title_source'`
  );
  console.log("LIVE ck_req_title_source DEF:", rows[0]?.def ?? "(缺失)");
}
main().catch((e) => { console.error(e); process.exit(1); });
