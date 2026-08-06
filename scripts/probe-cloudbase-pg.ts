/**
 * CloudBase PostgreSQL 多通道连通性探针
 *
 * 【为什么需要这个脚本】
 * CloudBase PG 有四条互相独立的接入通道，各自用不同的凭据、走不同的网络路径，
 * 任何一条不通都不能推断其它三条的状态。实例开通过程中它们的就绪时间也不一致。
 * 与其逐条手工试错，不如一次性全打一遍，用一屏输出回答「现在能干什么」。
 *
 *   通道 A  PostgREST REST     凭据 CLOUDBASE_SECRET(API Key)  → CRUD，无事务/无 DDL
 *   通道 B  云API ExecutePGSql 凭据 TENCENTCLOUD_SECRET_ID/KEY → 任意 SQL 含 DDL
 *   通道 C  PG 协议直连        凭据 DATABASE_URL               → 完整 SQL + 事务 + 连接池
 *   通道 D  pgvector 可用性    依赖 B 或 C                     → 决定 M4 走真向量还是应用层 cosine
 *
 * 缺凭据的通道会明确标 SKIP 并说明缺什么，不会伪装成失败。
 *
 * 用法：npm run db:probe
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

type Status = "OK" | "FAIL" | "SKIP";
interface Result {
  channel: string;
  status: Status;
  detail: string;
  hint?: string;
}

const results: Result[] = [];
function record(channel: string, status: Status, detail: string, hint?: string) {
  results.push({ channel, status, detail, hint });
  const icon = status === "OK" ? "✓" : status === "SKIP" ? "—" : "✗";
  console.log(`${icon} [${channel}] ${detail}`);
  if (hint) console.log(`    ${hint}`);
}

const ENV_ID = process.env.CLOUDBASE_ENV_ID ?? "";
const API_KEY = process.env.CLOUDBASE_SECRET ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const TC_SECRET_ID = process.env.TENCENTCLOUD_SECRET_ID ?? "";
const TC_SECRET_KEY = process.env.TENCENTCLOUD_SECRET_KEY ?? "";
const REGION = process.env.TENCENTCLOUD_REGION ?? "ap-shanghai";

const BASE = `https://${ENV_ID}.api.tcloudbasegateway.com`;

/** 把响应体截断到可读长度，避免 OpenAPI schema 刷屏 */
function brief(text: string, max = 300): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/* ────────────────────────── 通道 A：PostgREST REST ────────────────────────── */
async function probeRest() {
  if (!ENV_ID || !API_KEY) {
    record("A/REST", "SKIP", "缺 CLOUDBASE_ENV_ID 或 CLOUDBASE_SECRET");
    return;
  }

  // PostgREST 根端点返回 OpenAPI 描述，其中 paths 的键就是所有对外暴露的表/视图。
  // 用它探活比查某张具体的表更准：不会被「表不存在」的错误干扰。
  try {
    const res = await fetch(`${BASE}/v1/rdb/rest/`, {
      headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
    });
    const text = await res.text();

    if (!res.ok) {
      record(
        "A/REST",
        "FAIL",
        `HTTP ${res.status} — ${brief(text, 200)}`,
        res.status === 404 || res.status === 503
          ? "多半是 PG 实例尚未就绪。实例开通完成后重跑本脚本即可。"
          : res.status === 401 || res.status === 403
            ? "凭据被拒。确认 CLOUDBASE_SECRET 是当前环境的 API Key（换环境后必须换 Key）。"
            : undefined
      );
      return;
    }

    let tables: string[] = [];
    try {
      const doc = JSON.parse(text) as { paths?: Record<string, unknown> };
      tables = Object.keys(doc.paths ?? {})
        .filter((p) => p !== "/")
        .map((p) => p.replace(/^\//, ""));
    } catch {
      /* 不是 JSON 就只报连通 */
    }

    record(
      "A/REST",
      "OK",
      tables.length > 0
        ? `连通，已暴露 ${tables.length} 张表/视图：${tables.slice(0, 12).join(", ")}${tables.length > 12 ? " …" : ""}`
        : "连通，但当前没有任何对外暴露的表（空库，符合新环境预期）"
    );
  } catch (e) {
    record("A/REST", "FAIL", `网络错误 — ${(e as Error).message}`, "检查本机能否访问 *.api.tcloudbasegateway.com（443）。");
  }
}

/* ─────────────────── 通道 B：云 API ExecutePGSql（管控面）─────────────────── */

/**
 * 走 TC3-HMAC-SHA256 手工签名，避免为一次探测引入 tencentcloud-sdk-nodejs 全量依赖。
 * 算法固定，实现一次即可复用到 CI 建库脚本。
 */
async function tc3Request(action: string, payload: unknown): Promise<{ ok: boolean; body: string }> {
  const crypto = await import("node:crypto");
  const host = "tcb.tencentcloudapi.com";
  const service = "tcb";
  const version = "2018-06-08";
  const body = JSON.stringify(payload);
  const now = new Date();
  const ts = Math.floor(now.getTime() / 1000).toString();
  const date = now.toISOString().slice(0, 10);

  const sha256hex = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
  const hmac = (key: crypto.BinaryLike | Buffer, s: string) =>
    crypto.createHmac("sha256", key).update(s, "utf8").digest();

  const canonicalRequest = [
    "POST",
    "/",
    "",
    `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`,
    "content-type;host;x-tc-action",
    sha256hex(body),
  ].join("\n");

  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = ["TC3-HMAC-SHA256", ts, credentialScope, sha256hex(canonicalRequest)].join("\n");

  const secretDate = hmac(`TC3${TC_SECRET_KEY}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = crypto.createHmac("sha256", secretSigning).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `TC3-HMAC-SHA256 Credential=${TC_SECRET_ID}/${credentialScope}, ` +
    `SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`;

  const res = await fetch(`https://${host}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json; charset=utf-8",
      Host: host,
      "X-TC-Action": action,
      "X-TC-Timestamp": ts,
      "X-TC-Version": version,
      "X-TC-Region": REGION,
    },
    body,
  });
  return { ok: res.ok, body: await res.text() };
}

