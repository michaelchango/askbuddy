// DevContext 校验层（M2-C 组）：完整度评分 + 上游信号探测 + 一致性检查 + 提示文案。
//
// 文件内分两类导出：
//   1. 纯函数（不触库）：completenessScore / buildHints —— 可被任何层 import。
//   2. 读库函数（服务端专用）：detectUpstreamSignals / checkConsistency —— UI 侧不应 import。
//
// 零运行时依赖约束只针对 devcontext-render.ts 与 schemas/devcontext.ts（被客户端打包），
// 本文件是服务端 service，按既有 outputs.ts / devcontext.ts 同例 import db 即可。

import { db } from "@/lib/db";
import {
  SECTION_KEYS,
  SECTION_APPLICABILITY,
  SECTION_LABELS,
  PRD_SECTION_MAP,
  type DevContextBody,
  type SectionKey,
} from "@/lib/schemas/devcontext";
import { getRequirement } from "@/lib/services/requirements";

// ───────────────────────────────────────────────────────────
// 类型
// ───────────────────────────────────────────────────────────

export interface UpstreamSignals {
  hasDataModel: boolean; // 上游是否出现实体/字段/表/schema 语义
  hasApi: boolean; // 是否出现接口/端点语义
  hasNfr: boolean; // 是否出现性能/安全/合规/可用性约束
  hasExternal: boolean; // 是否出现第三方/外部系统对接
  hasMetrics: boolean; // 是否出现埋点/指标/统计
  hasDependency: boolean; // 是否出现前置依赖/阻塞
  hasGlossary: boolean; // 是否出现术语/缩写定义
  hasOpenQuestion: boolean; // 是否出现待定/未决
  hasTestable: boolean; // 是否具备派生测试用例的基础
}

export interface CompletenessReport {
  score: number; // 0~1，保留 3 位
  applicable: SectionKey[]; // 分母来源
  present: SectionKey[];
  missing: SectionKey[]; // 适用但未生成 → UI 提示「缺 XXX」
  checks: Array<{ section: SectionKey; kind: string; pass: boolean; detail?: string }>;
}

export type ConsistencyRule =
  | "rule_ac_closure"
  | "feature_data_closure"
  | "edge_feature_closure"
  | "source_validity"
  | "prd_correspondence";

export interface ConsistencyIssue {
  rule: ConsistencyRule;
  level: "error" | "warn";
  message: string;
  item_id?: string;
}

export interface SourceResolvers {
  contextExists: (id: string) => Promise<boolean>;
  decisionExists?: (id: string) => Promise<boolean>; // M3 注入
  knowledgeExists?: (id: string) => Promise<boolean>; // M4 注入
  maxConversationTurn: () => Promise<number>;
}

// ───────────────────────────────────────────────────────────
// 第二层：completeness_score（分母 = 适用 section 数）
// ───────────────────────────────────────────────────────────

/** 某 section 对本需求是否「适用」：核心恒适用；条件型看上游信号（§9 的分母修正）。 */
function isApplicable(key: SectionKey, s: UpstreamSignals): boolean {
  if (SECTION_APPLICABILITY[key] === "core") return true;
  switch (key) {
    case "data_structures": return s.hasDataModel;
    case "api_requirements": return s.hasApi;
    case "non_functional_requirements": return s.hasNfr;
    case "integration_external": return s.hasExternal;
    case "metrics_analytics": return s.hasMetrics;
    case "dependencies": return s.hasDependency;
    case "glossary": return s.hasGlossary;
    case "open_questions": return s.hasOpenQuestion;
    case "test_cases": return s.hasTestable;
    default: return false;
  }
}

/** 一个 section 是否「有内容」：存在且非空的数组 / 对象。 */
function hasContent(body: DevContextBody, key: SectionKey): boolean {
  const v = (body as Record<string, unknown>)[key];
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return false;
}

/** 质量检查（沿用「可判定」思想，按 section 归位）。 */
const QUALITY_CHECKS: Partial<Record<SectionKey, Array<{ kind: string; run: (b: DevContextBody) => boolean }>>> = {
  objective: [
    { kind: "has_success_metrics", run: (b) => (b.objective?.success_metrics?.length ?? 0) > 0 },
  ],
  business_rules: [
    { kind: "all_decidable", run: (b) => (b.business_rules ?? []).every((r) => !!r.formal?.when && !!r.formal?.then) },
  ],
  acceptance_criteria: [
    { kind: "all_gwt_complete", run: (b) => (b.acceptance_criteria ?? []).every((a) => !!a.given && !!a.when && !!a.then) },
    { kind: "all_mapped", run: (b) => (b.acceptance_criteria ?? []).every((a) => (a.maps_to?.length ?? 0) > 0) },
  ],
  data_structures: [
    { kind: "entities_have_fields", run: (b) => (b.data_structures?.entities ?? []).every((e) => e.fields.length > 0) },
  ],
  feature_logic: [
    { kind: "all_have_happy_path", run: (b) => (b.feature_logic ?? []).every((f) => f.happy_path.length > 0) },
  ],
};

