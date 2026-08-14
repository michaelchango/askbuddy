// 一次性修复工具：清除某个需求卡在 generating 的孤立状态。
// 用法：
//   npx tsx scripts/fix-design-subphase.ts <requirementId>
// 运行前会先执行 cloudbase 网关迁移（确保 design_sub_phase 等列存在），
// 再清掉该需求 design 步骤的 generating 标记。

import { join } from "node:path";
import { loadEnvConfig } from "@next/env";
import { runMigrate } from "./db-migrate-cloudbase";

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
    console.error("用法：npx tsx scripts/fix-design-subphase.ts <requirementId>");
    process.exit(1);
  }

  // 先确保结构最新（建列等）
  console.log("[1/2] 同步数据库结构（cloudbase 网关迁移）...");
  try {
    await runMigrate();
  } catch (e) {
    console.log("      ⚠ 迁移未成功，仍尝试清记录（若列不存在会报错）：", (e as Error).message);
  }

  console.log(`[2/2] 清除需求 ${rid} 的 design 步骤孤立 generating 状态 ...`);
  await execPgSql(
    `UPDATE "requirement_steps" SET "generating" = 0, "design_sub_phase" = NULL, "state" = 'in_progress', "updated_at" = now() WHERE "requirement_id" = '${rid.replace(/'/g, "''")}' AND "step" = 'design';`
  );
  console.log("      ✓ 已清 0，完成。");
}

main().catch((e) => {
  console.error("失败：", e);
  process.exit(1);
});
