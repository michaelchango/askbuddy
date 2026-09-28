// Provider 抽象层单测（M5-D3 闸门）。
//
// 覆盖：选择顺序 / mock 确定性（含夹具源码静态扫描）/ 重试与错误分类 /
// 降级路径 / callAI·streamAI 签名回归 / 夹具对 Schema 的合法性。
//
// 本文件刻意 mock 掉 `@/lib/cloudbase/app`：mock 模式**不应该碰真实 SDK**，
// 让它在被调用时直接抛错，等于把「mock 路径零副作用」变成一条被测试的保证。

import { beforeEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

vi.mock("@/lib/cloudbase/app", () => ({
  getCloudAI: () => {
    throw new Error("mock 模式下不应触碰 CloudBase SDK");
  },
}));

import { AI_TASK_MODEL } from "@/lib/ai/models";
import { aiUseMock, isProviderConfigured, resolveProvider } from "@/lib/ai/provider";
import { mockProvider } from "@/lib/ai/providers/mock";
import { AICallError, classifyAIError, isRetryableAIError, withRetry } from "@/lib/ai/retry";
import { callAI, streamAI } from "@/lib/ai/client";
import { DevContextBodySchema } from "@/lib/schemas/devcontext";
import {
  __mockInternals,
  mockTextFor,
  parseTargetedSections,
} from "@/lib/ai/mock/fixtures";
import { cardMergeFixture, parseExistingCard } from "@/lib/ai/mock/fixtures/card-merge";
import { changeAnalysisFixture, parseCandidates } from "@/lib/ai/mock/fixtures/change-analysis";
import { dialogueFixture } from "@/lib/ai/mock/fixtures/dialoguing";
import { cardMergeSystemPrompt } from "@/lib/ai/prompts/card-merge";

const ENV_KEYS = [
  "AI_MOCK",
  "USE_MOCK",
  "AI_PROVIDER",
  "AI_MOCK_SCENARIO",
  "AI_RETRY_BASE_MS",
  "AI_RETRY_JITTER",
  "CLOUDBASE_ENV_ID",
  "CLOUDBASE_SECRET",
  "AI_OPENAI_BASE_URL",
  "AI_OPENAI_API_KEY",
] as const;

const saved: Record<string, string | undefined> = {};

/** 剥掉行注释与块注释（`[^:]` 是为了不误伤 `https://` 这类字符串）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

beforeEach(() => {
  for (const k of ENV_KEYS) if (!(k in saved)) saved[k] = process.env[k];
  // 基线：测试态（与 tests/setup/unit.ts 一致）
  process.env.USE_MOCK = "true";
  process.env.AI_MOCK = "true";
  process.env.AI_MOCK_DELAY_MS = "0";
  process.env.AI_RETRY_BASE_MS = "0";
  delete process.env.AI_PROVIDER;
  delete process.env.AI_MOCK_SCENARIO;
  delete process.env.CLOUDBASE_ENV_ID;
  delete process.env.CLOUDBASE_SECRET;
  delete process.env.AI_OPENAI_BASE_URL;
  delete process.env.AI_OPENAI_API_KEY;
  vi.restoreAllMocks();
});

// ───────────────────────────── Provider 选择顺序 ─────────────────────────────

test("resolveProvider：AI_MOCK=true → mock（且不触碰 CloudBase SDK）", async () => {
  process.env.AI_MOCK = "true";
  process.env.CLOUDBASE_ENV_ID = "env-x";
  process.env.CLOUDBASE_SECRET = "sec-x";
  assert.equal(resolveProvider().id, "mock");
  // 真跑一次：若 mock 路径碰了 SDK，上面 vi.mock 的 getCloudAI 会抛
  const res = await mockProvider.generate({
    model: AI_TASK_MODEL.dialoguing,
    messages: [{ role: "user", content: "你好" }],
    taskType: "dialoguing",
  });
  assert.ok(res.content.length > 0);
});

test("resolveProvider：AI_MOCK=false 且 cloudbase 已配置 → cloudbase", () => {
  process.env.AI_MOCK = "false";
  process.env.USE_MOCK = "false";
  process.env.CLOUDBASE_ENV_ID = "env-x";
  process.env.CLOUDBASE_SECRET = "sec-x";
  assert.equal(resolveProvider().id, "cloudbase");
});

test("resolveProvider：AI_PROVIDER 指定且已配置 → 该 provider", () => {
  process.env.AI_MOCK = "false";
  process.env.USE_MOCK = "false";
  process.env.AI_PROVIDER = "openai-compatible";
  process.env.AI_OPENAI_BASE_URL = "https://example.com/v1";
  process.env.AI_OPENAI_API_KEY = "sk-x";
  assert.equal(resolveProvider().id, "openai-compatible");
});

test("★ resolveProvider：AI_PROVIDER 指定但未配置 → 忽略它，回落 cloudbase", () => {
  process.env.AI_MOCK = "false";
  process.env.USE_MOCK = "false";
  process.env.AI_PROVIDER = "openai-compatible"; // 但不给 base/key
  process.env.CLOUDBASE_ENV_ID = "env-x";
  process.env.CLOUDBASE_SECRET = "sec-x";
  assert.equal(resolveProvider().id, "cloudbase");
});

test("★ resolveProvider：什么都没配 → 回落 mock（保证无 Key 也能全链路联调）", () => {
  process.env.AI_MOCK = "false";
  process.env.USE_MOCK = "false";
  assert.equal(resolveProvider().id, "mock");
  assert.equal(isProviderConfigured("mock"), true);
  assert.equal(isProviderConfigured("cloudbase"), false);
});

test("aiUseMock：AI_MOCK 优先于 USE_MOCK", () => {
  process.env.USE_MOCK = "false";
  process.env.AI_MOCK = "true";
  assert.equal(aiUseMock(), true);
});

// ──────────────────────────── Mock 确定性（三铁律） ────────────────────────────

test("★ 确定性：同一输入 100 次 → 逐字节相同", async () => {
  const opts = {
    model: AI_TASK_MODEL.dialoguing,
    messages: [{ role: "user" as const, content: "做一个灵感速记工具" }],
    taskType: "dialoguing" as const,
  };
  const first = (await mockProvider.generate(opts)).content;
  for (let i = 0; i < 100; i++) {
    const again = (await mockProvider.generate(opts)).content;
    assert.equal(again, first, `第 ${i + 1} 次输出与首次不一致（出现随机源）`);
  }
});

test("确定性：不同输入 → 不同输出（指纹机制真的生效，不是写死的常量）", () => {
  const a = dialogueFixture("需求 A", "seed-a");
  const b = dialogueFixture("需求 B", "seed-b");
  assert.notEqual(a, b);
  assert.match(a, /〔mock-[a-z0-9]{6}〕/);
});

test("★ 夹具源码静态扫描：不得出现 Math.random / Date.now / new Date / randomUUID", () => {
  const roots = [
    path.resolve(process.cwd(), "lib/ai/mock"),
    path.resolve(process.cwd(), "lib/ai/providers/mock.ts"),
  ];
  const forbidden = /Math\.random|Date\.now|new Date\(|randomUUID/;
  const files: string[] = [];
  for (const r of roots) {
    if (fs.statSync(r).isDirectory()) {
      for (const f of fs.readdirSync(r, { recursive: true }) as string[]) {
        if (f.endsWith(".ts")) files.push(path.join(r, f));
      }
    } else {
      files.push(r);
    }
  }
  assert.ok(files.length >= 5, `扫描到的夹具文件过少（${files.length}），路径可能写错了`);
  for (const f of files) {
    // 先剥注释再扫描：hash.ts 的模块头**必然**会写到「禁用 Math.random()」这句话，
    // 那是纪律声明而不是违规。只扫真实代码，才能既不误报、又不放过真调用。
    const src = stripComments(fs.readFileSync(f, "utf8"));
    const hit = src.match(forbidden);
    assert.equal(
      hit,
      null,
      `${path.relative(process.cwd(), f)} 出现禁用随机源：${hit?.[0]}（确定性三铁律）`
    );
  }
});

test("mock 流式：8 字符切片且拼接后等于非流式输出", async () => {
  const opts = {
    model: AI_TASK_MODEL.dialoguing,
    messages: [{ role: "user" as const, content: "流式测试" }],
    taskType: "dialoguing" as const,
  };
  const full = (await mockProvider.generate(opts)).content;
  let joined = "";
  let chunks = 0;
  for await (const c of mockProvider.stream(opts)) {
    assert.ok(c.length <= 8, `切片超过 8 字符：${c.length}`);
    joined += c;
    chunks++;
  }
  assert.equal(joined, full);
  assert.ok(chunks > 1, "应切成多块（否则不构成流式）");
});

test("场景注入：AI_MOCK_SCENARIO 与 [[scenario:xxx]] 都能命中，且标记不进入产物", async () => {
  process.env.AI_MOCK_SCENARIO = "change-request";
  const viaEnv = await mockProvider.generate({
    model: AI_TASK_MODEL.dialoguing,
    messages: [
      { role: "system", content: "…affectedOutputs…" },
      { role: "user", content: "改一下" },
    ],
    taskType: "dialoguing",
  });
  assert.match(viaEnv.content, /全量级联用例/);

  delete process.env.AI_MOCK_SCENARIO;
  const viaMarker = await mockProvider.generate({
    model: AI_TASK_MODEL.dialoguing,
    messages: [
      { role: "system", content: "…affectedOutputs…" },
      { role: "user", content: "改一下 [[scenario:no-change]]" },
    ],
    taskType: "dialoguing",
  });
  assert.match(viaMarker.content, /"affectedOutputs": \[\]/);
  assert.ok(!viaMarker.content.includes("scenario:"), "场景标记不应出现在产物里");
});

// ───────────────────────────── DevContext 夹具 ─────────────────────────────

test("★ DevContext 基础夹具必须能过 DevContextBodySchema（16 段齐全）", () => {
  const parsed = DevContextBodySchema.safeParse(__mockInternals.devContextBaseFixture());
  assert.equal(
    parsed.success,
    true,
    parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))
  );
  assert.equal(Object.keys(__mockInternals.devContextBaseFixture()).length, 16);
});

test("★ DevContext 定向重算：只返回被请求的段，且内容随 seed 变化", () => {
  const a = __mockInternals.devContextBaseFixture();
  assert.ok(a); // 保证 fixtures 已加载（避免未使用告警）

  const one = parseTargetedSections(
    "⚠️ 本次**只重算**这些 section：business_rules、edge_cases。输出 JSON 的顶层只允许出现这些 key"
  );
  assert.deepEqual(one, ["business_rules", "edge_cases"]);

  const text = mockTextFor(
    "devcontext",
    [
      { role: "system", content: "s" },
      { role: "user", content: "⚠️ 本次**只重算**这些 section：business_rules。" },
    ],
    ""
  );
  const body = JSON.parse(text.replace(/```json\n?|\n?```/g, "")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["business_rules"], "只允许出现被请求的段");

  // 同一段、不同 seed（= 不同 changeNote / prompt）→ 内容必须不同，
  // 否则 e2e 无法区分「重算了但内容没变」与「没重算」
  const text2 = mockTextFor(
    "devcontext",
    [
      { role: "system", content: "s" },
      { role: "user", content: "⚠️ 本次**只重算**这些 section：business_rules。\n变更点：新增保留期约束" },
    ],
    ""
  );
  assert.notEqual(text, text2);
});

test("DevContext 夹具：schema-invalid 场景产出**不合法**的 body（供重试/错误路径用例）", () => {
  const text = mockTextFor(
    "devcontext",
    [{ role: "user", content: "x" }],
    "schema-invalid"
  );
  const body = JSON.parse(text.replace(/```json\n?|\n?```/g, "")) as Record<string, unknown>;
  assert.equal(DevContextBodySchema.safeParse(body).success, false);
});

// ─────────────────────────── 卡片合并 / 变更分析夹具 ───────────────────────────

test("★ 卡片合并夹具：回显现有卡片且只改 constraints（字段级 diff 恰好 1 个）", () => {
  const existing = {
    background: "背景 A",
    targetUsers: "用户 B",
    painPoints: "痛点 C",
    scope: "范围 D",
    nonFunctional: "非功能 E",
    constraints: "约束 F",
  };
  const userContent = `【现有需求卡片】\n${JSON.stringify(existing, null, 2)}\n\n【变更点】\n新增保留期约束`;
  const parsed = parseExistingCard(userContent);
  assert.deepEqual(parsed, existing);

  const out = JSON.parse(
    cardMergeFixture(userContent, "").replace(/```json\n?|\n?```/g, "")
  ) as Record<string, string>;
  const changed = Object.keys(existing).filter(
    (k) => out[k] !== existing[k as keyof typeof existing]
  );
  assert.deepEqual(changed, ["constraints"], "mock 只能改 constraints，否则映射表断言失真");
  assert.match(out.constraints, /〔mock-/);
});

test("卡片合并 prompt 特征串仍存在（夹具靠它识别调用方，改了必须同步）", () => {
  assert.ok(cardMergeSystemPrompt.includes("6 个字段（全部为字符串）"));
});

test("变更分析夹具：解析候选窗口 + 无修改意图返回空数组", () => {
  const system = "本次可参与判定的输出物（候选窗口）只有：card（需求卡片）、research_analysis（调研报告）。";
  assert.deepEqual(parseCandidates(system), ["card", "research_analysis"]);

  const noIntent = JSON.parse(
    changeAnalysisFixture(system, "这个报告不错", "").replace(/```json\n?|\n?```/g, "")
  ) as { affectedOutputs: string[] };
  assert.deepEqual(noIntent.affectedOutputs, [], "无修改意图必须返回空数组（不许保守标 card）");

  const withIntent = JSON.parse(
    changeAnalysisFixture(system, "把范围改成只支持暗色模式", "").replace(/```json\n?|\n?```/g, "")
  ) as { affectedOutputs: string[] };
  assert.deepEqual(withIntent.affectedOutputs, ["card"], "默认只标卡片（最精确的路径）");

  const overWindow = JSON.parse(
    changeAnalysisFixture(system, "改一下", "over-window").replace(/```json\n?|\n?```/g, "")
  ) as { affectedOutputs: string[] };
  assert.ok(overWindow.affectedOutputs.includes("prd"), "越窗口用例需要包含窗口外的输出物");
});

// ─────────────────────────────── 重试与错误分类 ───────────────────────────────

test("classifyAIError：超时→504 / 限流→429 / 4xx→400 / 其他→502", () => {
  assert.equal(classifyAIError(new Error("request timeout")).status, 504);
  assert.equal(classifyAIError(new Error("HTTP 429 Too Many Requests")).status, 429);
  assert.equal(classifyAIError(new Error("400 invalid parameter")).status, 400);
  assert.equal(classifyAIError(new Error("500 internal error")).status, 502);
  // 服务未开通是「服务端状态」，不是用户请求错了
  assert.equal(
    classifyAIError(new Error("FailedOperation.ServiceNotActivated")).code,
    "AI_UNAVAILABLE"
  );
});

test("isRetryableAIError：4xx 不重试，超时/5xx/限流重试", () => {
  assert.equal(isRetryableAIError(new Error("400 bad request")), false);
  assert.equal(isRetryableAIError(new Error("timeout")), true);
  assert.equal(isRetryableAIError(new Error("503 unavailable")), true);
});

test("withRetry：先失败后成功，返回结果并记录尝试次数", async () => {
  let calls = 0;
  const out = await withRetry(async (attempt) => {
    calls++;
    if (attempt < 3) throw new Error("503 unavailable");
    return "ok";
  });
  assert.equal(out, "ok");
  assert.equal(calls, 3);
});

test("★ withRetry：不可重试错误立即抛出（不浪费配额）", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(async () => {
        calls++;
        throw new Error("400 invalid parameter");
      }),
    /400/
  );
  assert.equal(calls, 1, "4xx 不该重试");
});

test("withRetry：全部失败时抛出原始错误（保留分类信息）", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(async () => {
        calls++;
        throw new Error("500 boom");
      }),
    /500 boom/
  );
  assert.equal(calls, 3, "默认 3 次尝试");
});

test("withRetry：signal 已 abort → 立即放弃（不再烧配额）", async () => {
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new Error("timeout");
        },
        { signal: ac.signal }
      ),
    /取消/
  );
  assert.equal(calls, 0);
});

// ───────────────────────── callAI / streamAI（签名回归 + 降级） ─────────────────────────

test("★ callAI 签名回归：入参 (taskType, messages, signal)，返回 { model, content }", async () => {
  const res = await callAI("dialoguing", [{ role: "user", content: "你好" }]);
  assert.deepEqual(Object.keys(res).sort(), ["content", "model"]);
  assert.equal(typeof res.content, "string");
  assert.equal(res.model, AI_TASK_MODEL.dialoguing);
});

test("★ 降级路径：designing 失败（可重试错误）→ 自动换 research_analysis 的模型", async () => {
  const spy = vi.spyOn(mockProvider, "generate").mockImplementation(async (opts) => {
    if (opts.model === AI_TASK_MODEL.designing) throw new Error("503 upstream unavailable");
    return { model: opts.model, content: "降级后的内容", provider: "mock" };
  });
  const res = await callAI("designing", [{ role: "user", content: "出方案" }]);
  assert.equal(res.model, AI_TASK_MODEL.research_analysis);
  assert.equal(res.content, "降级后的内容");
  assert.ok(spy.mock.calls.length >= 2);
});

test("★ 不可重试错误 → 抛 AICallError（带 code/status），且不重试", async () => {
  const spy = vi
    .spyOn(mockProvider, "generate")
    .mockRejectedValue(new Error("400 invalid parameter"));
  await assert.rejects(
    () => callAI("dialoguing", [{ role: "user", content: "x" }]),
    (e: unknown) => {
      assert.ok(e instanceof AICallError);
      assert.equal((e as AICallError).code, "AI_BAD_REQUEST");
      assert.equal((e as AICallError).status, 400);
      return true;
    }
  );
  assert.equal(spy.mock.calls.length, 1);
});

test("★ streamAI 签名回归：返回 ReadableStream，可读到完整文本", async () => {
  const stream = streamAI("dialoguing", [{ role: "user", content: "流式回归" }]);
  assert.ok(stream instanceof ReadableStream);
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += value;
  }
  assert.ok(text.length > 0);
  assert.equal(text, (await callAI("dialoguing", [{ role: "user", content: "流式回归" }])).content);
});

test("key 未配置时 getConfiguredProviders 不含真实后端（诊断口径）", async () => {
  process.env.AI_MOCK = "false";
  process.env.USE_MOCK = "false";
  const { getConfiguredProviders } = await import("@/lib/ai/provider");
  assert.deepEqual(getConfiguredProviders(), ["mock"]);
});