/** ExecutePGSql 单次只能执行一条语句；DDL 失败时官方要求用 DO 块包装重试 */
async function execPGSql(sql: string): Promise<{ ok: boolean; body: string }> {
  const first = await tc3Request("ExecutePGSql", { EnvId: ENV_ID, Sql: sql });
  if (first.ok && !first.body.includes('"Error"')) return first;

  const isDDL = /^\s*(CREATE|DROP|ALTER|GRANT|REVOKE|TRUNCATE|COMMENT)\b/i.test(sql);
  if (!isDDL) return first;

  const wrapped = `DO LANGUAGE plpgsql $$ BEGIN EXECUTE '${sql.replace(/'/g, "''")}'; END $$`;
  return await tc3Request("ExecutePGSql", { EnvId: ENV_ID, Sql: wrapped });
}

async function probeExecutePGSql(): Promise<boolean> {
  if (!TC_SECRET_ID || !TC_SECRET_KEY) {
    record(
      "B/ExecutePGSql",
      "SKIP",
      "缺 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY",
      "注意：这是腾讯云访问密钥（控制台→访问管理→API密钥），与 CLOUDBASE_SECRET(API Key) 是两套不同凭据。"
    );
    return false;
  }
  try {
    const { ok, body } = await execPGSql("SELECT version()");
    if (!ok || body.includes('"Error"')) {
      record("B/ExecutePGSql", "FAIL", brief(body, 240));
      return false;
    }
    record("B/ExecutePGSql", "OK", `可执行任意 SQL（含 DDL）。${brief(body, 160)}`);
    return true;
  } catch (e) {
    record("B/ExecutePGSql", "FAIL", (e as Error).message);
    return false;
  }
}

