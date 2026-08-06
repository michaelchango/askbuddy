import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
const ENV_ID = process.env.CLOUDBASE_ENV_ID!;
const API_KEY = process.env.CLOUDBASE_SECRET!;
const BASE = `https://${ENV_ID}.api.tcloudbasegateway.com`;

async function raw(body: unknown) {
  const res = await fetch(`${BASE}/v1/rdb/exec-pgsql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function main() {
  // A. 真实表 SELECT 形态
  console.log("A real-table:", JSON.stringify(await raw({ Sql: "SELECT * FROM my_table LIMIT 1", Role: "cloudbase_postgres" })));
  // B. 参数化 + 类型
  console.log("B params(\$1,\$2):", JSON.stringify(await raw({ Sql: "SELECT $1::int AS a, $2::text AS b", Role: "cloudbase_postgres", Params: [5, "hi"] })));
  // C. 时间格式
  console.log("C now():", JSON.stringify(await raw({ Sql: "SELECT now() AS t", Role: "cloudbase_postgres" })));
  // D. jsonb
  console.log("D jsonb:", JSON.stringify(await raw({ Sql: "SELECT '[1,2,3]'::jsonb AS j", Role: "cloudbase_postgres" })));
  // E. vector
  console.log("E vector:", JSON.stringify(await raw({ Sql: "SELECT '[0.1,0.2,0.3]'::vector AS v", Role: "cloudbase_postgres" })));
  // F. 多行 + 写回
  console.log("F count:", JSON.stringify(await raw({ Sql: "SELECT count(*)::int AS n FROM my_table", Role: "cloudbase_postgres" })));
}
main().catch((e) => { console.error(e); process.exit(1); });
