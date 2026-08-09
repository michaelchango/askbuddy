// DevContext 多段式结构定义（唯一权威）。依据：《DevContext结构设计.md》§3 候选 Section 全集。
// 硬约束：
//   1. 本文件零运行时依赖（只 import zod），可被服务端与客户端同时 import。
//      —— 与 lib/steps-meta.ts 同理，避免把 @/lib/db（含 @cloudbase/node-sdk）拉进客户端包。
//   2. 所有内容 section 一律 .optional()；数组 optional 时允许空（AI 习惯给 []）。
//      必填的核心 section（如 ScopeSchema.in_scope）才保留 .min(1)。
//   3. 顶层 .strict()：模型不得发明新 section。
//   4. meta 中的 completeness_score / status / version / generated_at / source_links
//      由代码填充，不由模型生成（决策 M2-D3）。
//
// 【M2-B7 放宽】可选 string 字段统一用 nullish()（= nullable + optional），
// 可选 array 字段移除 .min(1)。理由：AI 模型输出可选字段时常写 null 或 [],
// 严格 schema 让 schema 校验失败概率飙升。完整度评分仍由代码端按「有非空值」判定。

import { z } from "zod";

// 便捷别名：可选字符串 = null 或 undefined 都接受
const optStr = () => z.string().nullish();
// 可选数组 = null / undefined / [] / [...] 都接受
const optArr = <T extends z.ZodTypeAny>(item: T) => z.array(item).nullish();
// 可选枚举 = null / undefined / 合法值 都接受
const optEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values).nullish();

/** 条目级溯源（AD-3：条目级粒度，不做句子级）。M3 落地完整链路，M2 先写入 + 校验。 */
export const SourceSchema = z.object({
  context_ids: z.array(z.string()).default([]), // 上游产物条目 id（M2：card 字段名 / feature id / story id / prototype page id）
  decision_id: z.string().nullable().default(null), // M3 的 decisions 表；M2 恒 null
  knowledge_ids: z.array(z.string()).default([]), // M4 的 knowledge_entries；M2 恒 []
  conversation_turn: z.number().int().nonnegative().nullable().default(null),
  confirmed_by: z.enum(["user", "ai_auto"]).default("ai_auto"),
  confirmed_at: z.string().nullable().default(null), // ISO8601
});
export type DevContextSource = z.infer<typeof SourceSchema>;

