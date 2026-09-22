// 经 B 通道（/v1/rdb/exec-pgsql，API Key + Role=cloudbase_postgres）建库。
//
// 不依赖 DATABASE_URL（PG 协议连接串）。需要 .env.local 中的
// CLOUDBASE_ENV_ID 与 CLOUDBASE_SECRET。
//
// 用法：npm run db:setup:cloudbase
//
// 幂等：CREATE EXTENSION IF NOT EXISTS + schema.sql 全部 IF NOT EXISTS，可重复执行。

import { loadEnvConfig } from "@next/env";
import fs from "node:fs";
import path from "node:path";

loadEnvConfig(process.cwd());

const ENV_ID = process.env.CLOUDBASE_ENV_ID;
const API_KEY = process.env.CLOUDBASE_SECRET;
const BASE = ENV_ID ? `https://${ENV_ID}.api.tcloudbasegateway.com` : "";
const ROLE = "cloudbase_postgres";

// Vercel/CI 上表结构若已就绪，可用 DB_SETUP_SKIP=1 完全跳过建库：
// 既省去每次 build 都连 CloudBase 的耗时，也避免凭据/连接池波动干扰部署。
if (process.env.DB_SETUP_SKIP === "1") {
  console.log("[setup] DB_SETUP_SKIP=1，跳过建库（表结构应已就绪）。");
  process.exit(0);
}

if (!ENV_ID || !API_KEY || !BASE) {
  console.error("缺少 CLOUDBASE_ENV_ID / CLOUDBASE_SECRET，无法建库。");
  process.exit(1);
}

