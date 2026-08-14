// 临时诊断：提取指定需求方案文档中所有 mermaid 代码块内容并打印
import tcb from "@cloudbase/node-sdk";
import * as fs from "fs";
import * as path from "path";

const envContent = fs.readFileSync(path.resolve(__dirname, "../.env.local"), "utf-8");
const envMap: Record<string, string> = {};
envContent.split("\n").forEach((line) => {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith("#")) {
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) envMap[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
});

const app = tcb.init({ env: envMap.CLOUDBASE_ENV_ID, accessKey: envMap.CLOUDBASE_SECRET });
const db = app.database();

const REQ_ID = process.argv[2] || "9c614f75-24d1-4c8e-b390-cdd6b1d1e014";

async function main() {
  const sol = await db.collection("solutions").where({ requirement_id: REQ_ID }).limit(1).get();
  const row = sol.data?.[0];
  if (!row) {
    console.log("无方案文档");
    return;
  }
  const doc: string = row.doc ?? "";
  const re = /```mermaid\s*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(doc)) !== null) {
    i++;
    console.log(`\n===== MERMAID BLOCK #${i} (len=${m[1].length}) =====`);
    // 用可见标记打印，便于发现特殊字符
    console.log(m[1]);
    console.log(`===== END BLOCK #${i} =====\n`);
  }
  if (i === 0) console.log("文档中未发现 mermaid 代码块");
}
main().catch(console.error);
