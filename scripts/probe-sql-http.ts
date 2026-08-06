/**
 * 直接对 /v1/sql（raw SQL 端点）发 HTTP，复用 REST 探针已验证可用的 API Key(Bearer)。
 * 目的是确认「免 DATABASE_URL、免腾讯云密钥」能否跑 raw SQL（含 DDL）。
 * 同时试几种常见请求体格式，捕获原始响应以反推端点契约。
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

const ENV_ID = process.env.CLOUDBASE_ENV_ID!;
const API_KEY = process.env.CLOUDBASE_SECRET!;
const BASE = `https://${ENV_ID}.api.tcloudbasegateway.com`;

async function tryBody(label: string, body: unknown, headers: Record<string, string> = {}) {
  try {
    const res = await fetch(`${BASE}/v1/sql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`\n[${label}] HTTP ${res.status}`);
    console.log(text.slice(0, 400).replace(/\s+/g, " "));
  } catch (e) {
    console.log(`\n[${label}] 网络错误: ${(e as Error).message}`);
  }
}

async function main() {
  console.log("BASE:", BASE);

  // 形态1：{ sql: "..." }（OrmRawQueryClient.$runSQLRaw 推测）
  await tryBody("shape1 {sql}", { sql: "SELECT 1 AS ok" });

  // 形态2：{ sql, params }（参数化）
  await tryBody("shape2 {sql,params}", { sql: "SELECT 1 AS ok", params: {} });

  // 形态3：{ query: "..." }
  await tryBody("shape3 {query}", { query: "SELECT 1 AS ok" });

  // 形态4：带 X-Db-Instance 头（rdb 客户端用的实例头）
  await tryBody("shape4 +X-Db-Instance", { sql: "SELECT 1 AS ok" }, { "X-Db-Instance": "default" });
}

main();
