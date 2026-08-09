// DevContext 结构契约单测（M2-C）：严格校验模型输出形态。
//
// 覆盖：
//   - 顶层 .strict()：模型不得发明 section / 混入无关键。
//   - 16 个内容 section 的最小 / 完整形态都能通过。
//   - 关键正则与 refine 约束（BR-/F-/API-/AC- 等 id 格式、path 前缀、
//     maps_to 非空、edge/api 至少一条）。
//   - 完整 DevContext（含 meta/references）的必填性。
//
// 运行：npx tsx --test lib/schemas/devcontext.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  DevContextBodySchema,
  DevContextSchema,
  type DevContextBody,
} from "@/lib/schemas/devcontext";

// 条目级溯源：SourceSchema 有默认值，传 {} 即可，但这里显式给出以保证可读性。
const src = {
  context_ids: [] as string[],
  decision_id: null,
  knowledge_ids: [] as string[],
  conversation_turn: null,
  confirmed_by: "ai_auto" as const,
  confirmed_at: null,
};

/** 构造一个 16 section 全部合法的 body（覆盖率测试用）。 */
function fullBody(): DevContextBody {
  return {
    objective: {
      problem_statement: "p",
      goal: "g",
      success_metrics: [{ metric: "m", target: "t", baseline: "b", measurement: "x" }],
      non_goals: ["n"],
      _source: src,
    },
    scope: {
      in_scope: ["a"],
      out_of_scope: ["b"],
      assumptions: ["c"],
      _source: src,
    },
    dependencies: {
      items: [{ id: "DEP-001", name: "n", type: "internal", description: "d", _source: src }],
      blocking: ["DEP-001"],
      _source: src,
    },
    business_rules: [
      { id: "BR-001", statement: "s", formal: { when: "w", then: "t" }, priority: "P0", source_refs: [], _source: src },
    ],
    user_scenarios: {
      personas: [{ name: "x", description: "y" }],
      primary: [{ id: "SC-001", actor: "a", precondition: "p", steps: ["s1"], expected: "e", _source: src }],
      secondary: [{ id: "SC-002", actor: "a", steps: ["s1"], expected: "e", _source: src }],
    },
    feature_logic: [
      {
        id: "F-001",
        name: "n",
        description: "d",
        happy_path: ["h"],
        alternate_flows: [{ condition: "c", steps: ["s"] }],
        states: [{ name: "st", from: ["x"], to: ["y"], trigger: "t" }],
        ui_behavior: "u",
        entity_refs: [],
        rule_refs: [],
        _source: src,
      },
    ],
    data_structures: {
      entities: [
        {
          name: "E",
          description: "d",
          fields: [{ name: "f", type: "string", required: true, constraints: "c", ref: "E2.f", description: "desc" }],
          _source: src,
        },
      ],
      enums: [{ name: "En", values: ["a", "b"] }],
      relationships: [{ from: "E", to: "E2", type: "1-n", description: "d" }],
    },
    api_requirements: {
      rest: [
        {
          id: "API-001",
          method: "GET",
          path: "/x",
          auth: "a",
          params: [{ name: "p", in: "query", type: "string", required: true }],
          request: {},
          response: {},
          errors: [{ code: "404", when: "w" }],
          entity_refs: [],
          _source: src,
        },
      ],
      events: [{ name: "ev", payload: {}, entity_refs: [], _source: src }],
    },
    integration_external: {
      systems: [{ name: "s", type: "t", purpose: "p", auth: "a", endpoints: ["e"], _source: src }],
      _source: src,
    },
    edge_cases: {
      boundary: [{ id: "EC-001", scenario: "s", handling: "h", refs: ["BR-001"], _source: src }],
      precondition_violations: [{ id: "EC-002", scenario: "s", handling: "h", refs: ["F-001"], _source: src }],
      concurrency: [{ id: "EC-003", scenario: "s", handling: "h", refs: ["BR-001"], _source: src }],
    },
    non_functional_requirements: {
      performance: [{ requirement: "r", metric: "m", _source: src }],
      security: [{ requirement: "r", metric: "m", _source: src }],
      compliance_privacy: [{ requirement: "r", metric: "m", _source: src }],
      reliability_availability: [{ requirement: "r", metric: "m", _source: src }],
      scalability: [{ requirement: "r", metric: "m", _source: src }],
      internationalization: [{ requirement: "r", metric: "m", _source: src }],
      accessibility: [{ requirement: "r", metric: "m", _source: src }],
    },
    acceptance_criteria: [
      { id: "AC-001", given: "g", when: "w", then: "t", maps_to: ["BR-001"], category: "functional", _source: src },
    ],
    test_cases: [
      { id: "TC-001", title: "t", precondition: "p", steps: ["s"], expected: "e", maps_to: ["AC-001"], type: "functional", _source: src },
    ],
    metrics_analytics: {
      events: [{ name: "e", description: "d", platform: "web" }],
      dashboards: ["d"],
      _source: src,
    },
    glossary: [{ term: "t", definition: "d" }],
    open_questions: [{ id: "Q-001", question: "q", context: "c", owner: "o" }],
  };
}

