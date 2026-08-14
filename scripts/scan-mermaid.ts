// 存量清洗：把所有含 mermaid 的文档 doc 重写为 validateMermaidBlocks(doc)（幂等）
import * as fs from "fs";
import * as path from "path";

const envContent = fs.readFileSync(path.resolve(__dirname, "../.env.local"), "utf-8");
for (const line of envContent.split("\n")) {
  const t = line.trim();
  if (t && !t.startsWith("#")) {
    const eq = t.indexOf("=");
    if (eq > 0) {
      const k = t.slice(0, eq);
      const v = t.slice(eq + 1);
      if (!(k in process.env)) process.env[k] = v;
    }
  }
}

const { db } = require("../lib/db") as typeof import("../lib/db");
const { validateMermaidBlocks } = require("../lib/ai/parse") as typeof import("../lib/ai/parse");

async function main() {
  let total = 0;
  let fixed = 0;

  async function processTable(table: string, docFields: string[], idKey = "id") {
    const rows = await db.list<any>(table);
    for (const r of rows) {
      let changed = false;
      const updates: Record<string, any> = {};
      for (const f of docFields) {
        const doc: string = r[f];
        if (!doc || !doc.includes("mermaid")) continue;
        const fixedDoc = validateMermaidBlocks(doc);
        if (fixedDoc !== doc) {
          updates[f] = fixedDoc;
          changed = true;
        }
      }
      if (changed) {
        fixed++;
        const idVal = r[idKey];
        await db.update(table, idVal, updates, idKey);
        console.log(`  修复 [${table}] ${idKey}=${idVal}`);
      }
      total++;
    }
    console.log(`表 ${table}: 共 ${rows.length} 条`);
  }

  await processTable("solutions", ["doc"], "requirement_id");
  await processTable("solution_versions", ["doc"], "id");
  await processTable("prds", ["doc"], "requirement_id");
  await processTable("prd_versions", ["doc"], "id");
  await processTable("research_analysis", ["doc", "report"], "requirement_id");

  console.log(`\n完成：扫描 ${total} 条，实际修复 ${fixed} 条`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
