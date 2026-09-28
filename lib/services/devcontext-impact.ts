// DevContext 变更影响映射（M5-D2 · 本阶段技术核心）。
//
// 【为什么是纯函数】不访问 db、输入输出全为普通对象 → 可 100% 单测覆盖，
// 且「漏重算」这个头号风险（R-M5-1）能靠毫秒级的契约测试拦在 CI 里。
//
// 【两层拆分，别合并】
//   DIRECT_IMPACT：外部什么变了 → 直接命中哪些 section（只写【直接】影响）
//   SECTION_CLOSURE：DevContext 内部谁依赖谁 → 派生影响靠闭包展开
// 若把派生影响也手写进 DIRECT_IMPACT，15×17 个格子必然漂移；
// 拆开后两张表各自都短到可以一眼看完。
//
// ⚠️ 维护纪律（违反 = 漏重算，静默产出错误的机器规格）：
//   1. 新增 ImpactTrigger 必须同批在 DIRECT_IMPACT 加一行，否则
//      tests/contract/impact-map.spec.ts 的「Trigger 全覆盖」立刻报红；
//   2. 新增 DevContext section 必须复查全表，判断哪些 trigger 会影响它；
//   3. 空集合必须显式写 [] 并注明理由，禁止省略整行。
//
// 设计依据：AskBuddy《Development-Context设计方案》§3.4 与 §6（一致性校验规则）。

import { SECTION_KEYS, SECTION_LABELS, type SectionKey } from "@/lib/schemas/devcontext";

/** 参与重算的全部 section：16 个内容段 + 2 个元段。 */
export type DevContextSection = SectionKey | "meta" | "references";

/**
 * 规范顺序（所有输出按此排序，保证结果确定、可直接深等断言）。
 *
 * 注：schemas 里的声明顺序是 `<16 段> → meta → references`，但两者的
 * golden 样本（主计划 M5-4.4）都是 `meta` 打头、`references` 收尾——
 * 元信息本就是消费方（人 / Coding Agent）第一眼要看的，故此处把 meta 提到最前。
 * 中间 16 段严格保持 schema 声明顺序，不另立一套顺序。
 */
export const ALL_SECTIONS: readonly DevContextSection[] = [
  "meta",
  ...SECTION_KEYS,
  "references",
] as const;

const SECTION_INDEX = new Map<DevContextSection, number>(
  ALL_SECTIONS.map((s, i) => [s, i])
);

/** section 名是否合法（用于 fail-safe 与契约测试）。 */
export function isDevContextSection(v: unknown): v is DevContextSection {
  return typeof v === "string" && SECTION_INDEX.has(v as DevContextSection);
}

// ──────────────────────────────────────────────────────────── Trigger 枚举

/**
 * 影响源封闭集合（**14** 项）。这是「覆盖性契约」的一端：
 * 另一端是 DIRECT_IMPACT 的键集合，两者必须恒等（契约测试守护）。
 *
 * 注：主计划 M5-2.1 写的是「上述 15 项」，但它自己列出的 union 与 DIRECT_IMPACT
 * 都只有 14 行（6 卡片 + 3 调研 + 1 方案 + 1 原型 + 1 PRD + 2 决策/知识）——
 * 是原文的算术笔误。此处以**实际枚举**为准，并在契约测试里把 14 这个数字钉死
 * （增删 trigger 必须是有意识的改动，而不是顺手加一行）。
 */
export type ImpactTrigger =
  // 卡片字段级：来自 applyCardChange 的确定性 diff（最可靠的来源，无 LLM 判断）
  | "card.background"
  | "card.targetUsers"
  | "card.painPoints"
  | "card.scope"
  | "card.nonFunctional"
  | "card.constraints"
  // 产物级：来自 change-analyzer 的 affectedOutputs（经 outputsToTriggers 确定性推导）
  | "research.report"
  | "research.user_stories"
  | "research.features"
  | "solution.doc"
  | "prototype.structure"
  | "prd.markdown"
  // 决策 / 知识：M3 / M4 已落地的联动源
  | "decision.accepted"
  | "knowledge.changed";

