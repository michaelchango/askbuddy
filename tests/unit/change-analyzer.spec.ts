// 变更分析单测（M5-D4 / P4-3）。
//
// 关键：**prompt 与候选窗口过滤逻辑必须与改造前逐字一致**（M5 只加了 `triggers` 字段），
// 这几条用例就是它的护栏——变更分析的准确率是 PRDHub 的差异化硬实力，
// 任何回归都是净损失。

import { beforeEach, test, vi } from "vitest";
import assert from "node:assert/strict";

const { dbMock, callAIMock, listConversationsMock, getRequirementMock } = vi.hoisted(() => ({
  dbMock: { get: vi.fn(), findMany: vi.fn(), countMany: vi.fn() },
  callAIMock: vi.fn(),
  listConversationsMock: vi.fn(),
  getRequirementMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/ai/client", () => ({ callAI: callAIMock }));
vi.mock("@/lib/services/conversations", () => ({ listConversations: listConversationsMock }));
vi.mock("@/lib/services/requirements", () => ({ getRequirement: getRequirementMock }));

import { analyzeChanges, outputsToTriggers } from "@/lib/services/change-analyzer";

/** 让 callAI 返回给定的模型输出文本。 */
function mockAI(content: string) {
  callAIMock.mockResolvedValue({ model: "hy3", content });
}

function jsonFence(v: unknown): string {
  return "```json\n" + JSON.stringify(v) + "\n```";
}

beforeEach(() => {
  vi.clearAllMocks();
  getRequirementMock.mockResolvedValue({ id: "req-1", card: { scope: "（空）" } });
  listConversationsMock.mockResolvedValue([
    { role: "user", content: "做一个灵感速记工具" },
    { role: "assistant", content: "好的" },
  ]);
  // 默认：各产物都不存在（db.get 返回 null）→ 候选窗口只由调用方决定
  dbMock.get.mockResolvedValue(null);
});

// ────────────────────────────── outputsToTriggers ──────────────────────────────

test("outputsToTriggers：4 个 output 的映射逐一断言（design 必须展开为 2 个）", () => {
  assert.deepEqual(outputsToTriggers(["research_analysis"]), [
    "research.report",
    "research.user_stories",
    "research.features",
  ]);
  assert.deepEqual(outputsToTriggers(["design"]), ["solution.doc", "prototype.structure"]);
  assert.deepEqual(outputsToTriggers(["prd"]), ["prd.markdown"]);
  assert.deepEqual(outputsToTriggers(["card"]), [], "卡片走字段级 diff，此处不重复产出");
  assert.deepEqual(outputsToTriggers([]), []);
});

test("outputsToTriggers：prototype 单独出现也要产出（路由会把它单列）", () => {
  assert.deepEqual(outputsToTriggers(["prototype"]), ["prototype.structure"]);
});

test("outputsToTriggers：多产物合并去重（design + prototype 不重复 prototype.structure）", () => {
  const t = outputsToTriggers(["design", "prototype", "prd"]);
  assert.deepEqual(t, ["solution.doc", "prototype.structure", "prd.markdown"]);
  assert.equal(new Set(t).size, t.length);
});

test("outputsToTriggers：未知 output 忽略（不炸）", () => {
  assert.deepEqual(outputsToTriggers(["unknown_thing"]), []);
});

// ────────────────────────────── analyzeChanges ──────────────────────────────

test("★ 候选窗口过滤：LLM 返回窗口外的 output 必须被裁掉", async () => {
  mockAI(jsonFence({ affectedOutputs: ["card", "prd"], changes: [], summary: "s" }));
  const res = await analyzeChanges("req-1", "改一下范围", { candidates: ["card"] });
  assert.deepEqual(res?.affectedOutputs, ["card"], "prd 不在候选窗口内，必须被过滤");
});

test("★ 依赖顺序排序：LLM 乱序返回 → 输出按 DEP_ORDER 排序", async () => {
  mockAI(
    jsonFence({
      affectedOutputs: ["prd", "card", "research_analysis"],
      changes: [],
      summary: "s",
    })
  );
  const res = await analyzeChanges("req-1", "改一下", {
    candidates: ["card", "research_analysis", "prd"],
  });
  assert.deepEqual(res?.affectedOutputs, ["card", "research_analysis", "prd"]);
});

test("★ 非变更意图：LLM 返回空数组 → 结果为空，绝不保守标 card", async () => {
  mockAI(jsonFence({ affectedOutputs: [], changes: [], summary: "未检测到修改意图。" }));
  const res = await analyzeChanges("req-1", "这个报告不错", { candidates: ["card", "prd"] });
  assert.deepEqual(res?.affectedOutputs, []);
});

test("changes 数组同步过滤：只保留 affected 内的变更点", async () => {
  mockAI(
    jsonFence({
      affectedOutputs: ["card"],
      changes: [
        { output: "card", field: "scope", description: "改范围" },
        { output: "prd", field: "markdown", description: "改 PRD" }, // 应被裁掉
      ],
      summary: "s",
    })
  );
  const res = await analyzeChanges("req-1", "改范围", { candidates: ["card"] });
  assert.equal(res?.changes.length, 1);
  assert.equal(res?.changes[0].output, "card");
});

test("JSON 提取兜底：```json 围栏 / 裸对象 / <think> 前缀三种形态都能解析", async () => {
  const payload = { affectedOutputs: ["card"], changes: [], summary: "s" };

  mockAI(jsonFence(payload));
  assert.deepEqual(
    (await analyzeChanges("req-1", "改", { candidates: ["card"] }))?.affectedOutputs,
    ["card"]
  );

  mockAI(JSON.stringify(payload));
  assert.deepEqual(
    (await analyzeChanges("req-1", "改", { candidates: ["card"] }))?.affectedOutputs,
    ["card"]
  );

  mockAI(`<think>先想一想……</think>\n${jsonFence(payload)}`);
  assert.deepEqual(
    (await analyzeChanges("req-1", "改", { candidates: ["card"] }))?.affectedOutputs,
    ["card"]
  );
});

test("解析失败 → 返回 null（不抛错，不阻断对话主链路）", async () => {
  mockAI("完全不是 JSON 的一段话");
  assert.equal(await analyzeChanges("req-1", "改", { candidates: ["card"] }), null);
});

test("AI 调用抛错 → 返回 null（静默降级，不阻断）", async () => {
  callAIMock.mockRejectedValue(new Error("502"));
  assert.equal(await analyzeChanges("req-1", "改", { candidates: ["card"] }), null);
});

test("★ 候选窗口自动补入 prototype：design 在窗口内且原型已生成", async () => {
  dbMock.get.mockImplementation(async (table: string) => {
    if (table === "prototypes") return { current_version: 2 };
    return null;
  });
  mockAI(
    jsonFence({
      affectedOutputs: ["design", "prototype"],
      changes: [],
      summary: "s",
    })
  );
  const res = await analyzeChanges("req-1", "改方案", { candidates: ["card", "design"] });
  // prototype 被补进候选窗口 → 不会被过滤掉
  assert.deepEqual(res?.affectedOutputs, ["design", "prototype"]);
});

test("candidates 缺省时兜底为仅 card", async () => {
  mockAI(
    jsonFence({
      affectedOutputs: ["card", "prd"],
      changes: [],
      summary: "s",
    })
  );
  const res = await analyzeChanges("req-1", "改");
  assert.deepEqual(res?.affectedOutputs, ["card"]);
});

test("★ triggers 字段由 affectedOutputs 确定性推导（M5-D2 新增，不影响旧字段）", async () => {
  mockAI(
    jsonFence({
      affectedOutputs: ["card", "prd"],
      changes: [],
      summary: "s",
    })
  );
  const res = await analyzeChanges("req-1", "改", { candidates: ["card", "prd"] });
  assert.deepEqual(res?.affectedOutputs, ["card", "prd"]);
  assert.deepEqual(res?.triggers, ["prd.markdown"], "card 不产 trigger，prd 产 prd.markdown");
});