/** 16 个内容 section（参与 completeness_score）。meta / references 为元段，不计分。 */
export const SECTION_KEYS = [
  "objective", "scope", "dependencies",
  "business_rules", "user_scenarios",
  "feature_logic", "data_structures", "api_requirements", "integration_external", "edge_cases",
  "non_functional_requirements", "acceptance_criteria", "test_cases", "metrics_analytics",
  "glossary", "open_questions",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/** 核心=恒计入分母；条件=仅当上游有信号时计入（§3 的【核心】/【条件】标注）。 */
export const SECTION_APPLICABILITY: Record<SectionKey, "core" | "conditional"> = {
  objective: "core", scope: "core", dependencies: "conditional",
  business_rules: "core", user_scenarios: "core",
  feature_logic: "core", data_structures: "conditional", api_requirements: "conditional",
  integration_external: "conditional", edge_cases: "core",
  non_functional_requirements: "conditional", acceptance_criteria: "core",
  test_cases: "conditional", metrics_analytics: "conditional",
  glossary: "conditional", open_questions: "conditional",
};

/** §5 PRD 对应矩阵：DevContext section ↔ PRD `##` 章节锚点（用于一致性检查第 5 条）。 */
export const PRD_SECTION_MAP: Partial<Record<SectionKey, string[]>> = {
  objective: ["背景与目标", "背景与依据", "概述", "目标与范围"],
  scope: ["范围", "目标与范围"],
  business_rules: ["业务规则"],
  user_scenarios: ["用户场景", "用户故事"],
  feature_logic: ["功能设计", "功能详情", "产品方案"],
  data_structures: ["数据模型"],
  api_requirements: ["接口设计"],
  edge_cases: ["边界与异常"],
  non_functional_requirements: ["非功能需求"],
  acceptance_criteria: ["验收标准"],
};

/** 中文标签（渲染器与提示文案共用，单一事实源）。 */
export const SECTION_LABELS: Record<SectionKey, string> = {
  objective: "需求目标",
  scope: "范围",
  dependencies: "依赖",
  business_rules: "业务规则",
  user_scenarios: "用户场景",
  feature_logic: "功能逻辑",
  data_structures: "数据结构",
  api_requirements: "接口规范",
  integration_external: "外部集成",
  edge_cases: "边界与异常",
  non_functional_requirements: "非功能需求",
  acceptance_criteria: "验收标准",
  test_cases: "测试用例",
  metrics_analytics: "指标分析",
  glossary: "术语表",
  open_questions: "待确认事项",
};

// ── 第 1 层：为什么 & 范围 ────────────────────────────────
export const ObjectiveSchema = z.object({
  problem_statement: z.string().min(1),
  goal: z.string().min(1),
  success_metrics: z.array(z.object({
    metric: z.string().min(1),
    target: z.string().min(1),
    baseline: optStr(),
    measurement: optStr(),
  })).min(1).optional(),
  non_goals: optArr(z.string().min(1)), // AI 常给 []
  _source: SourceSchema,
});

export const ScopeSchema = z.object({
  in_scope: z.array(z.string().min(1)).min(1),
  out_of_scope: optArr(z.string().min(1)),
  assumptions: optArr(z.string().min(1)),
  _source: SourceSchema,
});

// ── 第 2 层：人 & 规则 ────────────────────────────────────
export const BusinessRuleSchema = z.object({
  id: z.string().regex(/^BR-\d{3}$/, "业务规则 id 必须形如 BR-001"),
  statement: z.string().min(1),
  formal: z.object({ // 「可判定」是硬要求，参与完整度质量检查
    when: z.string().min(1),
    then: z.string().min(1),
  }),
  priority: optEnum(["P0", "P1", "P2"]),
  source_refs: z.array(z.string()).default([]),
  _source: SourceSchema,
});

export const UserScenariosSchema = z.object({
  personas: optArr(z.object({
    name: z.string().min(1), description: optStr(),
  })),
  primary: z.array(z.object({
    id: z.string().regex(/^SC-\d{3}$/),
    actor: z.string().min(1),
    precondition: optStr(),
    steps: z.array(z.string().min(1)).min(1),
    expected: z.string().min(1),
    _source: SourceSchema,
  })).min(1),
  secondary: optArr(z.object({
    id: z.string().regex(/^SC-\d{3}$/),
    actor: z.string().min(1),
    steps: z.array(z.string().min(1)).min(1),
    expected: z.string().min(1),
    _source: SourceSchema,
  })),
});

// ── 第 3 层：做什么 & 怎么做 ───────────────────────────────
export const FeatureSchema = z.object({
  id: z.string().regex(/^F-\d{3}$/),
  name: z.string().min(1),
  description: z.string().min(1),
  happy_path: z.array(z.string().min(1)).min(1),
  alternate_flows: optArr(z.object({
    condition: z.string().min(1), steps: z.array(z.string().min(1)).min(1),
  })),
  states: optArr(z.object({
    name: z.string().min(1), from: z.array(z.string()).default([]),
    to: z.array(z.string()).default([]), trigger: optStr(),
  })),
  ui_behavior: optStr(),
  entity_refs: z.array(z.string()).default([]), // ← 一致性检查②的抓手：指向 data_structures.entities[].name
  rule_refs: z.array(z.string()).default([]), // 指向 BR-xxx
  _source: SourceSchema,
});

export const FieldSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1), // 语言无关的类型串：string / int / enum(...) / uuid / timestamp
  required: z.boolean().default(false),
  constraints: optStr(), // "0..1" / "<= 255" / "unique"
  ref: optStr(), // "Entity.field" 外键
  description: optStr(),
});
export const DataStructuresSchema = z.object({
  entities: z.array(z.object({
    name: z.string().min(1),
    description: optStr(),
    fields: z.array(FieldSchema).min(1),
    _source: SourceSchema,
  })).min(1),
  enums: optArr(z.object({
    name: z.string().min(1), values: z.array(z.string().min(1)).min(1),
  })),
  relationships: optArr(z.object({
    from: z.string().min(1), to: z.string().min(1),
    type: z.enum(["1-1", "1-n", "n-n"]), description: optStr(),
  })),
});

