// DevContext 校验层单测（M2-C）：完整度分母修正 + 评分 + 提示文案 + 一致性闭环。
//
// 纯函数（completenessScore / buildHints）不触库；checkConsistency 的 ①②③ 规则
// 只依赖入参 body（read 部分仅在有 PRD 行时触发 prd_correspondence，本测试用
// USE_MOCK 且无种子数据，该规则自然跳过）。因此整文件无需真实数据库。
//
// 运行：npx tsx --test lib/services/devcontext-validate.test.ts

import test from "node:test";
import assert from "node:assert/strict";

// checkConsistency 内部会读 db.get("prds", ...)，用 mock 后端且不加种子，使其返回
// undefined（prd_correspondence 规则跳过），其余规则纯靠 body 判定。
// 注意：USE_MOCK 只需在首次 db 调用（checkConsistency 内）之前生效，
// 模块静态导入不会触发 db 连接，因此在模块体顶部设置即可。
process.env.USE_MOCK = "true";

import { completenessScore, buildHints, checkConsistency } from "@/lib/services/devcontext-validate";
import { SECTION_KEYS } from "@/lib/schemas/devcontext";

type Body = Record<string, unknown>;

/** 全部信号为 false（仅核心 section 计入分母）。 */
function noSignals() {
  return {
    hasDataModel: false, hasApi: false, hasNfr: false, hasExternal: false,
    hasMetrics: false, hasDependency: false, hasGlossary: false,
    hasOpenQuestion: false, hasTestable: false,
  };
}

/** 全部信号为 true（16 个 section 全部计入分母）。 */
function allSignals() {
  return {
    hasDataModel: true, hasApi: true, hasNfr: true, hasExternal: true,
    hasMetrics: true, hasDependency: true, hasGlossary: true,
    hasOpenQuestion: true, hasTestable: true,
  };
}

/** 一个「全部 section 都有内容且质量检查全过」的 body（用于 score=1 用例）。 */
function perfectBody(): Body {
  return {
    objective: { problem_statement: "p", goal: "g", success_metrics: [{ metric: "m", target: "t" }] },
    scope: { in_scope: ["a"] },
    dependencies: { items: [{ id: "DEP-001", name: "n", type: "internal" }] },
    business_rules: [{ id: "BR-001", statement: "s", formal: { when: "w", then: "t" } }],
    user_scenarios: { primary: [{ id: "SC-001", actor: "a", steps: ["s"], expected: "e" }] },
    feature_logic: [{ id: "F-001", name: "n", description: "d", happy_path: ["h"] }],
    data_structures: { entities: [{ name: "E", fields: [{ name: "f", type: "string" }] }] },
    api_requirements: { rest: [{ id: "API-001", method: "GET", path: "/x" }] },
    integration_external: { systems: [{ name: "s", type: "t" }] },
    edge_cases: { boundary: [{ id: "EC-001", scenario: "s", handling: "h", refs: ["BR-001"] }] },
    non_functional_requirements: { performance: [{ requirement: "r" }] },
    acceptance_criteria: [{ id: "AC-001", given: "g", when: "w", then: "t", maps_to: ["BR-001"] }],
    test_cases: [{ id: "TC-001", title: "t", steps: ["s"], expected: "e", maps_to: ["AC-001"] }],
    metrics_analytics: { events: [{ name: "e" }] },
    glossary: [{ term: "t", definition: "d" }],
    open_questions: [{ id: "Q-001", question: "q" }],
  };
}

test("空 body：分母=7 核心，present=0，score=0", () => {
  const rep = completenessScore({} as never, noSignals());
  assert.equal(rep.applicable.length, 7, "核心 section 应为 7 个");
  assert.equal(rep.present.length, 0);
  assert.equal(rep.score, 0);
  assert.equal(rep.missing.length, 7);
});

test("完美 body + 全信号：分母=16，score=1", () => {
  const rep = completenessScore(perfectBody() as never, allSignals());
  assert.equal(rep.applicable.length, 16, "全信号下 16 个 section 都应计入分母");
  assert.equal(rep.present.length, 16);
  assert.equal(rep.score, 1, "质量检查全部通过应为满分");
  // 质量检查总数 = 16 presence + (objective1 + business_rules1 + acceptance2 + data1 + feature1) = 22
  assert.equal(rep.checks.length, 22);
});

