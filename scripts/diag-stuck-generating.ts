// 诊断脚本：列出当前所有仍卡在 generating=1 的需求步骤，
// 用来判断「卡死」是后端没清 0（真脏数据）还是前端不刷新（已修复）。
//
// 运行：npx tsx scripts/diag-stuck-generating.ts
import { db } from "@/lib/db";

async function main() {
  const rows = await db.list<any>("requirement_steps", (r) => r.generating === true);
  if (rows.length === 0) {
    console.log("✅ 没有卡在 generating=1 的步骤。若 UI 仍显示「生成中」，则是前端刷新问题（已修复）。");
    return;
  }
  console.log(`⚠️ 发现 ${rows.length} 条 generating=1 的步骤：\n`);
  for (const r of rows) {
    console.log(
      `  requirement_id=${r.requirement_id} step=${r.step} state=${r.state} subPhase=${r.design_sub_phase ?? "-"} output_version=${r.output_version ?? "-"}`
    );
  }
  console.log(
    "\n若这些步骤的产物实际已生成完（output_version 有值 / 会话里有完成消息），可直接清 0：\n" +
      "  UPDATE requirement_steps SET generating = 0 WHERE generating = 1;"
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("诊断失败：", e);
    process.exit(1);
  }
);
