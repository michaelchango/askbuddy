// 影响解析单测（M5-D2）：10 组金样本 + 算法断言。
//
// 金样本的期望值是**按规范顺序**（meta 首、references 尾、中间严格按 schema 声明顺序）
// 逐个手算出来的——顺序本身是契约的一部分：结果确定才能深等断言，也才能让
// 「重算完 changelog 里的 changed_sections」稳定可读。
//
// 注：主计划 M5-4.4 里「只改约束」那行的示例顺序（dependencies 排在 edge_cases 之后）
// 与它自己规定的「按 schema 顺序输出」自相矛盾，此处以**规范顺序**为准（另外两组
// 写全了的金样本都与规范顺序一致）。

import { test } from "vitest";
import assert from "node:assert/strict";
import {
  ALL_SECTIONS,
  ALL_TRIGGERS,
  buildStaleMeta,
  cardFieldTrigger,
  presentSections,
  resolveAffectedSections,
  type ImpactTrigger,
} from "@/lib/services/devcontext-impact";

// ───────────────────────── 卡片字段 → trigger / 现存段落 ─────────────────────────

test("cardFieldTrigger：<field> → card.<field>（路由用它把 changedFields 换成 trigger）", () => {
  assert.equal(cardFieldTrigger("constraints"), "card.constraints");
  assert.equal(cardFieldTrigger("targetUsers"), "card.targetUsers");
  // 必须是封闭集合内的成员，否则契约测试的「全覆盖」失去意义
  assert.ok((ALL_TRIGGERS as readonly string[]).includes(cardFieldTrigger("scope")));
});

test("presentSections：只认「真的存在」的段，且按规范顺序输出", () => {
  const content = {
    $schema: "x",
    meta: { version: 1 },
    // 故意乱序 + 含协议字段
    acceptance_criteria: [{ id: "AC-001" }],
    objective: { goal: "g" },
    references: { prd_version: 1 },
    data_structures: null, // null 视为「不存在」
    glossary: undefined, // undefined 视为「不存在」
    business_rules: [], // 空数组仍是「存在」（缺段才不输出，空段不出现）
  };
  assert.deepEqual(presentSections(content), [
    "meta",
    "objective",
    "business_rules",
    "acceptance_criteria",
    "references",
  ]);
});

test("presentSections：脏输入（空 / null / 非对象）→ 空数组，不抛错", () => {
  assert.deepEqual(presentSections(null), []);
  assert.deepEqual(presentSections(undefined), []);
  assert.deepEqual(presentSections({}), []);
  assert.deepEqual(presentSections([] as unknown as Record<string, unknown>), []);
});

// ─────────────────────────── MCP / UI 过期元信息 ───────────────────────────

test("buildStaleMeta：无过期段时 warning 为空串、maybe_stale=false", () => {
  const m = buildStaleMeta({
    current_version: 3,
    status: "confirmed",
    completeness_score: 0.82,
    maybe_stale: 0,
    stale_sections: [],
  });
  assert.equal(m.maybe_stale, false);
  assert.equal(m.warning, "");
  assert.deepEqual(m.stale_sections, []);
  assert.equal(m.version, 3);
});

test("★ buildStaleMeta：warning 是自然语言且列出中文段名（给 AI Coding Agent 看的）", () => {
  const m = buildStaleMeta({
    current_version: 5,
    status: "confirmed",
    completeness_score: 0.8,
    maybe_stale: 1,
    stale_sections: ["business_rules", "acceptance_criteria"],
  });
  assert.equal(m.maybe_stale, true);
  assert.match(m.warning, /业务规则/);
  assert.match(m.warning, /验收标准/);
  assert.match(m.warning, /尚未重算/);
  // 必须给出可执行的下一步，否则 Agent 只能干瞪眼
  assert.match(m.warning, /dev-context\/refresh/);
});