export const ApiRequirementsSchema = z.object({
  rest: optArr(z.object({
    id: z.string().regex(/^API-\d{3}$/),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().regex(/^\//, "path 必须以 / 开头"),
    auth: optStr(),
    params: optArr(z.object({
      name: z.string().min(1),
      in: z.enum(["path", "query", "header", "body"]),
      type: z.string().min(1), required: z.boolean().default(false),
    })),
    request: z.record(z.unknown()).nullish(),
    response: z.record(z.unknown()).nullish(),
    errors: optArr(z.object({
      code: z.union([z.string(), z.number()]), when: z.string().min(1),
    })),
    entity_refs: z.array(z.string()).default([]), // ← 一致性检查②
    _source: SourceSchema,
  })),
  events: optArr(z.object({
    name: z.string().min(1),
    payload: z.record(z.unknown()).nullish(),
    entity_refs: z.array(z.string()).default([]),
    _source: SourceSchema,
  })),
}).refine((v) => (v.rest?.length ?? 0) + (v.events?.length ?? 0) > 0,
  { message: "api_requirements 至少要有一条 rest 或 events，否则不应生成该 section" });

const EdgeCaseItemSchema = z.object({
  id: z.string().regex(/^EC-\d{3}$/),
  scenario: z.string().min(1),
  handling: z.string().min(1),
  refs: z.array(z.string()).min(1), // ← 一致性检查③：必须引用 BR-xxx / F-xxx
  _source: SourceSchema,
});
export const EdgeCasesSchema = z.object({
  boundary: optArr(EdgeCaseItemSchema),
  precondition_violations: optArr(EdgeCaseItemSchema),
  concurrency: optArr(EdgeCaseItemSchema),
}).refine((v) => (v.boundary?.length ?? 0) + (v.precondition_violations?.length ?? 0) + (v.concurrency?.length ?? 0) > 0);

// ── 第 4 层：非功能 & 验证 ─────────────────────────────────
const NfrItemSchema = z.object({
  requirement: z.string().min(1),
  metric: optStr(),
  _source: SourceSchema,
});
export const NonFunctionalSchema = z.object({
  performance: optArr(NfrItemSchema),
  security: optArr(NfrItemSchema),
  compliance_privacy: optArr(NfrItemSchema),
  reliability_availability: optArr(NfrItemSchema),
  scalability: optArr(NfrItemSchema),
  internationalization: optArr(NfrItemSchema),
  accessibility: optArr(NfrItemSchema),
});

export const AcceptanceCriterionSchema = z.object({
  id: z.string().regex(/^AC-\d{3}$/),
  given: z.string().min(1),
  when: z.string().min(1),
  then: z.string().min(1),
  maps_to: z.array(z.string()).min(1), // ← 一致性检查①：BR-xxx / F-xxx，至少一个
  category: optEnum(["functional", "boundary", "performance", "security", "reliability"]),
  _source: SourceSchema,
});

// ── 第 5 层：依赖 / 外部集成 / 测试 / 指标 / 术语 / 待确认 ──
export const DependencyItemSchema = z.object({
  id: z.string().regex(/^DEP-\d{3}$/),
  name: z.string().min(1),
  type: z.enum(["internal", "external", "blocking"]),
  description: optStr(),
  _source: SourceSchema,
});
export const DependenciesSchema = z.object({
  items: z.array(DependencyItemSchema).min(1),
  blocking: z.array(z.string()).optional(), // 指向 items[].id
  _source: SourceSchema,
});

export const IntegrationSystemSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1), // 如 "支付网关" / "短信服务" / "开放平台"
  purpose: optStr(),
  auth: optStr(),
  endpoints: optArr(z.string().min(1)),
  _source: SourceSchema,
});
export const IntegrationExternalSchema = z.object({
  systems: z.array(IntegrationSystemSchema).min(1),
  _source: SourceSchema,
});

export const TestCaseSchema = z.object({
  id: z.string().regex(/^TC-\d{3}$/),
  title: z.string().min(1),
  precondition: optStr(),
  steps: z.array(z.string().min(1)).min(1),
  expected: z.string().min(1),
  maps_to: z.array(z.string()).min(1), // BR-xxx / F-xxx / AC-xxx
  // 【放宽】兼容 AI 常见的额外类型（smoke / usability / regression / compatibility / accessibility）
  type: z.enum([
    "functional", "boundary", "performance", "security", "integration",
    "smoke", "usability", "regression", "compatibility", "accessibility",
  ]).optional(),
  _source: SourceSchema,
});

export const MetricsAnalyticsSchema = z.object({
  events: z.array(z.object({
    name: z.string().min(1),
    description: optStr(),
    platform: optEnum(["web", "app", "all"]),
  })).min(1),
  dashboards: optArr(z.string().min(1)),
  _source: SourceSchema,
});