export const ALL_TRIGGERS: readonly ImpactTrigger[] = [
  "card.background",
  "card.targetUsers",
  "card.painPoints",
  "card.scope",
  "card.nonFunctional",
  "card.constraints",
  "research.report",
  "research.user_stories",
  "research.features",
  "solution.doc",
  "prototype.structure",
  "prd.markdown",
  "decision.accepted",
  "knowledge.changed",
] as const;

const TRIGGER_SET = new Set<string>(ALL_TRIGGERS);

/** 卡片字段白名单 → 对应 trigger（`card.<field>`，字段名与 CARD_FIELDS 同名）。 */
export function cardFieldTrigger(field: string): ImpactTrigger {
  return `card.${field}` as ImpactTrigger;
}

// ──────────────────────────────────────────────── 直接影响映射表（15 行）

/**
 * 确定性影响映射表：trigger → **直接**受影响的 section。
 *
 * 只写直接命中；派生影响交给 SECTION_CLOSURE，不要手工展开（否则两处规则漂移）。
 */
export const DIRECT_IMPACT: Record<ImpactTrigger, DevContextSection[]> = {
  "card.background": ["objective", "scope"],
  "card.targetUsers": ["user_scenarios", "objective"],
  "card.painPoints": ["objective", "user_scenarios"],
  "card.scope": ["scope", "objective", "feature_logic"],
  "card.nonFunctional": ["non_functional_requirements"],
  "card.constraints": ["business_rules", "edge_cases", "dependencies"],

  "research.report": [
    "objective",
    "non_functional_requirements",
    "integration_external",
    "glossary",
  ],
  "research.user_stories": ["user_scenarios"],
  "research.features": ["feature_logic", "data_structures"],

  "solution.doc": [
    "feature_logic",
    "data_structures",
    "api_requirements",
    "integration_external",
    "non_functional_requirements",
  ],

  "prototype.structure": ["feature_logic", "user_scenarios", "edge_cases", "references"],

  // ⚠️ 显式空集：PRD 与 DevContext 同源并列，PRD 不是 DevContext 的上游（AD-2）。
  //    改 PRD 绝不能反向污染 DevContext，否则就是引入链式污染。
  //    tests/contract/impact-map.spec.ts 有专项断言守护这一行。
  "prd.markdown": [],

  // ⚠️ 显式空集：本 trigger 由 suggestion.target_path 精确定位（见 resolveAffectedSections
  //    的「决策特例」），不在这里展开成固定 section。
  //    另注：M3 建议卡已回退，当前 targetPath 无生产者——保留枚举位以待 M6 恢复。
  "decision.accepted": [],

  "knowledge.changed": ["business_rules", "edge_cases", "glossary"],
};

// ──────────────────────────────────────── Section 传递闭包（一致性镜像）

/**
 * section → 派生依赖的 section。与三层 Validator 的一致性规则一一对应：
 *   规则↔验收闭环（business_rules → acceptance_criteria）
 *   功能↔数据闭环（feature_logic → data_structures）
 *   边界↔功能闭环（edge_cases / acceptance_criteria → test_cases）
 *
 * 「一致性校验会失败」正是「必须一起重算」的充要条件——同源就不会出现
 * 「重算完却过不了校验」的死循环。
 */
export const SECTION_CLOSURE: Partial<Record<DevContextSection, DevContextSection[]>> = {
  business_rules: ["acceptance_criteria", "edge_cases"],
  feature_logic: ["acceptance_criteria", "data_structures"],
  data_structures: ["api_requirements"],
  edge_cases: ["test_cases"],
  acceptance_criteria: ["test_cases"],
  objective: ["metrics_analytics"], // 成功度量 → 埋点
};

/** 总是重算，且**不消耗 LLM**（纯代码拼装/计算：版本号、时间戳、产物 id、完整度评分）。 */
export const ALWAYS_RECOMPUTE: DevContextSection[] = ["meta", "references"];