test("DevContextBodySchema 接受完整 16 section 形态", () => {
  const r = DevContextBodySchema.safeParse(fullBody());
  assert.ok(r.success, `期望通过，实际错误：${JSON.stringify(r.error?.issues ?? r, null, 2)}`);
});

test("DevContextBodySchema 接受最小形态（仅 objective）", () => {
  const r = DevContextBodySchema.safeParse({ objective: { problem_statement: "p", goal: "g", _source: src } });
  assert.ok(r.success, `期望通过，实际错误：${JSON.stringify(r.error?.issues ?? r, null, 2)}`);
});

test("DevContextBodySchema .strict() 拒绝未知 section", () => {
  const r = DevContextBodySchema.safeParse({
    objective: { problem_statement: "p", goal: "g", _source: src },
    someMadeUpSection: { foo: 1 },
  });
  assert.equal(r.success, false);
  assert.ok(
    (r as { error: { issues: Array<{ message: string }> } }).error.issues.some((i) => /someMadeUpSection/.test(i.message) || i.message.includes("未预期")),
    "应在 issues 中报告未知 key"
  );
});

test("business_rules.id 必须形如 BR-001", () => {
  const bad = fullBody();
  (bad.business_rules as NonNullable<DevContextBody["business_rules"]>)[0].id = "BR-1";
  const r = DevContextBodySchema.safeParse(bad);
  assert.equal(r.success, false);
  assert.ok((r as { error: { issues: Array<{ path: Array<unknown> }> } }).error.issues.some((i) => i.path.includes("business_rules")));
});

test("feature_logic.id 必须形如 F-001", () => {
  const bad = fullBody();
  (bad.feature_logic as NonNullable<DevContextBody["feature_logic"]>)[0].id = "F-1";
  const r = DevContextBodySchema.safeParse(bad);
  assert.equal(r.success, false);
  assert.ok((r as { error: { issues: Array<{ path: Array<unknown> }> } }).error.issues.some((i) => i.path.includes("feature_logic")));
});

test("api_requirements.rest[].path 必须以 / 开头", () => {
  const bad = fullBody();
  (bad.api_requirements as NonNullable<DevContextBody["api_requirements"]>).rest![0].path = "api/x";
  const r = DevContextBodySchema.safeParse(bad);
  assert.equal(r.success, false);
  assert.ok((r as { error: { issues: Array<{ path: Array<unknown> }> } }).error.issues.some((i) => i.path.join(".").includes("path")));
});

test("acceptance_criteria.maps_to 至少一条", () => {
  const bad = fullBody();
  (bad.acceptance_criteria as NonNullable<DevContextBody["acceptance_criteria"]>)[0].maps_to = [];
  const r = DevContextBodySchema.safeParse(bad);
  assert.equal(r.success, false);
});

test("edge_cases 至少含一个子数组（refine）", () => {
  const bad = fullBody();
  bad.edge_cases = { boundary: [], precondition_violations: [], concurrency: [] };
  const r = DevContextBodySchema.safeParse(bad);
  assert.equal(r.success, false);
});

test("api_requirements 至少含 rest 或 events 之一（refine）", () => {
  const bad = fullBody();
  bad.api_requirements = { rest: [], events: [] };
  const r = DevContextBodySchema.safeParse(bad);
  assert.equal(r.success, false);
});

test("DevContextSchema 必须含 meta，缺则失败", () => {
  const r = DevContextSchema.safeParse(fullBody()); // 无 meta / references
  assert.equal(r.success, false);
  assert.ok((r as { error: { issues: Array<{ path: Array<unknown> }> } }).error.issues.some((i) => i.path.includes("meta")));
});

test("DevContextSchema 含合法 meta + references 时通过", () => {
  const full = fullBody() as Record<string, unknown>;
  full.meta = {
    requirement_id: "r",
    title: "t",
    version: 1,
    status: "draft",
    generated_at: "2026-01-01T00:00:00Z",
    generated_by: "devcontext-agent@v1",
    completeness_score: 0.5,
    applicable_sections: ["objective"],
    present_sections: ["objective"],
    consistency_issues: [],
    source_links: {},
    changelog: [],
  };
  full.references = {}; // 全部取默认值
  const r = DevContextSchema.safeParse(full);
  assert.ok(r.success, `期望通过，实际错误：${JSON.stringify(r.error?.issues ?? r, null, 2)}`);
});

