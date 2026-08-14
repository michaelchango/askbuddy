// 一次性修复：把已卡住的需求 design 步骤状态修正为「原型已生成、等待确认进 PRD」。
// 适用场景：旧代码在 prototype-sse 完成时把 design_sub_phase 清为 null，导致重进详情页后
// 前端误判当前处于方案文档阶段。运行本脚本后，再次进入该需求详情页即可正常显示。
//
// 用法：
//   npx tsx scripts/fix-prototype-phase.ts <requirementId>

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const ENV_ID = process.env.CLOUDBASE_ENV_ID;
const API_KEY = process.env.CLOUDBASE_SECRET;
const BASE = ENV_ID ? `https://${ENV_ID}.api.tcloudbasegateway.com` : "";
const ROLE = "cloudbase_postgres";

if (!ENV_ID || !API_KEY || !BASE) {
  console.error("缺少 CLOUDBASE_ENV_ID / CLOUDBASE_SECRET，无法执行。");
  process.exit(1);
}

const TRANSIENT = /EMAXCONNSESSION|max clients reached|DATABASE_XX000|429|503|ECONNRESET|ETIMEDOUT|timed out/i;
const MAX_ATTEMPTS = 12;

async function execPgSql(sqlText: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${BASE}/v1/rdb/exec-pgsql`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          Connection: "close",
        },
        body: JSON.stringify({ Sql: sqlText, Role: ROLE }),
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text();
        if (TRANSIENT.test(text)) {
          lastErr = new Error(`exec-pgsql HTTP ${res.status}: ${text}`);
          throw lastErr;
        }
        throw new Error(`exec-pgsql HTTP ${res.status}: ${text}\nSQL: ${sqlText.slice(0, 200)}`);
      }
      return;
    } catch (e) {
      lastErr = e;
      if (!TRANSIENT.test(e instanceof Error ? e.message : String(e))) throw e;
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) =>
          setTimeout(r, 400 * Math.pow(2, attempt) + Math.floor(Math.random() * 200))
        );
      }
    }
  }
  throw lastErr;
}

async function main() {
  const rid = process.argv[2];
  if (!rid) {
    console.error("用法：npx tsx scripts/fix-prototype-phase.ts <requirementId>");
    process.exit(1);
  }

  console.log(`修正需求 ${rid} 的 design 步骤为「原型已完成、等待确认进 PRD」...`);
  await execPgSql(
    `UPDATE "requirement_steps" SET "state" = 'in_progress', "generating" = 0, "awaiting_confirm" = 1, "design_sub_phase" = 'prototype', "updated_at" = now() WHERE "requirement_id" = '${rid.replace(/'/g, "''")}' AND "step" = 'design';`
  );
  console.log("完成。请硬刷新浏览器后重新进入该需求详情页。");
}

main().catch((e) => {
  console.error("失败：", e);
  process.exit(1);
});
