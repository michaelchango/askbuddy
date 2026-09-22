// DevContext 知识溯源过滤单测（M4 知识复利）。
//
// 保护的不变量：_source.knowledge_ids 必须 ⊆ 本次实际注入的知识 id 集合。
// 这条不变量坏了 = 模型编造的知识 id 会被写进 DevContext，溯源校验报红、
// 「AI 依据了哪条知识」变成假证据。
//
// 零 db / 零 AI 依赖，可直接在 tsx 下运行。
//
// 运行：npx tsx --test lib/ai/steps/knowledge-trace.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { filterKnowledgeIds, sanitizeKnowledgeIds } from "@/lib/ai/steps/knowledge-trace";
import type { DevContextBody } from "@/lib/schemas/devcontext";

/** 构造 _source（字段齐备，便于断言「其他字段原样保留」）。 */
function src(knowledge_ids: string[], extra: Partial<Record<string, unknown>> = {}) {
  return {
    context_ids: ["card.painPoints"],
    decision_id: null,
    knowledge_ids,
    conversation_turn: 2,
    confirmed_by: "ai_auto" as const,
    confirmed_at: null,
    ...extra,
  };
}

/** 最小可用 body：一个 section（含数组套对象）+ 一个顶层对象 section。 */
function makeBody(ids: string[]): any {
  return {
    objective: { problem_statement: "p", goal: "g", _source: src(ids) },
    business_rules: [
      { id: "BR-001", statement: "规则一", formal: { when: "w", then: "t" }, _source: src(ids) },
      { id: "BR-002", statement: "规则二", formal: { when: "w2", then: "t2" }, _source: src(ids) },
    ],
    glossary: [{ term: "术语", definition: "定义" }], // 无 _source，边界场景
  };
}

/** 收集 body 内所有 knowledge_ids（用于整体断言）。 */
function collectIds(node: unknown, out: string[][] = []): string[][] {
  if (Array.isArray(node)) {
    node.forEach((v) => collectIds(v, out));
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "knowledge_ids" && Array.isArray(v)) out.push(v as string[]);
      else collectIds(v, out);
    }
  }
  return out;
}

test("有注入知识：编造的 id 被丢弃，白名单内的保留", () => {
  const body = makeBody(["know_real_1", "know_halluc_1"]) as DevContextBody;
  const out = filterKnowledgeIds(body, [{ id: "know_real_1" }, { id: "know_real_2" }]);

  const all = collectIds(out);
  assert.equal(all.length, 3, "三个 _source 都应被遍历到");
  for (const ids of all) {
    assert.deepEqual(ids, ["know_real_1"], "只应保留真实注入的 id");
  }
});

test("注入集合非空但候选全为编造：结果为空数组（而非原样保留）", () => {
  const body = makeBody(["know_fake_1", "know_fake_2"]) as DevContextBody;
  const out = filterKnowledgeIds(body, [{ id: "know_real_1" }]);

  for (const ids of collectIds(out)) {
    assert.deepEqual(ids, [], "编造 id 必须被清空");
  }
});

test("无注入知识：所有 knowledge_ids 一律清空（含嵌套层级）", () => {
  const body = makeBody(["know_whatever"]) as DevContextBody;
  const out = filterKnowledgeIds(body, []);

  const all = collectIds(out);
  assert.equal(all.length, 3);
  for (const ids of all) {
    assert.deepEqual(ids, [], "无注入时不允许任何 knowledge_ids 残留");
  }
});

test("保留其他字段：context_ids / decision_id / conversation_turn / 业务字段不受影响", () => {
  const body = makeBody(["know_halluc"]) as DevContextBody;
  const out: any = filterKnowledgeIds(body, []);

  assert.deepEqual(out.objective._source.context_ids, ["card.painPoints"]);
  assert.equal(out.objective._source.conversation_turn, 2);
  assert.equal(out.objective._source.decision_id, null);
  assert.equal(out.objective._source.confirmed_by, "ai_auto");
  // 业务字段
  assert.equal(out.business_rules[0].id, "BR-001");
  assert.deepEqual(out.business_rules[0].formal, { when: "w", then: "t" });
  assert.equal(out.business_rules.length, 2);
  assert.deepEqual(out.glossary, [{ term: "术语", definition: "定义" }]);
});

test("不修改入参：原 body 的 knowledge_ids 保持不变", () => {
  const original = ["know_real_1", "know_halluc_1"];
  const body = makeBody(original) as DevContextBody;
  filterKnowledgeIds(body, [{ id: "know_real_1" }]);

  const all = collectIds(body);
  for (const ids of all) {
    assert.deepEqual(ids, original, "入参不应被就地修改");
  }
});

test("深层嵌套：数组套对象套数组里的 knowledge_ids 也会被过滤", () => {
  const body: any = {
    feature_logic: [
      {
        id: "F-001",
        happy_path: [{ step: 1, _source: src(["know_deep_fake"]) }],
        edge_cases: { boundary: [{ id: "E-001", _source: src(["know_deep_fake"]) }] },
      },
    ],
  };
  const out: any = filterKnowledgeIds(body as DevContextBody, [{ id: "know_real_1" }]);

  assert.deepEqual(out.feature_logic[0].happy_path[0]._source.knowledge_ids, []);
  assert.deepEqual(out.feature_logic[0].edge_cases.boundary[0]._source.knowledge_ids, []);
});

test("边界：knowledge_ids 非数组时原样保留（不误伤、不抛错）", () => {
  const body: any = { objective: { _source: { knowledge_ids: "not-an-array" } } };
  const out: any = filterKnowledgeIds(body as DevContextBody, [{ id: "know_real_1" }]);
  assert.equal(out.objective._source.knowledge_ids, "not-an-array");
});

test("sanitizeKnowledgeIds：自定义 filter 生效（导出供复用）", () => {
  const body = makeBody(["a", "b", "c"]) as DevContextBody;
  const out = sanitizeKnowledgeIds(body, (ids) => ids.filter((id) => id !== "b"));

  for (const ids of collectIds(out)) {
    assert.deepEqual(ids, ["a", "c"]);
  }
});
