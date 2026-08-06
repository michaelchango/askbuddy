import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
import { db } from "@/lib/db";
import { createRequirement, getRequirement } from "@/lib/services/requirements";

const BASE = "http://localhost:3000";

// 复刻 conversation-panel.tsx 的 handleSSE 解析逻辑（与前端完全一致）
function handleSSE(buf: string, onEvent: (event: string, data: string) => void) {
  let rest = buf;
  let sep: number;
  while ((sep = rest.indexOf("\n\n")) !== -1) {
    const block = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) onEvent(event, dataLines.join("\n"));
  }
  return rest;
}

function stripCardFence(t: string): string {
  const i = t.search(/```json|```/i);
  return (i >= 0 ? t.slice(0, i) : t)
    .replace(/\[STEP_COMPLETE\]/g, "")
    .replace(/\[COMPLEXITY:\s*[^\]]*\]/gi, "")
    .trim();
}

async function postConversation(rid: string, message: string) {
  console.log(`\n========== 第 ${message} 轮 user: ${message} ==========`);
  const res = await fetch(`${BASE}/api/requirements/${rid}/conversation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, references: [] }),
  });
  console.log("HTTP status:", res.status, "content-type:", res.headers.get("content-type"));
  if (!res.body) throw new Error("无响应 body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let acc = "";
  let finalReply = "";
  let cardEvent: any = null;
  let replyEventCount = 0;
  let deltaCount = 0;
  let cardEventCount = 0;
  const events: string[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    buf = handleSSE(buf, (event, data) => {
      if (event === "delta") {
        deltaCount++;
        try {
          const d = JSON.parse(data) as string;
          acc += d;
        } catch {
          events.push(`[delta parse FAIL] ${data.slice(0, 80)}`);
        }
      } else if (event === "reply") {
        replyEventCount++;
        try {
          const r = JSON.parse(data) as string;
          if (typeof r === "string" && r.trim()) finalReply = r.trim();
          events.push(`[reply] "${r}"`);
        } catch (e) {
          events.push(`[reply parse FAIL] ${data.slice(0, 120)} :: ${String(e)}`);
        }
      } else if (event === "card") {
        cardEventCount++;
        try {
          cardEvent = JSON.parse(data);
          events.push(`[card] ${JSON.stringify(cardEvent)}`);
        } catch (e) {
          events.push(`[card parse FAIL] ${data.slice(0, 120)} :: ${String(e)}`);
        }
      } else if (event === "error") {
        events.push(`[ERROR] ${data}`);
      } else {
        events.push(`[${event}] ${data.slice(0, 80)}`);
      }
    });
  }

  const bubbleText = finalReply || stripCardFence(acc) || "好的，已收到。";
  console.log("--- SSE events ---");
  console.log(events.join("\n"));
  console.log("--- 统计 ---");
  console.log("delta 数:", deltaCount, "reply 事件数:", replyEventCount, "card 事件数:", cardEventCount);
  console.log("acc 长度:", acc.length, "acc(前200):", acc.slice(0, 200));
  console.log("finalReply:", JSON.stringify(finalReply));
  console.log(">>> 前端气泡将显示 bubbleText:", JSON.stringify(bubbleText));
  return { bubbleText, cardEvent };
}

async function getCard(rid: string) {
  const res = await fetch(`${BASE}/api/requirements/${rid}/outputs/card`);
  const j = await res.json();
  // 同时用服务端进程内读（同一 db 层）做对照
  const inProc = (await getRequirement(rid))?.card ?? null;
  console.log("--- GET /outputs/card (HTTP) ---");
  console.log(JSON.stringify(j.data?.card ?? null));
  console.log("--- getRequirement IN-PROCESS (probe process) ---");
  console.log(JSON.stringify(inProc));
  return j.data?.card;
}

async function main() {
  // 准备需求
  let projects = await db.findMany<any>("projects", { limit: 5 });
  let projectId = projects[0]?.id;
  if (!projectId) {
    const p = await db.insert("projects", {
      id: crypto.randomUUID(),
      name: "probe-project",
      owner_id: "mock-user-001",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    projectId = (p as any).id;
  }
  const req = await createRequirement({ projectId, title: "" });
  console.log("REQ_ID=", req.id);

  const rounds = [
    "我想做一个肉鸽小游戏",
    "目标用户是喜欢挑战硬核操作、有二次元审美的核心玩家",
    "核心痛点是找不到难度适中、又不会太无聊的关卡节奏",
  ];

  for (const m of rounds) {
    await postConversation(req.id, m);
    await getCard(req.id);
    // 给 AI 流式一点间隔，避免并发
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log("\n========== ALL DONE ==========");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