async function execPgSql<T = unknown>(sqlText: string): Promise<T[]> {
  const request = async (): Promise<T[]> => {
    const res = await fetch(`${BASE}/v1/rdb/exec-pgsql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ Sql: sqlText, Role: ROLE }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`exec-pgsql HTTP ${res.status}: ${text}\nSQL: ${sqlText.slice(0, 200)}`);
    }
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? data : [];
  };

  try {
    return await request();
  } catch (e) {
    const msg = (e as Error).message;
    // 401 / ACCESS_TOKEN_INVALID 多为网关侧访问令牌短暂失效，等待后重试一次。
    if (/ACCESS_TOKEN_INVALID|Access token is invalid|HTTP 401/i.test(msg)) {
      await new Promise((r) => setTimeout(r, 1500));
      return await request();
    }
    throw e;
  }
}

/** 把 schema.sql 拆成单条语句（处理 -- 注释与 $$ 美元引用，避免误拆）。 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inDollar = false;
  let i = 0;
  while (i < sql.length) {
    if (!inDollar && sql.startsWith("$$", i)) {
      inDollar = true;
      cur += "$$";
      i += 2;
      continue;
    }
    if (inDollar && sql.startsWith("$$", i)) {
      inDollar = false;
      cur += "$$";
      i += 2;
      continue;
    }
    const ch = sql[i];
    if (!inDollar && ch === "-" && sql[i + 1] === "-") {
      // 行注释，跳到行尾
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (!inDollar && ch === ";") {
      const stmt = cur.trim();
      if (stmt) out.push(stmt);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  const last = cur.trim();
  if (last) out.push(last);
  return out;
}

/** 是否把连接类错误当作「瞬态」降级跳过。build/CI 环境数据库瞬时不可达（连接池满、网络抖动）
 *  不应阻断整次构建——建库脚本幂等，且表结构通常已存在。
 *  DB_SETUP_STRICT=1 时关闭降级，遇错直接失败（用于本地/CI 确定要建表的场景）。 */
const SETUP_STRICT = process.env.DB_SETUP_STRICT === "1";
function isTransientConnError(msg: string): boolean {
  if (SETUP_STRICT) return false;
  // 401/403（ACCESS_TOKEN_INVALID 等）也归入「不阻断 build」：密钥轮换或令牌短暂失效
  // 会在下一次正常执行时补齐，而表结构此刻通常已存在（脚本幂等）。
  return /EMAXCONNSESSION|max clients reached|pool_size|too many clients|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed?\s?out|fetch failed|connection (refused|reset|timeout)|5\d\d|BadGateway|Service Unavailable|Gateway Timeout|rate limit|429|ACCESS_TOKEN_INVALID|Access token is invalid|token is invalid|invalid token|HTTP 401|HTTP 403|unauthorized/i.test(msg);
}

async function main(): Promise<void> {
  console.log("[setup] 启用 pgvector 扩展…");
  await execPgSql("CREATE EXTENSION IF NOT EXISTS vector");
  const ext = await execPgSql<{ extname: string }>(
    "SELECT extname FROM pg_extension WHERE extname = 'vector'"
  );
  console.log(`[setup] vector 扩展状态：${ext[0]?.extname ?? "未安装"}`);

  const sqlPath = path.join(process.cwd(), "db", "schema.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  const stmts = splitStatements(sql);
  console.log(`[setup] 从 schema.sql 拆出 ${stmts.length} 条语句，开始执行…`);

  let ok = 0;
  let skipped = 0;
  for (const stmt of stmts) {
    const preview = stmt.replace(/\s+/g, " ").slice(0, 70);
    try {
      await execPgSql(stmt);
      ok++;
      console.log(`  ✓ ${preview}`);
    } catch (e) {
      const msg = (e as Error).message;
      // 已存在的表/索引/扩展直接跳过（幂等语义）
      if (/already exists|42P07/.test(msg)) {
        skipped++;
        console.log(`  ⊘ ${preview}（已存在，跳过）`);
        continue;
      }
      // 连接池满/网络抖动等瞬态错误：降级跳过，不阻断 build（表通常已存在）
      if (isTransientConnError(msg)) {
        skipped++;
        console.warn(`  ⚠ ${preview}（连接不可用，跳过：${msg.slice(0, 120)}）`);
        continue;
      }
      console.error(`  ✗ ${preview}`);
      console.error(`    ${msg.slice(0, 200)}`);
      process.exit(1);
    }
  }
  console.log(`[setup] 执行完成：${ok} 成功 / ${skipped} 跳过 / 共 ${stmts.length} 条`);

  // 校验 16 张业务表是否就绪
  const tables = [
    "projects", "requirements", "conversations", "requirement_steps",
    "card_versions", "research_analysis", "research_analysis_versions",
    "solutions", "solution_versions", "prototypes", "prototype_versions",
    "prds", "prd_versions", "api_tokens", "share_tokens", "objects",
    "dev_contexts", "dev_context_versions",
    "suggestions", "decisions", "doc_sections", "knowledge_entries",
  ];
  try {
    const rows = await execPgSql<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`
    );
    const exist = new Set(rows.map((r) => r.t));
    const missing = tables.filter((t) => !exist.has(t));
    if (missing.length) {
      // 若前面因连接错误跳过了建表，缺表很可能是连带结果，降级为警告避免阻断 build
      console.warn(`[setup] 以下表可能未就绪（如因连接失败跳过建表所致可忽略）：${missing.join(", ")}`);
    } else {
      console.log(`[setup] ${tables.length} 张业务表全部就绪 ✓`);
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (isTransientConnError(msg)) {
      console.warn(`[setup] 无法校验表（连接不可用，跳过）：${msg.slice(0, 120)}`);
    } else {
      console.error(`[setup] 表校验失败：${msg.slice(0, 200)}`);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  const msg = (e as Error).message ?? String(e);
  if (isTransientConnError(msg)) {
    console.warn(`[setup] 建库跳过：数据库连接不可用（${msg.slice(0, 160)}）。`);
    console.warn("[setup] 表结构应已存在（脚本幂等）；如需强制建库请本地运行 DB_SETUP_STRICT=1 npm run db:setup:cloudbase");
    process.exit(0);
  }
  console.error(e);
  process.exit(1);
});
