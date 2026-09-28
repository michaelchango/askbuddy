/**
 * M5-D3 冒烟：**真实** CloudBase 链路（R-M5-5）。
 *
 * 为什么必须有这一条：P3-6 把 client.ts 从「直接的 CloudBase 调用」改成了
 * 「provider 编排 + 重试 + 降级」，动的是真实链路本身。单测全走 mock provider，
 * 无论怎么绿都证明不了真实链路没被改坏——只有真跑一次才算验证。
 *
 * 用法：npx tsx scripts/smoke-ai-provider.ts
 *      （需要 .env.local 里有 CLOUDBASE_ENV_ID / CLOUDBASE_SECRET）
 */
import "./_env";
import { AI_TASK_MODEL } from "@/lib/ai/models";
import { getConfiguredProviders, resolveProvider } from "@/lib/ai/provider";
import { callAI, streamAI } from "@/lib/ai/client";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  // 强制走真实后端：这条冒烟的全部意义就是「不用 mock」
  process.env.AI_MOCK = "false";
  process.env.USE_MOCK = "false";
  process.env.AI_CALL_LOG = "1"; // 把结构化日志打出来，人眼确认字段完整
  delete process.env.AI_MOCK_SCENARIO;

  console.log(`[smoke-ai] 已配置的 provider：${JSON.stringify(getConfiguredProviders())}`);
  const provider = resolveProvider();
  console.log(`[smoke-ai] 选中：${provider.id}`);
  check(
    "真实链路命中 cloudbase（而不是回落 mock）",
    provider.id === "cloudbase",
    `provider=${provider.id}`
  );
  if (provider.id !== "cloudbase") {
    console.log("\n[smoke-ai] 未配置 CloudBase 凭据，跳过真实调用");
    process.exit(fail === 0 ? 0 : 1);
  }

  const messages = [
    { role: "system" as const, content: "你是一个简洁的助手，回答不超过 30 字。" },
    { role: "user" as const, content: "用一句话说明什么是需求文档。" },
  ];

  // ---------- 非流式 ----------
  const t0 = Date.now();
  const res = await callAI("dialoguing", messages);
  const ms = Date.now() - t0;

  check("callAI 返回非空内容", res.content.trim().length > 0, `${res.content.length} 字 / ${ms}ms`);
  check(
    "callAI 返回的 model 与路由表一致",
    res.model === AI_TASK_MODEL.dialoguing,
    `model=${res.model}`
  );
  check("返回结构未变（仅 model + content）", Object.keys(res).sort().join(",") === "content,model");
  console.log(`     内容预览：${res.content.slice(0, 60).replace(/\n/g, " ")}`);

  // ---------- 流式 ----------
  const stream = streamAI("dialoguing", messages);
  const reader = stream.getReader();
  let chunks = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks++;
      text += value;
    }
  }
  check("streamAI 真的分批吐出（chunks > 1）", chunks > 1, `chunks=${chunks}`);
  check("streamAI 拼接后非空", text.trim().length > 0, `${text.length} 字`);

  // ---------- 取消能力（signal 透传到 provider） ----------
  const ac = new AbortController();
  const stream2 = streamAI("dialoguing", messages, ac.signal);
  const reader2 = stream2.getReader();
  const first = await reader2.read();
  ac.abort();
  check("首块可读（取消前已开始产出）", !first.done, `chunk=${(first.value ?? "").slice(0, 12)}`);
  await reader2.cancel().catch(() => undefined);

  console.log(`\n[smoke-ai] 通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[smoke-ai] 异常：", e);
  process.exit(1);
});