test("buildStaleMeta：列值与清单不一致的中间态按「过期」处理（宁可多报不可漏报）", () => {
  // maybe_stale 被清但 stale_sections 还在（历史中间态）→ 必须仍报过期
  const a = buildStaleMeta({
    current_version: 1,
    status: "draft",
    completeness_score: 0.5,
    maybe_stale: 0,
    stale_sections: ["glossary"],
  });
  assert.equal(a.maybe_stale, true);

  // 反过来：清单为空但列值=1 → 同样报过期
  const b = buildStaleMeta({
    current_version: 1,
    status: "draft",
    completeness_score: 0.5,
    maybe_stale: 1,
    stale_sections: [],
  });
  assert.equal(b.maybe_stale, true);
  assert.match(b.warning, /尚未重算/);
});

test("buildStaleMeta：脏数据（stale_sections 不是数组）不炸", () => {
  const m = buildStaleMeta({
    current_version: 1,
    status: "draft",
    completeness_score: 0.5,
    maybe_stale: 0,
    stale_sections: undefined,
  });
  assert.deepEqual(m.stale_sections, []);
  assert.equal(m.maybe_stale, false);
});

const GOLDEN: Array<{ name: string; triggers: ImpactTrigger[]; expect: string[] }> = [
  {
    name: "只改约束（级联最广：规则→验收→测试用例）",
    triggers: ["card.constraints"],
    expect: [
      "meta",
      "dependencies",
      "business_rules",
      "edge_cases",
      "acceptance_criteria",
      "test_cases",
      "references",
    ],
  },
  {
    name: "只改目标用户",
    triggers: ["card.targetUsers"],
    expect: ["meta", "objective", "user_scenarios", "metrics_analytics", "references"],
  },
  {
    name: "只改非功能",
    triggers: ["card.nonFunctional"],
    expect: ["meta", "non_functional_requirements", "references"],
  },
  {
    name: "改范围（级联广）",
    triggers: ["card.scope"],
    expect: [
      "meta",
      "objective",
      "scope",
      "feature_logic",
      "data_structures",
      "api_requirements",
      "acceptance_criteria",
      "test_cases",
      "metrics_analytics",
      "references",
    ],
  },
  {
    name: "方案文档变更",
    triggers: ["solution.doc"],
    expect: [
      "meta",
      "feature_logic",
      "data_structures",
      "api_requirements",
      "integration_external",
      "non_functional_requirements",
      "acceptance_criteria",
      "test_cases",
      "references",
    ],
  },
  {
    name: "原型结构变更",
    triggers: ["prototype.structure"],
    expect: [
      "meta",
      "user_scenarios",
      "feature_logic",
      "data_structures",
      "api_requirements",
      "edge_cases",
      "acceptance_criteria",
      "test_cases",
      "references",
    ],
  },
  {
    name: "★ 仅 PRD 变更 → 只重算两个元段（AD-2 隔离）",
    triggers: ["prd.markdown"],
    expect: ["meta", "references"],
  },
  {
    name: "知识库变更",
    triggers: ["knowledge.changed"],
    expect: [
      "meta",
      "business_rules",
      "edge_cases",
      "acceptance_criteria",
      "test_cases",
      "glossary",
      "references",
    ],
  },
  {
    name: "多 trigger 合并（并集去重）",
    triggers: ["card.scope", "solution.doc"],
    expect: [
      "meta",
      "objective",
      "scope",
      "feature_logic",
      "data_structures",
      "api_requirements",
      "integration_external",
      "non_functional_requirements",
      "acceptance_criteria",
      "test_cases",
      "metrics_analytics",
      "references",
    ],
  },
];

for (const g of GOLDEN) {
  test(`金样本 · ${g.name}`, () => {
    const r = resolveAffectedSections(g.triggers);
    assert.deepEqual(r.sections, g.expect);
    assert.equal(r.fullRecompute, false);
    assert.deepEqual(r.unmapped, []);
    // 结果严格按规范顺序（不是"恰好有序"，而是等于规范顺序的子序列）
    const ordered = ALL_SECTIONS.filter((s) => r.sections.includes(s));
    assert.deepEqual(r.sections, ordered);
  });
}

