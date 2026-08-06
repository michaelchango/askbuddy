import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
const ENV_ID = process.env.CLOUDBASE_ENV_ID!;
const API_KEY = process.env.CLOUDBASE_SECRET!;
const BASE = `https://${ENV_ID}.api.tcloudbasegateway.com`;
async function call(label: string, body: unknown) {
  const res = await fetch(`${BASE}/v1/rdb/exec-pgsql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`\n[${label}] HTTP ${res.status}`);
  console.log(text.slice(0, 400).replace(/\s+/g, " "));
}
async function main() {
  const tbl = "__probe_exec2";
  await call("DDL CREATE (cloudbase_postgres)", { Sql: `CREATE TABLE IF NOT EXISTS ${tbl} (id serial primary key, t text)`, Role: "cloudbase_postgres" });
  await call("INSERT (cloudbase_postgres)", { Sql: `INSERT INTO ${tbl} (t) VALUES ('hi') RETURNING id`, Role: "cloudbase_postgres" });
  await call("SELECT (cloudbase_postgres)", { Sql: `SELECT * FROM ${tbl}`, Role: "cloudbase_postgres" });
  await call("DROP (cloudbase_postgres)", { Sql: `DROP TABLE IF EXISTS ${tbl}`, Role: "cloudbase_postgres" });
}
main();
