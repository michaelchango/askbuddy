/**
 * 确认 REST(PostgREST) 通道对业务表真正可用（不只是根 OpenAPI）。
 * 用已验证的 API Key(Bearer) 对 my_table 做 SELECT，确认读权限与 RLS 不挡。
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

const ENV_ID = process.env.CLOUDBASE_ENV_ID!;
const API_KEY = process.env.CLOUDBASE_SECRET!;
const BASE = `https://${ENV_ID}.api.tcloudbasegateway.com`;

async function main() {
  // 1) SELECT 业务表
  const r = await fetch(`${BASE}/v1/rdb/rest/my_table?select=*&limit=1`, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
  });
  const text = await r.text();
  console.log(`[SELECT my_table] HTTP ${r.status}`);
  console.log(text.slice(0, 500).replace(/\s+/g, " "));

  // 2) 看 my_table 的列结构（OpenAPI 里没有，但可 POST 一个非法值逼出 schema，或直接 HEAD 取单行列名）
  const head = await fetch(`${BASE}/v1/rdb/rest/my_table?select=*&limit=0`, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
  });
  console.log(`\n[HEAD/empty my_table] HTTP ${head.status}`);
  console.log((await head.text()).slice(0, 300).replace(/\s+/g, " "));
}

main().catch((e) => console.error("失败:", e?.message ?? e));