test("金样本 · 未知 trigger → FULL_RECOMPUTE（fail-safe 全量重算）", () => {
  const r = resolveAffectedSections(["card.unknownField" as ImpactTrigger]);
  assert.equal(r.fullRecompute, true);
  assert.deepEqual(r.unmapped, ["card.unknownField"]);
  // 拿不到现值时保守取全集（含 meta/references）
  assert.deepEqual(r.sections, [...ALL_SECTIONS]);
});

test("fail-safe 的边界是「当前实际存在的 section」而非 18 全集", () => {
  const existing = ["meta", "objective", "business_rules", "references"] as const;
  const r = resolveAffectedSections(["nope" as ImpactTrigger], {
    existing: [...existing],
  });
  assert.equal(r.fullRecompute, true);
  assert.deepEqual(r.sections, ["meta", "objective", "business_rules", "references"]);
});

test("空输入 → 只重算两个元段（不空转、也不误标内容段）", () => {
  const r = resolveAffectedSections([]);
  assert.deepEqual(r.sections, ["meta", "references"]);
  assert.deepEqual(r.direct, []);
  assert.equal(r.fullRecompute, false);
});

test("direct 是闭包展开【前】的直接命中（供 UI 显示「因何过期」）", () => {
  const r = resolveAffectedSections(["card.constraints"]);
  // dependencies/business_rules/edge_cases 是直接命中；
  // acceptance_criteria/test_cases 是闭包产物，不进 direct
  assert.deepEqual(r.direct, ["dependencies", "business_rules", "edge_cases"]);
  assert.ok(!r.direct.includes("test_cases"));
  assert.ok(r.sections.includes("test_cases"));
});

test("reason：每个 section 记录命中的全部 trigger（多源合并去重）", () => {
  const r = resolveAffectedSections(["card.constraints", "knowledge.changed"]);
  assert.deepEqual(r.reason.business_rules, ["card.constraints", "knowledge.changed"]);
  assert.deepEqual(r.reason.edge_cases, ["card.constraints", "knowledge.changed"]);
  assert.deepEqual(r.reason.dependencies, ["card.constraints"]);
  assert.deepEqual(r.reason.glossary, ["knowledge.changed"]);
  // 闭包产物没有直接 trigger，不该出现在 reason 里（UI 不应声称"因 X 变更"）
  assert.equal(r.reason.test_cases, undefined);
});

test("decision.accepted 特例：targetPath 首段定位 section", () => {
  const r = resolveAffectedSections([
    { trigger: "decision.accepted", targetPath: "business_rules[2].formal.then" },
  ]);
  assert.deepEqual(r.unmapped, []);
  assert.equal(r.fullRecompute, false);
  assert.ok(r.direct.includes("business_rules"));
  assert.deepEqual(r.reason.business_rules, ["decision.accepted"]);
  // 同一个 section 的闭包照常展开
  assert.ok(r.sections.includes("acceptance_criteria"));
  assert.ok(r.sections.includes("test_cases"));
});

test("decision.accepted：targetPath 解析不出 → 计入 unmapped 并降级全量", () => {
  for (const bad of ["", "不是section", "meta", "references", "Unknown[0].x"]) {
    const r = resolveAffectedSections([{ trigger: "decision.accepted", targetPath: bad }]);
    assert.equal(r.fullRecompute, true, `"${bad}" 应触发 fail-safe`);
    assert.deepEqual(r.unmapped, [bad]);
  }
});

test("确定性：同一输入必得同一数组（可直接深等断言）", () => {
  const input: ImpactTrigger[] = ["prototype.structure", "card.targetUsers", "knowledge.changed"];
  const a = resolveAffectedSections(input);
  const b = resolveAffectedSections(input);
  assert.deepEqual(a, b);
  assert.deepEqual(a.sections, [...ALL_SECTIONS].filter((s) => a.sections.includes(s)));
});

test("重复 trigger 不会造成重复 section（去重）", () => {
  const r = resolveAffectedSections(["card.scope", "card.scope", "card.scope"]);
  assert.equal(new Set(r.sections).size, r.sections.length);
  assert.deepEqual(r.reason.scope, ["card.scope"]);
  assert.deepEqual(r.reason.objective, ["card.scope"]);
});