// ──────────────────────────────────────────────────────────── 主函数

/** `decision.accepted` 的特例形态：带 targetPath，由目标路径首段定位 section。 */
export interface DecisionTrigger {
  trigger: "decision.accepted";
  /** M3 `suggestions.target_path`，形如 `business_rules[2].formal.then`。 */
  targetPath: string;
}

export type ImpactSource = ImpactTrigger | DecisionTrigger;

export interface ImpactResult {
  /** 最终需重算的 section（已闭包、已去重、已按 ALL_SECTIONS 顺序排序）。 */
  sections: DevContextSection[];
  /** 闭包展开前的直接命中（供 UI 显示「因何过期」）。 */
  direct: DevContextSection[];
  /** 每个 section 是被哪些 trigger 命中的（stale_reason 的事实源）。 */
  reason: Partial<Record<DevContextSection, ImpactTrigger[]>>;
  /** 未能识别的影响源（字符串原样保留，用于日志与 fail-safe 判定）。 */
  unmapped: string[];
  /** true = 已降级为「当前实际存在的全部 section」重算。 */
  fullRecompute: boolean;
}

export interface ResolveOptions {
  /**
   * 该 DevContext **当前实际存在**的 section（fail-safe 全量重算的边界）。
   *
   * 为什么不是 16 段全集：空 section 本就不生成（schema 里是 optional），
   * 重算一个不存在的 section 只会让模型凭空造内容。
   * 调用方拿不到现值时可省略，此时保守取 ALL_SECTIONS。
   */
  existing?: DevContextSection[];
}

/**
 * 由影响源解析出「需要重算哪些 section」。4 步，全同步、无 IO。
 *
 * 1. 直接命中：查 DIRECT_IMPACT，累积 direct 与 reason；
 * 2. 决策特例：解析 targetPath 首段为 section 名，解析不出计入 unmapped；
 * 3. 闭包展开：对 direct 反复应用 SECTION_CLOSURE 直到不动点（最多 |sections| 次，天然防环）；
 * 4. fail-safe：有 unmapped → 全量重算（宁可多算不可漏算：漏重算会静默产出错误的
 *    机器规格去毒害 AI Coding，多算只是多花 token）。
 * 最后并入 ALWAYS_RECOMPUTE 并按规范顺序排序。
 */
export function resolveAffectedSections(
  sources: ImpactSource[],
  opts: ResolveOptions = {}
): ImpactResult {
  const direct = new Set<DevContextSection>();
  const reason: Partial<Record<DevContextSection, ImpactTrigger[]>> = {};
  const unmapped: string[] = [];

  for (const src of sources) {
    // ---- 决策特例（对象形态，不查表） ----
    if (typeof src !== "string") {
      const seg = String(src.targetPath ?? "").match(/^([a-z_]+)/)?.[1];
      if (seg && isDevContextSection(seg) && seg !== "meta" && seg !== "references") {
        direct.add(seg);
        reason[seg] = unique([
          ...(reason[seg] ?? []),
          "decision.accepted" as ImpactTrigger,
        ]);
      } else {
        unmapped.push(src.targetPath ?? "(empty targetPath)");
      }
      continue;
    }

    // ---- 已知 trigger ----
    if (!TRIGGER_SET.has(src)) {
      unmapped.push(src);
      continue;
    }
    for (const sec of DIRECT_IMPACT[src as ImpactTrigger] ?? []) {
      direct.add(sec);
      reason[sec] = unique([...(reason[sec] ?? []), src as ImpactTrigger]);
    }
  }

  // ---- 闭包展开到不动点 ----
  const closure = new Set<DevContextSection>(direct);
  let frontier = [...direct];
  // 最多迭代 |ALL_SECTIONS| 次：有向图节点数即上界，天然防环
  for (let i = 0; i < ALL_SECTIONS.length && frontier.length > 0; i++) {
    const next: DevContextSection[] = [];
    for (const sec of frontier) {
      for (const out of SECTION_CLOSURE[sec] ?? []) {
        if (!closure.has(out)) {
          closure.add(out);
          next.push(out);
        }
      }
    }
    frontier = next;
  }

  // ---- fail-safe ----
  const fullRecompute = unmapped.length > 0;
  if (fullRecompute) {
    console.warn(
      `[impact] unmapped trigger：${unmapped.join("、")} → 降级为全量重算` +
        `（宁可多算不可漏算）`
    );
  }
  const scope = fullRecompute ? opts.existing ?? ALL_SECTIONS : [...closure];

  // ---- 并入元段 + 规范化顺序 ----
  const finalSet = new Set<DevContextSection>([
    ...scope,
    ...(fullRecompute ? [] : ALWAYS_RECOMPUTE),
  ]);
  if (fullRecompute) {
    // 全量重算同样必须保证两个元段在列（它们是纯代码重算，不花 token）
    for (const s of ALWAYS_RECOMPUTE) finalSet.add(s);
  }

  return {
    sections: sortSections(finalSet),
    direct: sortSections(direct),
    reason,
    unmapped,
    fullRecompute,
  };
}