test("分母修正：信号缺失时条件 section 不计入分母（即便 body 已填）", () => {
  const body = perfectBody();
  // 即便 body 里写了 api_requirements，hasApi=false 也应把它排除出分母
  const rep = completenessScore(body as never, noSignals());
  assert.ok(!rep.applicable.includes("api_requirements"), "api_requirements 不应出现在适用列表");
  assert.ok(!rep.present.includes("api_requirements"), "也不应计入 present");
  // 适用数回落到 7 核心
  assert.equal(rep.applicable.length, 7);
});

test("质量检查失败会拉低 score（objective 缺 success_metrics）", () => {
  const body = perfectBody();
  (body.objective as Record<string, unknown>).success_metrics = [];
  const rep = completenessScore(body as never, allSignals());
  // 22 项中 objective.has_success_metrics 失败 → 21/22 ≈ 0.954545 → 0.955
  assert.equal(rep.score, 0.955);
});

test("buildHints：完整度 + 缺失 section + 一致性计数", () => {
  const rep = completenessScore({} as never, noSignals());
  rep.score = 0.62;
  rep.missing = ["data_structures", "api_requirements", "glossary"];
  const issues = [
    { rule: "rule_ac_closure", level: "error", message: "x" },
    { rule: "rule_ac_closure", level: "error", message: "y" },
    { rule: "feature_data_closure", level: "error", message: "z" },
  ] as never;
  const hints = buildHints(rep, issues);
  assert.deepEqual(hints, [
    "完整度 62%",
    "缺数据结构、接口规范、术语表",
    "2 条规则无验收",
    "1 处实体引用悬空",
  ]);
});

test("buildHints：缺失 >3 时折叠为「缺X、Y、Z等 N 项」", () => {
  const rep = completenessScore({} as never, noSignals());
  rep.score = 0.5;
  rep.missing = ["data_structures", "api_requirements", "glossary", "metrics_analytics"];
  const hints = buildHints(rep, []);
  assert.deepEqual(hints, ["完整度 50%", "缺数据结构、接口规范、术语表等 4 项"]);
});

test("checkConsistency ①：业务规则未被任何验收覆盖 → rule_ac_closure", async () => {
  const body = {
    business_rules: [{ id: "BR-001", statement: "s", formal: { when: "w", then: "t" } }],
    acceptance_criteria: [],
  };
  const issues = await checkConsistency(body as never, "req-x");
  const closure = issues.filter((i) => i.rule === "rule_ac_closure");
  assert.ok(closure.some((i) => i.message.includes("BR-001") && i.message.includes("未被")));
});

test("checkConsistency ①：验收引用不存在的条目 → rule_ac_closure", async () => {
  const body = {
    business_rules: [],
    acceptance_criteria: [{ id: "AC-001", given: "g", when: "w", then: "t", maps_to: ["BR-999"] }],
  };
  const issues = await checkConsistency(body as never, "req-x");
  const closure = issues.filter((i) => i.rule === "rule_ac_closure");
  assert.ok(closure.some((i) => i.message.includes("BR-999") && i.message.includes("不存在")));
});

test("checkConsistency ②：feature 引用不存在的实体 → feature_data_closure", async () => {
  const body = {
    data_structures: { entities: [{ name: "E", fields: [{ name: "f", type: "string" }] }] },
    feature_logic: [{ id: "F-001", name: "n", description: "d", happy_path: ["h"], entity_refs: ["NoSuchEntity"] }],
  };
  const issues = await checkConsistency(body as never, "req-x");
  const fd = issues.filter((i) => i.rule === "feature_data_closure");
  assert.ok(fd.some((i) => i.message.includes("NoSuchEntity")), "应报告悬空实体引用");
});

test("checkConsistency ③：边界 refs 未挂钩 BR/F → edge_feature_closure", async () => {
  const body = {
    edge_cases: {
      boundary: [{ id: "EC-001", scenario: "s", handling: "h", refs: ["UNRELATED"] }],
    },
  };
  const issues = await checkConsistency(body as never, "req-x");
  const edge = issues.filter((i) => i.rule === "edge_feature_closure");
  assert.ok(edge.length > 0, "refs 未引用 BR-xxx/F-xxx 应报错");
});

test("sanity：SECTION_KEYS 恰为 16 个内容 section", () => {
  assert.equal(SECTION_KEYS.length, 16);
});
