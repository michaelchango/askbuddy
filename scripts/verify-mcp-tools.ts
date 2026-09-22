/**
 * 阶段7 验证：以真实 MCP 协议启动 mcp/server.ts，执行 initialize + tools/list，
 * 输出权威的工具清单与数量（不依赖静态读码）。
 *
 * 运行：npx tsx scripts/verify-mcp-tools.ts
 */
import { spawn } from "node:child_process";

const child = spawn("npx", ["tsx", "mcp/server.ts"], {
  cwd: process.cwd(),
  shell: true,
  env: { ...process.env, ASKBUDDY_TOKEN: process.env.ASKBUDDY_TOKEN ?? "verify" },
});

let buf = "";
const tools: Array<{ name: string; description?: string }> = [];
let stage = 0;

function send(obj: unknown) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }

    if (msg.id === 1 && stage === 0) {
      stage = 1;
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    } else if (msg.id === 2) {
      const list = msg.result?.tools ?? [];
      tools.push(...list);
      const names = list.map((t: any) => t.name);
      console.log(`[mcp] 工具总数 = ${list.length}`);
      for (const t of list) console.log(`  - ${t.name}`);
      const hasKnowledge = names.includes("search_knowledge");
      const sk = list.find((t: any) => t.name === "search_knowledge");
      console.log(`\n[mcp] search_knowledge 存在 = ${hasKnowledge}`);
      if (sk) {
        console.log(`[mcp] search_knowledge 描述 = ${sk.description}`);
        console.log(`[mcp] search_knowledge 入参 = ${JSON.stringify(Object.keys(sk.inputSchema?.properties ?? {}))}`);
      }
      child.kill();
      process.exit(0);
    }
  }
});

child.stderr.on("data", (d) => {
  const s = d.toString().trim();
  if (s) console.log(`[mcp:stderr] ${s}`);
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify", version: "1.0.0" } },
});

setTimeout(() => {
  console.error("[mcp] 超时：未在 60s 内拿到 tools/list");
  child.kill();
  process.exit(1);
}, 60000);