/**
 * 从一份 DevContext content 里取出「实际存在」的 section 清单（纯函数）。
 *
 * 用途：fail-safe 全量重算时划定边界——空 section 本就不生成（schema 里是 optional），
 * 把不存在的段丢给模型只会让它凭空造内容。也顺带供 UI 对照展示。
 */
export function presentSections(
  content: Record<string, unknown> | null | undefined
): DevContextSection[] {
  if (!content || typeof content !== "object") return [];
  return sortSections(
    ALL_SECTIONS.filter((s) => {
      const v = (content as Record<string, unknown>)[s];
      return v !== undefined && v !== null;
    })
  );
}

// ─────────────────────────── MCP / UI 的「过期」元信息 ───────────────────────────

export interface DevContextStaleMeta {
  version: number;
  status: string;
  completeness_score: number;
  maybe_stale: boolean;
  stale_sections: DevContextSection[];
  /** 自然语言警告。空字符串 = 无过期段。 */
  warning: string;
}

/**
 * 组装「是否过期」的元信息（纯函数，供 MCP 与 Web 共用，保证两边话术一致）。
 *
 * 两处刻意的设计：
 *   1. `maybe_stale` 同时看列值与 `stale_sections`——出现过「标记列被清、section
 *      清单还在」的中间态，只看一列会漏报（漏报的后果见下）；
 *   2. warning 用**自然语言**而非布尔字段：MCP 的消费方是 AI Coding Agent，
 *      它对散文警告的遵从度显著高于对一个 `true` 的解读。它拿到一份「业务规则已过期」
 *      的规格却毫不知情，会自信地写出错误代码——这是整条链路上后果最严重的失败模式。
 */
export function buildStaleMeta(rec: {
  current_version: number;
  status: string;
  completeness_score: number;
  maybe_stale?: number;
  stale_sections?: DevContextSection[];
}): DevContextStaleMeta {
  const staleSections = Array.isArray(rec.stale_sections) ? rec.stale_sections : [];
  const isStale = rec.maybe_stale === 1 || staleSections.length > 0;
  const labels = staleSections
    .map((s) => `${s}（${SECTION_LABELS[s as SectionKey] ?? s}）`)
    .join("、");
  return {
    version: rec.current_version,
    status: rec.status,
    completeness_score: rec.completeness_score,
    maybe_stale: isStale,
    stale_sections: staleSections,
    warning: isStale
      ? `⚠️ 以下段落的上游产物已变更但尚未重算，据此编码前请先与产品确认：${labels}。` +
        `可用 POST /api/requirements/{id}/dev-context/refresh 触发定向重算。`
      : "",
  };
}

/** 按规范顺序排序并去重。 */
export function sortSections(iter: Iterable<DevContextSection>): DevContextSection[] {
  return [...new Set(iter)].sort(
    (a, b) => (SECTION_INDEX.get(a) ?? 0) - (SECTION_INDEX.get(b) ?? 0)
  );
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