export function completenessScore(body: DevContextBody, signals: UpstreamSignals): CompletenessReport {
  const applicable = SECTION_KEYS.filter((k) => isApplicable(k, signals));
  const present: SectionKey[] = [];
  const checks: CompletenessReport["checks"] = [];

  for (const key of applicable) {
    const filled = hasContent(body, key);
    checks.push({ section: key, kind: "presence", pass: filled });
    if (!filled) continue;
    present.push(key);
    for (const q of QUALITY_CHECKS[key] ?? []) {
      checks.push({ section: key, kind: q.kind, pass: q.run(body) });
    }
  }

  const passed = checks.filter((c) => c.pass).length;
  const score = checks.length === 0 ? 0 : Math.round((passed / checks.length) * 1000) / 1000;
  return {
    score,
    applicable,
    present,
    missing: applicable.filter((k) => !present.includes(k)),
    checks,
  };
}

// ───────────────────────────────────────────────────────────
// 第二层（读库）：detectUpstreamSignals（确定性，不用 LLM）
// ───────────────────────────────────────────────────────────

const SIG_REGEX: Record<keyof UpstreamSignals, RegExp> = {
  hasDataModel: /实体|字段|数据表|数据模型|schema|表结构|ER\s*图|主键|外键/i,
  hasApi: /接口|API|端点|\bGET\b|\bPOST\b|\bPUT\b|\bDELETE\b|\/api\//i,
  hasNfr: /性能|并发|延迟|安全|权限|合规|隐私|可用性|SLA|无障碍|国际化/i,
  hasExternal: /第三方|外部系统|对接|集成|webhook|SDK|开放平台/i,
  hasMetrics: /埋点|指标|统计|数据上报|转化率|留存|漏斗/i,
  hasDependency: /依赖|前置|阻塞|需等待|上线顺序/i,
  hasGlossary: /术语|名词解释|缩写|定义如下/i,
  hasOpenQuestion: /待定|待确认|未决|TBD|存疑/i,
  hasTestable: /测试|用例|验收|边界|异常|场景/i,
};

/**
 * 探测上游是否出现各类语义信号，决定条件型 section 是否计入完整度分母。
 * 读 requirements.card / research_analysis / solutions / prototypes，拼成一段文本后跑正则。
 */
export async function detectUpstreamSignals(requirementId: string): Promise<UpstreamSignals> {
  const signals: UpstreamSignals = {
    hasDataModel: false, hasApi: false, hasNfr: false, hasExternal: false,
    hasMetrics: false, hasDependency: false, hasGlossary: false,
    hasOpenQuestion: false, hasTestable: false,
  };

  const req = await getRequirement(requirementId);
  const cardText = req?.card ? JSON.stringify(req.card) : "";
  const nonFunctional = (req?.card as Record<string, unknown> | undefined)?.nonFunctional;
  if (typeof nonFunctional === "string" && nonFunctional.trim().length > 0) signals.hasNfr = true;

  const ra = await db.get<{ report?: string; features?: unknown[] }>("research_analysis", requirementId).catch(() => null);
  const raText = [ra?.report ?? "", `features:${(ra?.features?.length ?? 0)}`].join(" ");

  const sol = await db.get<{ doc?: string }>("solutions", requirementId).catch(() => null);
  const solText = sol?.doc ?? "";

  const proto = await db.get<{ structure?: { pages?: unknown[] } }>("prototypes", requirementId).catch(() => null);
  const protoText = proto?.structure ? `prototype pages:${(proto.structure.pages?.length ?? 0)}` : "";

  const combined = [cardText, raText, solText, protoText].join("\n");

  (Object.keys(SIG_REGEX) as (keyof UpstreamSignals)[]).forEach((k) => {
    if (SIG_REGEX[k].test(combined)) signals[k] = true;
  });

  // hasTestable 的额外判定：上游有结构化产物（功能清单 / 方案）才具备派生测试的基础
  if ((ra?.features?.length ?? 0) > 0 || solText.trim().length > 0) signals.hasTestable = true;

  return signals;
}

