// DevContext 渲染器单测（M2-E）：5 种交付格式输出 + _source 溯源剔除。
//
// 渲染器零 db 依赖，仅 import type from schemas，可直接在 tsx 下运行。
//
// 运行：npx tsx --test lib/services/devcontext-render.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  renderMarkdown,
  renderCursorRules,
  renderClaudeMd,
  renderPrompt,
  stripSource,
} from "@/lib/services/devcontext-render";
import type { DevContext } from "@/lib/schemas/devcontext";

const src = {
  context_ids: [] as string[],
  decision_id: null,
  knowledge_ids: [] as string[],
  conversation_turn: null,
  confirmed_by: "ai_auto" as const,
  confirmed_at: null,
};

// 一个含 6 个 section（objective / business_rules / data_structures /
// api_requirements / acceptance_criteria / glossary）的样例 DevContext。
const ctx = {
  $schema: "https://askbuddy.dev/schemas/dev-context/v1.json",
  schema_version: "1.0",
  meta: {
    requirement_id: "r",
    title: "t",
    version: 2,
    status: "draft",
    generated_at: "2026-01-01T00:00:00Z",
    generated_by: "devcontext-agent@v1",
    completeness_score: 0.5,
    applicable_sections: [],
    present_sections: [],
    consistency_issues: [],
    source_links: {},
    changelog: [],
  },
  references: {},
  objective: {
    problem_statement: "用户在审批流里容易漏填",
    goal: "提供实时校验",
    success_metrics: [{ metric: "漏填率", target: "<5%", baseline: "基准" }],
    non_goals: ["不做审批建模"],
    _source: src,
  },
  business_rules: [
    { id: "BR-001", statement: "金额>1万需双人复核", formal: { when: "金额>10000", then: "触发双人复核" }, priority: "P0", source_refs: [], _source: src },
  ],
  data_structures: {
    entities: [
      { name: "Approval", description: "审批单", fields: [{ name: "amount", type: "int", required: true, description: "金额" }], _source: src },
    ],
  },
  api_requirements: {
    rest: [
      {
        id: "API-001", method: "POST", path: "/api/approval", auth: "jwt",
        params: [{ name: "amount", in: "body", type: "int", required: true }],
        errors: [{ code: 400, when: "金额缺失" }],
        entity_refs: [], _source: src,
      },
    ],
  },
  acceptance_criteria: [
    { id: "AC-001", given: "审批单已创建", when: "金额=20000", then: "系统要求双人复核", maps_to: ["BR-001"], category: "functional", _source: src },
  ],
  glossary: [{ term: "双人复核", definition: "两名审批人分别确认" }],
} as unknown as DevContext;

test("renderMarkdown：含版本/完整度头 + 按出现顺序编号的 section", () => {
  const md = renderMarkdown(ctx);
  assert.ok(md.includes("需求 ｜ 版本 v2 ｜ 完整度 50%"), "头部应含版本与完整度");
  // 顺序按 present 列表本地编号：objective=1 … glossary=6
  assert.ok(md.includes("1. 需求目标"), "objective 排第 1");
  assert.ok(md.includes("2. 业务规则"), "business_rules 排第 2");
  assert.ok(md.includes("5. 验收标准"), "acceptance_criteria 排第 5");
  assert.ok(md.includes("6. 术语表"), "glossary 排第 6");
  // 未生成的 section 不应出现
  assert.ok(!md.includes("范围"), "未生成的 scope 不应出现");
});

test("renderCursorRules：含五块 + 红线，且不含未生成 section", () => {
  const cr = renderCursorRules(ctx);
  assert.ok(cr.includes("## 业务规则"));
  assert.ok(cr.includes("## 数据模型"), "data_structures 渲染为「数据模型」");
  assert.ok(cr.includes("## API 约定"), "api_requirements.rest 渲染为「API 约定」");
  assert.ok(cr.includes("## 验收标准（实现后自检）"));
  assert.ok(cr.includes("## 红线"));
  assert.ok(cr.includes("视觉稿见原型 HTML"), "红线应提示视觉稿来源");
  assert.ok(!cr.includes("## 范围"), "未生成的 scope 不应出现");
});

test("renderClaudeMd：含自动生成注释 + 项目记忆标题 + 红线", () => {
  const cm = renderClaudeMd(ctx);
  assert.ok(cm.includes("<!-- 本文件由 AskBuddy 自动生成，请勿手动编辑"));
  assert.ok(cm.includes("# 项目记忆：开发上下文"));
  assert.ok(cm.includes("## 目标"));
  assert.ok(cm.includes("## 业务规则"));
  assert.ok(cm.includes("## 数据模型"));
  assert.ok(cm.includes("## 接口"), "api 渲染为「接口」");
  assert.ok(cm.includes("## 验收标准"));
  assert.ok(cm.includes("## 术语"));
  assert.ok(cm.includes("## 红线"));
  assert.ok(!cm.includes("## 范围"), "未生成的 scope 不应出现");
});

test("renderPrompt：含引导语 + <dev_context> 围栏（小体积不剔除 _source）", () => {
  const p = renderPrompt(ctx);
  assert.ok(p.includes("下面是为本需求生成的结构化开发上下文"));
  assert.ok(p.includes("<dev_context>"));
  assert.ok(p.includes("</dev_context>"));
  // 体积 < 60000，应保留溯源
  assert.ok(p.includes('"_source"'), "小体积渲染应保留 _source");
});

test("stripSource：递归剔除所有层级的 _source，保留其余字段", () => {
  const input = {
    a: 1,
    _source: { context_ids: ["c1"] },
    b: { c: 2, _source: { decision_id: "d" } },
    list: [{ x: 1, _source: {} }, { y: 2 }],
  };
  const out = stripSource(input) as Record<string, unknown>;
  assert.deepEqual(out, {
    a: 1,
    b: { c: 2 },
    list: [{ x: 1 }, { y: 2 }],
  });
  // 任何层级都不应残留 _source
  JSON.stringify(out, (k, v) => {
    if (k === "_source") throw new Error("仍存在 _source");
    return v;
  });
});
