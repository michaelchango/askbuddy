import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
const ENV_ID = process.env.CLOUDBASE_ENV_ID!;
const API_KEY = process.env.CLOUDBASE_SECRET!;
const BASE = `https://${ENV_ID}.api.tcloudbasegateway.com`;
async function raw(body: any) {
  const res = await fetch(`${BASE}/v1/rdb/exec-pgsql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: (await res.text()).slice(0, 200) };
}
async function main() {
  console.log("CREATE EXTENSION:", JSON.stringify(await raw({ Sql: "CREATE EXTENSION IF NOT EXISTS vector", Role: "cloudbase_postgres" })));
  console.log("verify:", JSON.stringify(await raw({ Sql: "SELECT extname FROM pg_extension WHERE extname='vector'", Role: "cloudbase_postgres" })));
  console.log("cast ok:", JSON.stringify(await raw({ Sql: "SELECT '[0.1,0.2,0.3]'::vector AS v", Role: "cloudbase_postgres" })));
}
main().catch((e) => { console.error(e); process.exit(1); });
