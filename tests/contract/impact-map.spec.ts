// 影响映射覆盖性契约测试（M5-D2 · 本组最高优先级）。
//
// 这组测试是风险 R-M5-1（映射表覆盖不全 → 漏重算）的主要防线。全是**纯结构断言**，
// 毫秒级，但能拦住绝大多数「加了东西忘了同步」的错误——漏重算的后果是静默产出
// 错误的机器规格去毒害 AI Coding，比报错严重得多。
//
// ⚠️ 本文件刻意从 §import 依赖的具体代码模块**反射式**取字段名（CARD_FIELDS），
// 而不是硬编码字符串——这样「给卡片加字段」这个动作会必然让 CI 报红。

import { test, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SECTION_KEYS } from "@/lib/schemas/devcontext";
import {
  ALL_SECTIONS,
  ALL_TRIGGERS,
  DIRECT_IMPACT,
  resolveAffectedSections,
  SECTION_CLOSURE,
  ALWAYS_RECOMPUTE,
  type ImpactTrigger,
} from "@/lib/services/devcontext-impact";
import { CARD_FIELDS } from "@/lib/services/card";

// card.ts 会拉进 AI client / requirements / 连接器（重依赖），这里只需要它的 CARD_FIELDS 常量。
// 不 mock 的话契约测试会去初始化 cloudbase 客户端，既慢又依赖环境变量。
vi.mock("@/lib/ai/client", () => ({ callAI: vi.fn() }));
vi.mock("@/lib/services/requirements", () => ({
  getRequirement: vi.fn(),
  finalizeCardVersion: vi.fn(),
}));
vi.mock("@/lib/ai/connectors/internal/save-card", () => ({
  saveCardConnector: { execute: vi.fn() },
}));
vi.mock("@/lib/ai/prompts/card-merge", () => ({ cardMergeSystemPrompt: "" }));

const VALID_SECTIONS = new Set<string>(ALL_SECTIONS);

/** 直接 + 闭包命中的并集（不含 ALWAYS_RECOMPUTE）。 */
function reachOf(trigger: ImpactTrigger): Set<string> {
  return new Set(resolveAffectedSections([trigger]).sections);
}

test("Trigger 全覆盖：DIRECT_IMPACT 的键集合 ≡ ALL_TRIGGERS", () => {
  assert.deepEqual(
    Object.keys(DIRECT_IMPACT).sort(),
    [...ALL_TRIGGERS].sort(),
    "有 trigger 忘了在 DIRECT_IMPACT 加映射 = 漏重算"
  );
  // 顺手钉住规模：**14** 项封闭枚举（增删都必须是有意识的改动）。
  // 主计划原文写「15 项」，但它自己的 union 与 DIRECT_IMPACT 都只有 14 行
  // （6 卡片 + 3 调研 + 1 方案 + 1 原型 + 1 PRD + 2 决策/知识），是原文算术笔误。
  assert.equal(ALL_TRIGGERS.length, 14);
  assert.equal(new Set(ALL_TRIGGERS).size, 14, "ALL_TRIGGERS 不得重复");
});

test("Section 名合法：三张表里出现的 section 都必须在 schema 键集合内", () => {
  for (const [trigger, sections] of Object.entries(DIRECT_IMPACT)) {
    for (const s of sections) {
      assert.ok(VALID_SECTIONS.has(s), `DIRECT_IMPACT["${trigger}"] 含非法 section："${s}"`);
    }
  }
  for (const [from, tos] of Object.entries(SECTION_CLOSURE)) {
    assert.ok(VALID_SECTIONS.has(from), `SECTION_CLOSURE 的键非法："${from}"`);
    for (const t of tos ?? []) {
      assert.ok(VALID_SECTIONS.has(t), `SECTION_CLOSURE["${from}"] 含非法 section："${t}"`);
    }
  }
  for (const s of ALWAYS_RECOMPUTE) {
    assert.ok(VALID_SECTIONS.has(s), `ALWAYS_RECOMPUTE 含非法 section："${s}"`);
  }
  // 16 个内容段 + meta + references，一个不多一个不少
  assert.equal(ALL_SECTIONS.length, SECTION_KEYS.length + 2);
});

test("反向覆盖：每个核心 section 至少被 1 个 trigger 直接或经闭包命中", () => {
  // 核心段清单（schema 的 SECTION_APPLICABILITY.core）
  const CORE = [
    "objective",
    "scope",
    "business_rules",
    "user_scenarios",
    "feature_logic",
    "edge_cases",
    "acceptance_criteria",
  ] as const;

  const covered = new Set<string>();
  for (const t of ALL_TRIGGERS) {
    for (const s of reachOf(t)) covered.add(s);
  }
  for (const s of CORE) {
    assert.ok(
      covered.has(s),
      `核心 section "${s}" 永远不会被任何 trigger 命中 = 永久性 stale`
    );
  }
});