/* ───────────────────────── 通道 C：PG 协议直连 ───────────────────────── */
async function probeDirect(): Promise<boolean> {
  if (!DATABASE_URL) {
    record("C/直连", "SKIP", "DATABASE_URL 未配置（实例就绪后从控制台获取）");
    return false;
  }
  const postgres = (await import("postgres")).default;
  const sql = postgres(DATABASE_URL, { max: 1, prepare: false, connect_timeout: 10 });
  try {
    const [row] = await sql<{ version: string; db: string }[]>`
      SELECT version() AS version, current_database() AS db
    `;
    record("C/直连", "OK", `${row.db} — ${brief(row.version, 120)}`);
    return true;
  } catch (e) {
    record(
      "C/直连",
      "FAIL",
      (e as Error).message,
      "若报连接超时/拒绝：CloudBase PG 可能未开公网访问，或需在控制台加 IP 白名单。此时改用通道 A/B。"
    );
    return false;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/* ─────────────────── 通道 D：pgvector 可用性（决定 M4 方案）─────────────────── */
async function probeVector(canExec: boolean, canDirect: boolean) {
  const query = `SELECT name, default_version, installed_version
                 FROM pg_available_extensions
                 WHERE name IN ('vector','vectorscale') ORDER BY name`;

  if (canDirect) {
    const postgres = (await import("postgres")).default;
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false, connect_timeout: 10 });
    try {
      const rows = await sql.unsafe(query);
      if (rows.length === 0) {
        record("D/pgvector", "FAIL", "pg_available_extensions 中没有 vector —— 该实例不提供 pgvector");
      } else {
        const desc = rows
          .map((r: Record<string, unknown>) => `${r.name}(可用 ${r.default_version}${r.installed_version ? `, 已装 ${r.installed_version}` : ", 未安装"})`)
          .join("; ");
        record("D/pgvector", "OK", desc, "若未安装，用 CREATE EXTENSION vector; 启用后 M4 可走真向量索引，无需应用层 cosine。");
      }
    } catch (e) {
      record("D/pgvector", "FAIL", (e as Error).message);
    } finally {
      await sql.end({ timeout: 5 });
    }
    return;
  }

  if (canExec) {
    const { ok, body } = await execPGSql(query.replace(/\s+/g, " "));
    record(ok && !body.includes('"Error"') ? "D/pgvector" : "D/pgvector", ok ? "OK" : "FAIL", brief(body, 300));
    return;
  }

  record("D/pgvector", "SKIP", "需要通道 B 或 C 之一可用（REST 无法查询系统目录）");
}

/* ────────────────────────────────── main ────────────────────────────────── */
async function main() {
  console.log("═".repeat(72));
  console.log("CloudBase PostgreSQL 多通道探针");
  console.log(`环境 ID : ${ENV_ID || "(未配置)"}`);
  console.log(`网关    : ${ENV_ID ? BASE : "(不可用)"}`);
  console.log("═".repeat(72));

  await probeRest();
  const canExec = await probeExecutePGSql();
  const canDirect = await probeDirect();
  await probeVector(canExec, canDirect);

  console.log("═".repeat(72));
  const ok = results.filter((r) => r.status === "OK").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skip = results.filter((r) => r.status === "SKIP").length;
  console.log(`结果：${ok} 通 / ${fail} 不通 / ${skip} 跳过`);

  // 把「现在能干什么」直接说清楚，省掉一次人工判读
  const restOk = results.find((r) => r.channel === "A/REST")?.status === "OK";
  console.log("");
  if (canDirect) {
    console.log("→ 直连可用：M1 既定方案可全速推进（db:migrate → db:seed → 冒烟 → AC 回归）。");
  } else if (canExec) {
    console.log("→ 直连不可用但管控面可用：可用 ExecutePGSql 建表，运行时读写走 REST 或等直连开通。");
  } else if (restOk) {
    console.log("→ 仅 REST 可用：实例已就绪，但建表需要 DATABASE_URL 或腾讯云密钥其中之一。");
  } else {
    console.log("→ 全部不可用：PG 实例大概率仍在开通中，稍后重跑本脚本。");
  }
  console.log("═".repeat(72));
}

main().catch((e) => {
  console.error("探针异常：", e);
  process.exitCode = 1;
});
