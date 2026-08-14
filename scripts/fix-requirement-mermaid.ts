// 定向清洗：仅对指定需求的所有含 mermaid 文档重写（幂等，经 validateMermaidBlocks）
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

const REQ_ID = process.argv[2] || "9c614f75-24d1-4c8e-b390-cdd6b1d1e014";

async function main() {
  const targets: Array<[string, string[], string]> = [
    ["solutions", ["doc"], "requirement_id"],
    ["solution_versions", ["doc"], "id"],
    ["prds", ["doc"], "requirement_id"],
    ["research_analysis", ["doc", "report"], "requirement_id"],
  ];

  for (const [table, fields, idKey] of targets) {
    const rows = await db.list<any>(table);
    const matched = rows.filter((r: any) => (r.requirement_id ?? r.id) === REQ_ID);
    for (const r of matched) {
      const updates: Record<string, any> = {};
      for (const f of fields) {
        const doc: string = r[f];
        if (!doc || !doc.includes("mermaid")) continue;
        const fixedDoc = validateMermaidBlocks(doc);
        if (fixedDoc !== doc) updates[f] = fixedDoc;
      }
      if (Object.keys(updates).length) {
        await db.update(table, r[idKey], updates, idKey);
        console.log(`修复 [${table}] ${idKey}=${r[idKey]}`);
      } else {
        console.log(`无需修复 [${table}] ${idKey}=${r[idKey]}`);
      }
    }
  }
  console.log("定向清洗完成");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
