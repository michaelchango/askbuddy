import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
const ENV_ID = process.env.CLOUDBASE_ENV_ID!;
const API_KEY = process.env.CLOUDBASE_SECRET!;
const BASE = `https://${ENV_ID}.api.tcloudbasegateway.com`;
async function call(body: any) {
  const res = await fetch(`${BASE}/v1/rdb/exec-pgsql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: (await res.text()).slice(0, 160) };
}
async function main() {
  console.log("1 \$1 single:", JSON.stringify(await call({ Sql: "SELECT $1 AS a", Role: "cloudbase_postgres", Params: [5] })));
  console.log("2 Params array + no cast:", JSON.stringify(await call({ Sql: "SELECT $1 AS a, $2 AS b", Role: "cloudbase_postgres", Params: [5, "hi"] })));
  console.log("3 params lower:", JSON.stringify(await call({ Sql: "SELECT $1 AS a", Role: "cloudbase_postgres", params: [7] })));
  console.log("4 parameters:", JSON.stringify(await call({ Sql: "SELECT $1 AS a", Role: "cloudbase_postgres", parameters: [7] })));
  console.log("5 named :a:", JSON.stringify(await call({ Sql: "SELECT :a AS a", Role: "cloudbase_postgres", Params: { a: 7 } })));
  console.log("6 @p1:", JSON.stringify(await call({ Sql: "SELECT @p1 AS a", Role: "cloudbase_postgres", Params: { p1: 7 } })));
  console.log("7 inline works:", JSON.stringify(await call({ Sql: "SELECT 7 AS a", Role: "cloudbase_postgres" })));
}
main().catch((e) => { console.error(e); process.exit(1); });