// ───────────────────────────────────────────────────────────
// 第三层：一致性检查（§6 五条）
// ───────────────────────────────────────────────────────────

/** 收集 body 内所有 _source 条目（递归遍历数组/对象）。 */
function collectSources(body: DevContextBody): Array<{ source: Record<string, unknown>; ownerLabel: string }> {
  const out: Array<{ source: Record<string, unknown>; ownerLabel: string }> = [];
  const walk = (val: unknown, label: string) => {
    if (Array.isArray(val)) {
      val.forEach((item, i) => walk(item, `${label}[${i}]`));
    } else if (val && typeof val === "object") {
      const obj = val as Record<string, unknown>;
      if ("_source" in obj && obj._source && typeof obj._source === "object") {
        out.push({ source: obj._source as Record<string, unknown>, ownerLabel: label });
      }
      for (const [k, v] of Object.entries(obj)) {
        if (k === "_source") continue;
        walk(v, `${label}.${k}`);
      }
    }
  };
  walk(body, "root");
  return out;
}

export async function checkConsistency(
  body: DevContextBody,
  requirementId: string,
  resolvers?: SourceResolvers
): Promise<ConsistencyIssue[]> {
  const issues: ConsistencyIssue[] = [];

  // ① 规则↔验收闭环
  const acRefs = new Set<string>();
  for (const ac of body.acceptance_criteria ?? []) {
    for (const ref of ac.maps_to ?? []) acRefs.add(ref);
  }
  for (const br of body.business_rules ?? []) {
    if (!acRefs.has(br.id)) {
      issues.push({
        rule: "rule_ac_closure",
        level: "error",
        message: `${br.id} 未被任何验收标准覆盖`,
        item_id: br.id,
      });
    }
  }
  for (const ref of acRefs) {
    const covered = (body.business_rules ?? []).some((b) => b.id === ref) ||
      (body.feature_logic ?? []).some((f) => f.id === ref);
    if (!covered) {
      issues.push({
        rule: "rule_ac_closure",
        level: "error",
        message: `验收标准引用了不存在的条目 ${ref}`,
        item_id: ref,
      });
    }
  }

  // ② 功能↔数据闭环（仅当 data_structures 已生成时执行）
  if (body.data_structures) {
    const entityNames = new Set(body.data_structures.entities.map((e) => e.name));
    const refSets: Array<{ refs: string[]; label: string; id?: string }> = [];
    for (const f of body.feature_logic ?? []) {
      if (f.entity_refs?.length) refSets.push({ refs: f.entity_refs, label: f.id });
    }
    for (const r of body.api_requirements?.rest ?? []) {
      if (r.entity_refs?.length) refSets.push({ refs: r.entity_refs, label: r.id });
    }
    for (const ev of body.api_requirements?.events ?? []) {
      if (ev.entity_refs?.length) refSets.push({ refs: ev.entity_refs, label: ev.name });
    }
    for (const { refs, label } of refSets) {
      for (const ref of refs) {
        if (!entityNames.has(ref)) {
          issues.push({
            rule: "feature_data_closure",
            level: "error",
            message: `${label} 引用了不存在的实体 ${ref}`,
            item_id: label,
          });
        }
      }
    }
    // FieldSchema.ref（"Entity.field"）的实体与字段都必须存在
    for (const e of body.data_structures.entities) {
      for (const f of e.fields) {
        if (f.ref) {
          const [ent] = f.ref.split(".");
          if (!entityNames.has(ent)) {
            issues.push({
              rule: "feature_data_closure",
              level: "error",
              message: `字段 ${e.name}.${f.name} 的外键 ${f.ref} 指向不存在的实体 ${ent}`,
              item_id: `${e.name}.${f.name}`,
            });
          }
        }
      }
    }
  }

  // ③ 边界↔功能闭环：每条 edge 的 refs 至少命中一个 BR-xxx 或 F-xxx
  const edgeItems = [
    ...(body.edge_cases?.boundary ?? []),
    ...(body.edge_cases?.precondition_violations ?? []),
    ...(body.edge_cases?.concurrency ?? []),
  ];
  for (const ec of edgeItems) {
    const ok = (ec.refs ?? []).some((r) => /^BR-\d{3}$/.test(r) || /^F-\d{3}$/.test(r));
    if (!ok) {
      issues.push({
        rule: "edge_feature_closure",
        level: "error",
        message: `${ec.id} 的 refs 未引用任何 BR-xxx / F-xxx`,
        item_id: ec.id,
      });
    }
  }

  // ④ 溯源有效性（M2 降级：可插拔 resolver）
  const ctxExists = resolvers?.contextExists ?? (async () => true);
  const maxTurn = resolvers?.maxConversationTurn ? await resolvers.maxConversationTurn() : 0;
  for (const { source } of collectSources(body)) {
    if (source.decision_id != null) {
      issues.push({ rule: "source_validity", level: "warn", message: "M2 阶段不应出现 decision_id（decisions 表尚未建立）" });
    }
    const knowledgeIds = Array.isArray(source.knowledge_ids) ? (source.knowledge_ids as unknown[]) : [];
    if (knowledgeIds.length > 0) {
      issues.push({ rule: "source_validity", level: "warn", message: "M2 阶段不应出现 knowledge_ids（knowledge_entries 表尚未建立）" });
    }
    const turn = source.conversation_turn as number | null;
    if (turn != null) {
      if (maxTurn === 0 || turn < 1 || turn > maxTurn) {
        issues.push({ rule: "source_validity", level: "warn", message: `conversation_turn ${turn} 超出真实轮次范围 [1, ${maxTurn}]` });
      }
    }
    const ctxIds = Array.isArray(source.context_ids) ? (source.context_ids as string[]) : [];
    for (const cid of ctxIds) {
      if (!(await ctxExists(cid))) {
        issues.push({ rule: "source_validity", level: "warn", message: `context_ids 引用了无法解析的条目 ${cid}` });
      }
    }
  }

  // ⑤ PRD 对应
  const prd = await db.get<{ markdown?: string }>("prds", requirementId).catch(() => null);
  if (prd?.markdown) {
    const titles: string[] = [];
    const re = /^##\s*(?:\d+[.、]\s*)?(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(prd.markdown)) !== null) titles.push(m[1].trim());

    const presentSections = SECTION_KEYS.filter((k) => hasContent(body, k));
    for (const section of presentSections) {
      const aliases = PRD_SECTION_MAP[section];
      if (!aliases) continue;
      const hit = aliases.some((a) => titles.some((t) => t.includes(a)));
      if (!hit) {
        issues.push({
          rule: "prd_correspondence",
          level: "warn",
          message: `DevContext 有 ${SECTION_LABELS[section]}，但 PRD 无「${aliases[0]}」章节`,
        });
      }
    }
    // 反向：PRD 有章节而 DevContext 无对应 section
    for (const t of titles) {
      const matchedSection = (Object.entries(PRD_SECTION_MAP) as Array<[SectionKey, string[]]>)
        .find(([, aliases]) => aliases.some((a) => t.includes(a)));
      if (matchedSection && !hasContent(body, matchedSection[0])) {
        issues.push({
          rule: "prd_correspondence",
          level: "warn",
          message: `PRD 有「${t}」章节，但 DevContext 未生成 ${SECTION_LABELS[matchedSection[0]]}`,
        });
      }
    }
  }

  return issues;
}