// ── M2-B7 放宽回归测试：模拟真实 AI 输出（null + 空数组 + 扩展枚举）──

test("【M2-B7】AI 真实输出：可选字段 null / [] 都被接受", () => {
  // 完全复现 2026-08-09 实测时 Zod 报错堆栈里的所有问题字段
  const aiLikeOutput: unknown = {
    objective: {
      problem_statement: "用户在移动端记录灵感",
      goal: "提供极简记录 + 自动归类",
      success_metrics: [
        { metric: "次日留存", target: "≥35%", baseline: null, measurement: null },
        { metric: "DAU", target: "1000", baseline: null, measurement: null },
      ],
      _source: src,
    },
    scope: {
      in_scope: ["灵感速记", "标签归类"],
      out_of_scope: null,   // null 应被接受
      assumptions: null,
      _source: src,
    },
    feature_logic: [
      {
        id: "F-001", name: "速记", description: "d", happy_path: ["打开"],
        alternate_flows: [],  // 空数组应被接受
        states: [],           // 空数组应被接受
        ui_behavior: null,
        entity_refs: [], rule_refs: [], _source: src,
      },
      { id: "F-002", name: "f2", description: "d2", happy_path: ["x"], alternate_flows: null, states: null, ui_behavior: null, entity_refs: [], rule_refs: [], _source: src },
      { id: "F-003", name: "f3", description: "d3", happy_path: ["x"], alternate_flows: [], states: [], ui_behavior: null, entity_refs: [], rule_refs: [], _source: src },
      { id: "F-004", name: "f4", description: "d4", happy_path: ["x"], alternate_flows: [], states: [], ui_behavior: null, entity_refs: [], rule_refs: [], _source: src },
      { id: "F-005", name: "f5", description: "d5", happy_path: ["x"], alternate_flows: [], states: [], ui_behavior: null, entity_refs: [], rule_refs: [], _source: src },
      { id: "F-006", name: "f6", description: "d6", happy_path: ["x"], alternate_flows: [], states: [], ui_behavior: null, entity_refs: [], rule_refs: [], _source: src },
    ],
    data_structures: {
      entities: [
        { name: "Note", description: null, fields: [{ name: "id", type: "uuid", required: true, constraints: null, ref: null, description: null }], _source: src },
      ],
      enums: [],          // 空数组应被接受
      relationships: [],  // 空数组应被接受
    },
    api_requirements: {
      rest: [],           // 空数组应被接受（events 必须有至少一条才不触发 refine）
      events: [{ name: "note_created", payload: null, entity_refs: [], _source: src }],
    },
    integration_external: {
      systems: [{ name: "S3", type: "storage", purpose: null, auth: null, endpoints: [], _source: src }],
      _source: src,
    },
    edge_cases: {
      boundary: [
        { id: "EC-001", scenario: "280字", handling: "允许保存", refs: ["BR-001"], _source: src },
      ],
      precondition_violations: [
        { id: "EC-002", scenario: "离线", handling: "排队", refs: ["F-001"], _source: src },
      ],
      concurrency: [],
    },
    test_cases: [
      { id: "TC-001", title: "t", precondition: null, steps: ["s"], expected: "e", maps_to: ["AC-001"], type: "functional", _source: src },
      { id: "TC-002", title: "t", precondition: null, steps: ["s"], expected: "e", maps_to: ["AC-001"], type: "smoke", _source: src },
      { id: "TC-003", title: "t", precondition: null, steps: ["s"], expected: "e", maps_to: ["AC-001"], type: "usability", _source: src },
      { id: "TC-004", title: "t", precondition: null, steps: ["s"], expected: "e", maps_to: ["AC-001"], type: "regression", _source: src }, // 扩展枚举应被接受
    ],
    metrics_analytics: {
      events: [{ name: "note_created", description: null, platform: null }],
      dashboards: [],   // 空数组应被接受
      _source: src,
    },
    open_questions: [
      { id: "Q-001", question: "q1", context: null, owner: null },
      { id: "Q-002", question: "q2", context: "ctx", owner: null },
    ],
  };
  const r = DevContextBodySchema.safeParse(aiLikeOutput);
  assert.ok(r.success, `期望通过，实际错误：${JSON.stringify(r.error?.issues ?? r, null, 2)}`);
});
