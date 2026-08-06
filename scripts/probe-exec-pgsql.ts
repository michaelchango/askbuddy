/**
 * 实测官方管理端 SQL 执行接口 /v1/rdb/exec-pgsql，凭据用 API Key(Bearer)。
 * 文档称「仅管理员可调用(TC3签名 / B端管理员Token / API Key)」——若成立，
 * 则凭 CLOUDBASE_SECRET 即可跑任意 SQL（含 DDL），免 DATABASE_URL、免腾讯云密钥。
 *
 * 试两种 body 字段名（Sql / sql），并做 DDL 冒烟（建+删临时表）。
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

const ENV_ID = process.env.CLOUDBASE_ENV_ID!;
const API_KEY = process.env.CLOUDBASE_SECRET!;
const BASE = `https://${ENV_ID}.api.tcloudbasegateway.com`;

async function call(label: string, body: unknown) {
  try {
    const res = await fetch(`${BASE}/v1/rdb/exec-pgsql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`\n[${label}] HTTP ${res.status}`);
    console.log(text.slice(0, 400).replace(/\s+/g, " "));
    return res.status;
  } catch (e) {
    console.log(`\n[${label}] 网络错误: ${(e as Error).message}`);
    return 0;
  }
}

async function main() {
  // 1) 简单查询，试两种字段名
  await call("Sql(大写)", { Sql: "SELECT 1 AS ok" });
  await call("sql(小写)", { sql: "SELECT 1 AS ok" });
  await call("Sql+Role", { Sql: "SELECT version() AS v", Role: "service_role" });

  // 2) DDL 冒烟：建临时表 + 插入 + 删
  const tbl = "__probe_exec_pgsql";
  await call("DDL CREATE", { Sql: `CREATE TABLE IF NOT EXISTS ${tbl} (id serial primary key, t text)` });
  await call("DDL INSERT", { Sql: `INSERT INTO ${tbl} (t) VALUES ('hi') RETURNING id`, Role: "service_role" });
  await call("DDL DROP", { Sql: `DROP TABLE IF EXISTS ${tbl}` });
}

main();
