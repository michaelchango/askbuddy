// 诊断脚本：查询指定需求的版本数据
import tcb from "@cloudbase/node-sdk";
import * as fs from "fs";
import * as path from "path";

// 手动读取 .env.local
const envContent = fs.readFileSync(path.resolve(__dirname, "../.env.local"), "utf-8");
const envMap: Record<string, string> = {};
envContent.split("\n").forEach((line) => {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith("#")) {
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      envMap[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  }
});

const env = envMap.CLOUDBASE_ENV_ID;
const secret = envMap.CLOUDBASE_SECRET;

if (!env || !secret) {
  console.error("缺少 CLOUDBASE_ENV_ID 或 CLOUDBASE_SECRET");
  process.exit(1);
}

const app = tcb.init({ env, accessKey: secret });
const db = app.database();

const REQ_ID = process.argv[2] || "2479204b-436a-44c8-a1c3-53dc10c30962";

async function main() {
  console.log(`\n=== 诊断需求: ${REQ_ID} ===\n`);

  // 1. research_analysis
  console.log("--- 1. research_analysis ---");
  try {
    const ra = await db.collection("research_analysis").where({ requirement_id: REQ_ID }).limit(1).get();
    const row = ra.data?.[0];
    if (row) {
      const { _id, _openid, ...rest } = row;
      console.log("当前记录:", JSON.stringify(rest, null, 2));
    } else {
      console.log("无记录（可能尚未生成）");
    }
  } catch (e: any) {
    console.error("查询失败:", e.message);
  }

  // 2. research_analysis_versions（版本历史）
  console.log("\n--- 2. research_analysis_versions ---");
  try {
    const ver = await db.collection("research_analysis_versions").where({ requirement_id: REQ_ID }).get();
    const rows = ver.data ?? [];
    console.log(`共 ${rows.length} 条版本记录:`);
    for (const r of rows) {
      const { _id, _openid, report, user_stories, features, ...rest } = r;
      console.log(`  v${rest.version}: created=${rest.created_at}, note=${rest.note}`);
    }
    if (rows.length === 0) console.log("无版本历史");
  } catch (e: any) {
    console.error("查询失败:", e.message);
  }

  // 3. solutions
  console.log("\n--- 3. solutions ---");
  try {
    const sol = await db.collection("solutions").where({ requirement_id: REQ_ID }).limit(1).get();
    const row = sol.data?.[0];
    if (row) {
      const { _id, _openid, doc: _doc, ...rest } = row;
      console.log("当前记录:", JSON.stringify(rest, null, 2));
    } else {
      console.log("无记录（可能尚未生成）");
    }
  } catch (e: any) {
    console.error("查询失败:", e.message);
  }

  // 4. solution_versions（方案版本历史）
  console.log("\n--- 4. solution_versions ---");
  try {
    const ver = await db.collection("solution_versions").where({ requirement_id: REQ_ID }).get();
    const rows = ver.data ?? [];
    console.log(`共 ${rows.length} 条版本记录:`);
    for (const r of rows) {
      const { _id, _openid, doc: _doc, ...rest } = r;
      console.log(`  v${rest.version}: created=${rest.created_at}, note=${rest.note}`);
    }
    if (rows.length === 0) console.log("无版本历史");
  } catch (e: any) {
    console.error("查询失败:", e.message);
  }

  // 5. requirement_steps
  console.log("\n--- 5. requirement_steps ---");
  try {
    const steps = await db.collection("requirement_steps").where({ requirement_id: REQ_ID }).get();
    const rows = steps.data ?? [];
    console.log(`共 ${rows.length} 条步骤记录:`);
    for (const r of rows) {
      const { _id, _openid, ...rest } = r;
      console.log(`  step=${rest.step} | state=${rest.state} | output_version=${rest.output_version} | awaiting_confirm=${rest.awaiting_confirm}`);
    }
    if (rows.length === 0) console.log("无步骤记录");
  } catch (e: any) {
    console.error("查询失败:", e.message);
  }

  // 6. requirements
  console.log("\n--- 6. requirements ---");
  try {
    const req = await db.collection("requirements").where({ id: REQ_ID }).limit(1).get();
    const row = req.data?.[0];
    if (row) {
      const { _id, _openid, card: _card, ...rest } = row;
      console.log("当前记录:", JSON.stringify(rest, null, 2));
    } else {
      console.log("无记录");
    }
  } catch (e: any) {
    console.error("查询失败:", e.message);
  }

  console.log("\n=== 诊断完成 ===");
}

main().catch(console.error);