// ───────────────────────────────────────────────────────────
// 提示文案生成
// ───────────────────────────────────────────────────────────

/** 输出示例：["完整度 62%", "缺数据结构", "缺验收标准", "3 条规则无验收", "2 处实体引用悬空"] */
export function buildHints(rep: CompletenessReport, issues: ConsistencyIssue[]): string[] {
  const hints: string[] = [`完整度 ${Math.round(rep.score * 100)}%`];

  // 缺失 section（≤3）
  const missingLabels = rep.missing.map((k) => SECTION_LABELS[k]);
  if (missingLabels.length > 0) {
    const shown = missingLabels.slice(0, 3).join("、");
    hints.push(missingLabels.length > 3 ? `缺${shown}等 ${missingLabels.length} 项` : `缺${shown}`);
  }

  // 一致性 issue 按 rule 归并计数
  const countBy = (rule: ConsistencyRule) => issues.filter((i) => i.rule === rule).length;
  const ruleAc = countBy("rule_ac_closure");
  const ruleFd = countBy("feature_data_closure");
  const ruleEdge = countBy("edge_feature_closure");
  const rulePrd = countBy("prd_correspondence");
  if (ruleAc > 0) hints.push(`${ruleAc} 条规则无验收`);
  if (ruleFd > 0) hints.push(`${ruleFd} 处实体引用悬空`);
  if (ruleEdge > 0) hints.push(`${ruleEdge} 条边界未挂钩`);
  if (rulePrd > 0) hints.push(`PRD 缺 ${rulePrd} 个对应章节`);

  return hints;
}
