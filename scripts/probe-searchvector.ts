import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
const ENV_ID = process.env.CLOUDBASE_ENV_ID!;
const API_KEY = process.env.CLOUDBASE_SECRET!;
const BASE = `https://${ENV_ID}.api.tcloudbasegateway.com`;
const ROLE = "cloudbase_postgres";

async function exec(sql: string): Promise<any[]> {
  const res = await fetch(`${BASE}/v1/rdb/exec-pgsql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ Sql: sql, Role: ROLE }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const d = await res.json();
  return Array.isArray(d) ? d : [];
}

async function main(): Promise<void> {
  await exec("DROP TABLE IF EXISTS probe_vec");
  await exec("CREATE TABLE probe_vec (id text primary key, embedding vector(3))");
  await exec(
    "INSERT INTO probe_vec (id, embedding) VALUES ('a', '[1,0,0]'), ('b', '[0,1,0]'), ('c', '[0,0,1]'), ('d', '[0.9,0.1,0]')"
  );
  const q = "[1,0,0]";
  const rows = await exec(
    `SELECT id, (1 - (embedding <=> '${q}'::vector)) AS score ` +
      `FROM probe_vec ORDER BY embedding <=> '${q}'::vector ASC LIMIT 4`
  );
  console.log("nearest-first:", JSON.stringify(rows));
  const ids = rows.map((r: any) => r.id);
  const ok = ids[0] === "a" && Number(rows[0].score) > Number(rows[1].score);
  console.log(ok ? "PASS: pgvector <=> 检索排序正确" : "FAIL: 排序异常");
  await exec("DROP TABLE IF EXISTS probe_vec");
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