test("PRD 隔离（AD-2）：改 PRD 绝不能反向污染 DevContext", () => {
  assert.deepEqual(DIRECT_IMPACT["prd.markdown"], [], "prd.markdown 必须是显式空集");
  assert.deepEqual(
    resolveAffectedSections(["prd.markdown"]).sections,
    ["meta", "references"],
    "仅 PRD 变更时只允许重算两个元段"
  );
  // 闭包表里不得出现任何以 prd 命名的路径（prd 不是 DevContext 的 section）
  for (const [from, tos] of Object.entries(SECTION_CLOSURE)) {
    assert.ok(!from.startsWith("prd"), `SECTION_CLOSURE 出现 PRD 路径："${from}"`);
    for (const t of tos ?? []) {
      assert.ok(!t.startsWith("prd"), `SECTION_CLOSURE 指向 PRD："${t}"`);
    }
  }
});

test("闭包无环且收敛：任何 section 都不能经闭包回到自己", () => {
  // 迭代上界 = 节点数；若存在环，frontier 永不为空，下面的自反断言会先炸
  for (const start of ALL_SECTIONS) {
    const reach = new Set<string>();
    let frontier: string[] = [start];
    for (let i = 0; i < ALL_SECTIONS.length && frontier.length > 0; i++) {
      const next: string[] = [];
      for (const s of frontier) {
        for (const t of SECTION_CLOSURE[s as keyof typeof SECTION_CLOSURE] ?? []) {
          if (!reach.has(t)) {
            reach.add(t);
            next.push(t);
          }
        }
      }
      frontier = next;
    }
    assert.equal(frontier.length, 0, `闭包在 ${ALL_SECTIONS.length} 次迭代内未收敛（疑似有环）`);
    assert.ok(!reach.has(start), `"${start}" 经闭包回到了自己（环）`);
  }
});

test("卡片字段全覆盖：每个 CARD_FIELDS 字段都有对应 card.<field> trigger", () => {
  const cardTriggers = new Set(
    ALL_TRIGGERS.filter((t) => t.startsWith("card.")).map((t) => t.slice(5))
  );
  for (const f of CARD_FIELDS) {
    assert.ok(
      cardTriggers.has(f),
      `卡片字段 "${f}" 没有对应的 card.${f} trigger（加字段必须同批加 trigger）`
    );
  }
  assert.equal(
    cardTriggers.size,
    CARD_FIELDS.length,
    "card.* trigger 数量与 CARD_FIELDS 数量不一致（多出的 trigger 是死代码）"
  );
});

// ────────────────── C1：影响判定与 stale 标记**全程无 LLM** ──────────────────

test("★ C1：影响判定模块不得依赖 AI 客户端（源码级守卫）", () => {
  // 标准原文：DevContext 影响判定**全程无 LLM 调用**。
  //
  // 为什么用源码扫描而不是「数调用次数」：计数只能在 e2e 里做，而 e2e 跑的是 mock
  // provider——mock 模式下"有没有调 LLM"这件事在运行时是隐形的（mock 永远成功）。
  // 直接禁止 import AI 客户端，才能在任何改动之后立刻拦住「顺手在这里加一次 AI 调用」。
  //
  // 注：`resolveAffectedSections` 本身是**同步纯函数**（签名即证明），
  // 这条测试守的是「它的调用方（标记链路）也别偷偷引入 AI」。
  for (const rel of [
    "lib/services/devcontext-impact.ts",
    "lib/services/devcontext.ts",
  ]) {
    const src = fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
    const importLines = src
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l) || /from\s+".*"/.test(l));
    const offenders = importLines.filter((l) => l.includes("@/lib/ai"));
    assert.deepEqual(
      offenders,
      [],
      `${rel} 引用了 AI 层：${offenders.join(" | ")}\n` +
        `影响判定与 stale 标记必须是确定性的（C1）；AI 调用只允许出现在 lib/ai/** 里。`
    );
  }
});

test("ALWAYS_RECOMPUTE 恒被并入结果（任何 trigger 组合）", () => {
  const combos: ImpactTrigger[][] = [
    [],
    ["prd.markdown"],
    ["card.constraints", "solution.doc"],
    ["knowledge.changed"],
  ];
  for (const c of combos) {
    const { sections } = resolveAffectedSections(c);
    for (const s of ALWAYS_RECOMPUTE) {
      assert.ok(sections.includes(s), `trigger=${JSON.stringify(c)} 缺 ${s}`);
    }
  }
});
