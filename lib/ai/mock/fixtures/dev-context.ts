// DevContext mock 夹具（M5-D3）。
//
// 两条设计要求（缺一条，Phase 4 的 e2e 就失去判别力）：
//   1. 必须覆盖**全部 16 个内容 section**：定向重算可能命中任意一段，
//      基础夹具缺哪一段，那一段的「重算了但内容没变」就与「没重算」无法区分；
//   2. `generateDevContextSections` 的产出一律带 `〔mock-<tag>〕` 标记，
//      tag 由 prompt 指纹决定 → changeNote 一变，内容就变。

import { hashTag } from "../hash";
import type { SectionKey } from "@/lib/schemas/devcontext";

const SRC = {
  context_ids: [] as string[],
  decision_id: null,
  knowledge_ids: [] as string[],
  conversation_turn: null,
  confirmed_by: "ai_auto" as const,
  confirmed_at: null,
};

/** 基础 DevContext body（16 段齐全，且必须能过 DevContextBodySchema）。 */
export function devContextBaseFixture(): Record<string, unknown> {
  return {
    objective: {
      problem_statement: "（示例）用户在移动端快速记录灵感但缺乏结构化整理。",
      goal: "提供零门槛的极简记录 + 自动归类。",
      success_metrics: [{ metric: "次日留存", target: "≥35%", baseline: "—" }],
      _source: { ...SRC },
    },
    scope: {
      in_scope: ["灵感速记", "标签归类"],
      out_of_scope: ["团队协作"],
      _source: { ...SRC },
    },
    dependencies: {
      items: [
        {
          id: "DEP-001",
          name: "本地存储",
          type: "internal",
          description: "灵感离线暂存",
          _source: { ...SRC },
        },
      ],
      blocking: ["DEP-001"],
      _source: { ...SRC },
    },
    business_rules: [
      {
        id: "BR-001",
        statement: "单条灵感最长 280 字",
        formal: { when: "用户保存灵感", then: "若长度>280 则截断并提示" },
        priority: "P1",
        source_refs: [],
        _source: { ...SRC },
      },
    ],
    user_scenarios: {
      primary: [
        {
          id: "SC-001",
          actor: "用户",
          steps: ["打开应用", "点击速记", "输入并保存"],
          expected: "灵感出现在首页时间线",
          _source: { ...SRC },
        },
      ],
      _source: { ...SRC },
    },
    feature_logic: [
      {
        id: "F-001",
        name: "灵感速记",
        description: "极简输入框保存灵感",
        happy_path: ["点击 +", "输入", "保存"],
        entity_refs: ["Note"],
        rule_refs: ["BR-001"],
        _source: { ...SRC },
      },
    ],
    data_structures: {
      entities: [
        {
          name: "Note",
          description: "用户灵感",
          fields: [
            { name: "id", type: "uuid", required: true },
            { name: "content", type: "string", required: true, constraints: "<=280" },
            { name: "tags", type: "string[]", required: false },
          ],
          _source: { ...SRC },
        },
      ],
      _source: { ...SRC },
    },
    api_requirements: {
      rest: [
        {
          id: "API-001",
          method: "POST",
          path: "/api/notes",
          auth: "Bearer",
          params: [{ name: "content", in: "body", type: "string", required: true }],
          entity_refs: ["Note"],
          _source: { ...SRC },
        },
      ],
      _source: { ...SRC },
    },
    integration_external: {
      systems: [
        {
          name: "对象存储",
          type: "存储服务",
          purpose: "保存灵感附件",
          auth: "AK/SK",
          endpoints: ["PUT /objects"],
          _source: { ...SRC },
        },
      ],
      _source: { ...SRC },
    },
    edge_cases: {
      boundary: [
        {
          id: "EC-001",
          scenario: "灵感恰好 280 字",
          handling: "允许保存",
          refs: ["BR-001"],
          _source: { ...SRC },
        },
      ],
    },
    non_functional_requirements: {
      performance: [
        {
          requirement: "保存 P95 延迟 ≤ 200ms",
          metric: "P95 latency",
          _source: { ...SRC },
        },
      ],
    },
    acceptance_criteria: [
      {
        id: "AC-001",
        given: "用户已登录",
        when: "保存一条短于 280 字的灵感",
        then: "灵感出现在首页时间线",
        maps_to: ["BR-001", "F-001"],
        category: "functional",
        _source: { ...SRC },
      },
    ],
    test_cases: [
      {
        id: "TC-001",
        title: "保存正常灵感",
        steps: ["输入 100 字", "保存"],
        expected: "保存成功并展示",
        maps_to: ["AC-001"],
        type: "functional",
        _source: { ...SRC },
      },
    ],
    metrics_analytics: {
      events: [{ name: "note_created", description: "灵感创建" }],
      _source: { ...SRC },
    },
    glossary: [{ term: "灵感", definition: "用户的一次轻量记录" }],
    open_questions: [{ id: "Q-001", question: "是否需要离线保存？", context: "弱网场景" }],
  };
}

/**
 * 允许被 `〔mock-<tag>〕` 标记改写的叶子键白名单。
 *
 * 为什么是白名单而不是黑名单：DevContext 里有一批**格式/交叉引用强约束**的字符串，
 * 一旦改了就 Schema 校验失败或一致性校验失败，反过来污染 e2e：
 *   - `id`（BR-001 / SC-001 / DEP-001 / Q-001 … 都有正则）
 *   - `priority` / `category` / `type` / `platform` / `method` / `in` / `auth`（枚举）
 *   - `entities[].name`（被 feature.entity_refs 引用）、`maps_to` / `rule_refs` / `entity_refs`
 *   - `_source` 整棵子树（被一致性校验逐项核查）
 * 白名单只放「纯自由文本」，改写它们既可见又绝对安全。
 */
const MARKABLE_KEYS = new Set([
  "description",
  "expected",
  "handling",
  "scenario",
  "given",
  "when",
  "then",
  "requirement",
  "goal",
  "problem_statement",
  "question",
  "context",
  "title",
  "purpose",
  "metric",
  "statement",
  "definition",
  "in_scope",
  "out_of_scope",
  "steps",
  "happy_path",
]);

/** 递归给白名单键的字符串叶子追加标记；`_source` 子树整体跳过。 */
function mark(value: unknown, key: string | null, tag: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return key !== null && MARKABLE_KEYS.has(key) ? `${value}〔mock-${tag}〕` : value;
  }
  if (Array.isArray(value)) {
    // 数组元素的「有效键」= 数组自身的键（`in_scope: [...]` / `steps: [...]`）
    if (key === "_source") return value;
    return value.map((v) => mark(v, key, tag));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "_source") {
        out[k] = v; // 溯源子树原样保留（一致性校验会逐项核查）
        continue;
      }
      out[k] = mark(v, k, tag);
    }
    return out;
  }
  return value;
}

/**
 * 生成指定 section 的 mock 内容（定向重算用）。
 *
 * - 只返回被请求的 section：调用方（regenerateSections）会用它逐段替换，
 *   未请求的段必须缺席，否则「其余段逐字节未变」的断言立刻失真；
 * - tag 由 `seed` 派生，而 seed = 完整 prompt 指纹 → changeNote / 请求段集合一变，
 *   内容就变（e2e 才能区分「重算了」与「没重算」）。
 */
export function generateDevContextSections(
  sections: SectionKey[],
  seed: string
): Record<string, unknown> {
  const tag = hashTag(seed);
  const base = devContextBaseFixture();
  const out: Record<string, unknown> = {};
  for (const s of sections) {
    if (!(s in base)) continue;
    out[s] = mark(base[s], s, tag);
  }
  return out;
}