export const GlossaryItemSchema = z.object({
  term: z.string().min(1),
  definition: z.string().min(1),
});
export const OpenQuestionSchema = z.object({
  id: z.string().regex(/^Q-\d{3}$/).optional(),
  question: z.string().min(1),
  context: optStr(),
  owner: optStr(),
});

// ── 元段：references（不计分）─────────────────────────────
export const ReferencesSchema = z.object({
  prototype_id: z.string().nullable().default(null),
  prototype_version: z.number().int().nullable().default(null),
  prd_version: z.number().int().nullable().default(null),
  research_version: z.number().int().nullable().default(null),
  solution_version: z.number().int().nullable().default(null),
  // 固定提示语，明确告知消费方「视觉稿是 HTML，不在本 JSON 内」（§7）
  note: z.string().default("视觉与交互细节见 HTML 原型，请调用 MCP 工具 requirement_prototype（includeHtml=true）获取，本 JSON 不内嵌原型内容。"),
});

/** 模型必须输出的部分：只有内容 section，且顶层 strict（不许发明 section / 不许写 meta）。 */
export const DevContextBodySchema = z.object({
  objective: ObjectiveSchema.optional(),
  scope: ScopeSchema.optional(),
  dependencies: DependenciesSchema.optional(),
  business_rules: z.array(BusinessRuleSchema).min(1).optional(),
  user_scenarios: UserScenariosSchema.optional(),
  feature_logic: z.array(FeatureSchema).min(1).optional(),
  data_structures: DataStructuresSchema.optional(),
  api_requirements: ApiRequirementsSchema.optional(),
  integration_external: IntegrationExternalSchema.optional(),
  edge_cases: EdgeCasesSchema.optional(),
  non_functional_requirements: NonFunctionalSchema.optional(),
  acceptance_criteria: z.array(AcceptanceCriterionSchema).min(1).optional(),
  test_cases: z.array(TestCaseSchema).min(1).optional(),
  metrics_analytics: MetricsAnalyticsSchema.optional(),
  glossary: z.array(GlossaryItemSchema).min(1).optional(),
  open_questions: z.array(OpenQuestionSchema).min(1).optional(),
}).strict();

export const MetaSchema = z.object({
  requirement_id: z.string().min(1),
  title: z.string().min(1),
  version: z.number().int().positive(),
  status: z.enum(["draft", "confirmed"]),
  generated_at: z.string().min(1),
  generated_by: z.string().default("devcontext-agent@v1"),
  completeness_score: z.number().min(0).max(1),
  applicable_sections: z.array(z.enum(SECTION_KEYS)), // 评分分母，显式落库以便复算与 UI 展示
  present_sections: z.array(z.enum(SECTION_KEYS)),
  consistency_issues: z.array(z.object({
    rule: z.enum(["rule_ac_closure", "feature_data_closure", "edge_feature_closure", "source_validity", "prd_correspondence"]),
    level: z.enum(["error", "warn"]),
    message: z.string(),
    item_id: z.string().optional(),
  })).default([]),
  source_links: z.object({
    card: z.object({ id: z.string(), version: z.number().nullable() }).optional(),
    research_analysis: z.object({ id: z.string(), version: z.number().nullable() }).optional(),
    solution: z.object({ id: z.string(), version: z.number().nullable() }).optional(),
    prototype: z.object({ id: z.string(), version: z.number().nullable() }).optional(),
    prd: z.object({ id: z.string(), version: z.number().nullable() }).optional(),
  }).default({}),
  changelog: z.array(z.object({
    version: z.number().int(), updated_at: z.string(),
    trigger: z.enum(["prd_writing", "manual", "change_analysis"]),
    note: z.string().optional(),
  })).default([]),
});

/** 落库 / MCP 返回的完整形态。 */
export const DevContextSchema = DevContextBodySchema.extend({
  $schema: z.literal("https://askbuddy.dev/schemas/dev-context/v1.json").default("https://askbuddy.dev/schemas/dev-context/v1.json"),
  schema_version: z.literal("1.0").default("1.0"),
  meta: MetaSchema,
  references: ReferencesSchema,
});
export type DevContextBody = z.infer<typeof DevContextBodySchema>;
export type DevContext = z.infer<typeof DevContextSchema>;
export type DevContextMeta = z.infer<typeof MetaSchema>;