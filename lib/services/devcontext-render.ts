// DevContext 渲染器：JSON → Markdown / .cursorrules / CLAUDE.md / 结构化 Prompt。
// 硬约束：
//   1. 单向渲染。渲染产物一律不落库、不反写 JSON（依据《DevContext结构设计》§5 末段与
//      AskBuddy 设计方案 §4.2「绝不允许编辑 Markdown 反向写回 JSON」）。
//   2. 本文件零 db 依赖：只 import type from "@/lib/schemas/devcontext"。
//      output-viewer.tsx 是 "use client" 组件，会直接 import 本模块（先例：
//      lib/render/research-analysis.ts 被 output-viewer.tsx 客户端 import）。
//      一旦引入 @/lib/db，@cloudbase/node-sdk 会被打进客户端包。

import {
  SECTION_KEYS,
  SECTION_LABELS,
  type DevContext,
  type DevContextBody,
  type SectionKey,
} from "@/lib/schemas/devcontext";

// ───────────────────────────────────────────────────────────
// 共享内部工具
// ───────────────────────────────────────────────────────────

/** 返回实际生成的 section 有序列表（按 SECTION_KEYS 顺序，跳过未生成的）。 */
export function sectionOrder(ctx: DevContextBody): SectionKey[] {
  return SECTION_KEYS.filter((k) => {
    const v = (ctx as Record<string, unknown>)[k];
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return false;
  });
}

/** 中文标签。 */
export function labelOf(key: SectionKey): string {
  return SECTION_LABELS[key];
}

function fmtRule(br: { id: string; statement: string; formal: { when: string; then: string }; priority?: string | null }): string {
  const pri = br.priority ? ` [${br.priority}]` : "";
  return `- **${br.id}**${pri} ${br.statement}\n  - when: ${br.formal.when}\n  - then: ${br.formal.then}`;
}

function fmtAc(ac: { id: string; given: string; when: string; then: string; maps_to?: string[] }): string {
  const cover = ac.maps_to && ac.maps_to.length ? `（覆盖 ${ac.maps_to.join("、")}）` : "";
  return `- **${ac.id}** Given ${ac.given} / When ${ac.when} / Then ${ac.then}${cover}`;
}

function fmtEntity(e: { name: string; fields: Array<{ name: string; type: string }> }): string {
  return `${e.name}: ${e.fields.map((f) => `${f.name}(${f.type})`).join(", ")}`;
}

function esc(s: string): string {
  return s;
}

// ───────────────────────────────────────────────────────────
// renderMarkdown：人读 MD
// ───────────────────────────────────────────────────────────

export function renderMarkdown(ctx: DevContext): string {
  const meta = ctx.meta;
  const header = `> 需求 ｜ 版本 v${meta.version} ｜ 完整度 ${Math.round(meta.completeness_score * 100)}% ｜ 生成时间 ${meta.generated_at}\n`;

  const sections = sectionOrder(ctx);
  const blocks: string[] = [header.trim()];

  sections.forEach((key, idx) => {
    const title = `${idx + 1}. ${SECTION_LABELS[key]}`;
    const body = renderSectionMarkdown(key, ctx);
    blocks.push(`## ${title}\n\n${body}`.trimEnd());
  });

  if (sections.length === 0) {
    blocks.push("_（本次未生成任何内容 section）_");
  }
  return blocks.join("\n\n") + "\n";
}

function renderSectionMarkdown(key: SectionKey, ctx: DevContext): string {
  const v = (ctx as Record<string, unknown>)[key];
  switch (key) {
    case "objective": {
      const o = v as NonNullable<DevContext["objective"]>;
      const lines = [`**问题陈述**：${esc(o.problem_statement)}`, `**目标**：${esc(o.goal)}`];
      if (o.success_metrics?.length) {
        lines.push("**成功指标**：");
        for (const m of o.success_metrics) lines.push(`- ${m.metric} → 目标 ${m.target}${m.baseline ? `（基线 ${m.baseline}）` : ""}`);
      }
      if (o.non_goals?.length) lines.push(`**非目标**：${o.non_goals.join("、")}`);
      return lines.join("\n");
    }
    case "scope": {
      const s = v as NonNullable<DevContext["scope"]>;
      const lines = [`**范围内**：${s.in_scope.join("、")}`];
      if (s.out_of_scope?.length) lines.push(`**范围外**：${s.out_of_scope.join("、")}`);
      if (s.assumptions?.length) lines.push(`**假设**：${s.assumptions.join("、")}`);
      return lines.join("\n");
    }
    case "dependencies": {
      const d = v as NonNullable<DevContext["dependencies"]>;
      return d.items.map((i) => `- **${i.id}** [${i.type}] ${esc(i.name)}${i.description ? `：${esc(i.description)}` : ""}`).join("\n");
    }
    case "business_rules":
      return (v as NonNullable<DevContext["business_rules"]>).map(fmtRule).join("\n");
    case "user_scenarios": {
      const u = v as NonNullable<DevContext["user_scenarios"]>;
      const lines: string[] = [];
      if (u.personas?.length) lines.push("**角色**：" + u.personas.map((p) => `${p.name}${p.description ? `（${p.description}）` : ""}`).join("、"));
      lines.push("**主场景**：");
      for (const sc of u.primary) {
        lines.push(`- **${sc.id}** ${sc.actor}${sc.precondition ? `（前置：${sc.precondition}）` : ""}`);
        for (const st of sc.steps) lines.push(`  - ${st}`);
        lines.push(`  - 预期：${sc.expected}`);
      }
      if (u.secondary?.length) {
        lines.push("**次场景**：");
        for (const sc of u.secondary) {
          lines.push(`- **${sc.id}** ${sc.actor}`);
          for (const st of sc.steps) lines.push(`  - ${st}`);
          lines.push(`  - 预期：${sc.expected}`);
        }
      }
      return lines.join("\n");
    }
    case "feature_logic":
      return (v as NonNullable<DevContext["feature_logic"]>).map((f) => {
        const lines = [`- **${f.id}** ${esc(f.name)}：${esc(f.description)}`];
        lines.push(`  - 主流程：${f.happy_path.join(" → ")}`);
        if (f.alternate_flows?.length) for (const af of f.alternate_flows) lines.push(`  - 分支（${af.condition}）：${af.steps.join(" → ")}`);
        if (f.ui_behavior) lines.push(`  - 交互：${f.ui_behavior}`);
        if (f.rule_refs?.length) lines.push(`  - 关联规则：${f.rule_refs.join("、")}`);
        if (f.entity_refs?.length) lines.push(`  - 关联实体：${f.entity_refs.join("、")}`);
        return lines.join("\n");
      }).join("\n");
    case "data_structures": {
      const ds = v as NonNullable<DevContext["data_structures"]>;
      const lines = ds.entities.map((e) => {
        const fl = e.fields.map((f) => `  - ${f.name}: ${f.type}${f.required ? " (必填)" : ""}${f.description ? ` — ${f.description}` : ""}`).join("\n");
        return `**${e.name}**${e.description ? `（${e.description}）` : ""}\n${fl}`;
      });
      if (ds.enums?.length) for (const en of ds.enums) lines.push(`**枚举 ${en.name}**：${en.values.join(" / ")}`);
      if (ds.relationships?.length) for (const r of ds.relationships) lines.push(`关系：${r.from} --${r.type}--> ${r.to}${r.description ? `（${r.description}）` : ""}`);
      return lines.join("\n");
    }
    case "api_requirements": {
      const a = v as NonNullable<DevContext["api_requirements"]>;
      const lines: string[] = [];
      for (const r of a.rest ?? []) {
        lines.push(`- **${r.id}** \`${r.method} ${r.path}\`${r.auth ? ` (auth: ${r.auth})` : ""}`);
        if (r.params?.length) lines.push(`  - 参数：${r.params.map((p) => `${p.name}:${p.type}${p.required ? "*" : ""}`).join(", ")}`);
        if (r.errors?.length) lines.push(`  - 错误：${r.errors.map((e) => `${e.code}（${e.when}）`).join(", ")}`);
      }
      for (const ev of a.events ?? []) lines.push(`- **事件** ${esc(ev.name)}`);
      return lines.join("\n");
    }
    case "integration_external": {
      const i = v as NonNullable<DevContext["integration_external"]>;
      return i.systems.map((s) => `- **${esc(s.name)}** [${s.type}]${s.purpose ? `：${esc(s.purpose)}` : ""}${s.endpoints?.length ? `（${s.endpoints.join(", ")}）` : ""}`).join("\n");
    }
    case "edge_cases": {
      const ec = v as NonNullable<DevContext["edge_cases"]>;
      const items = [...(ec.boundary ?? []), ...(ec.precondition_violations ?? []), ...(ec.concurrency ?? [])];
      return items.map((e) => `- **${e.id}** ${esc(e.scenario)} → 处理：${esc(e.handling)}（引用 ${e.refs.join("、")}）`).join("\n");
    }
    case "non_functional_requirements": {
      const n = v as NonNullable<DevContext["non_functional_requirements"]>;
      const lines: string[] = [];
      const groups: Array<[string, typeof n.performance]> = [
        ["性能", n.performance], ["安全", n.security], ["合规与隐私", n.compliance_privacy],
        ["可靠性与可用性", n.reliability_availability], ["可伸缩性", n.scalability],
        ["国际化", n.internationalization], ["无障碍", n.accessibility],
      ];
      for (const [label, items] of groups) {
        if (items?.length) lines.push(`**${label}**：` + items.map((i) => `- ${esc(i.requirement)}${i.metric ? `（${i.metric}）` : ""}`).join("\n"));
      }
      return lines.join("\n");
    }
    case "acceptance_criteria":
      return (v as NonNullable<DevContext["acceptance_criteria"]>).map(fmtAc).join("\n");
    case "test_cases":
      return (v as NonNullable<DevContext["test_cases"]>).map((t) => `- **${t.id}** ${esc(t.title)}${t.precondition ? `（前置：${t.precondition}）` : ""}\n  - 步骤：${t.steps.join(" → ")}\n  - 预期：${t.expected}（关联 ${t.maps_to.join("、")}）`).join("\n");
    case "metrics_analytics": {
      const m = v as NonNullable<DevContext["metrics_analytics"]>;
      const lines = m.events.map((e) => `- ${esc(e.name)}${e.description ? `：${esc(e.description)}` : ""}${e.platform ? `（${e.platform}）` : ""}`);
      if (m.dashboards?.length) lines.push(`**看板**：${m.dashboards.join("、")}`);
      return lines.join("\n");
    }
    case "glossary":
      return (v as NonNullable<DevContext["glossary"]>).map((g) => `- **${esc(g.term)}**：${esc(g.definition)}`).join("\n");
    case "open_questions":
      return (v as NonNullable<DevContext["open_questions"]>).map((q) => `- ${esc(q.question)}${q.context ? `（${esc(q.context)}）` : ""}${q.owner ? ` — ${esc(q.owner)}` : ""}`).join("\n");
    default:
      return "";
  }
}

// ───────────────────────────────────────────────────────────
// renderCursorRules：.cursorrules（精简五块）
// ───────────────────────────────────────────────────────────

export function renderCursorRules(ctx: DevContext): string {
  const lines: string[] = ["# 开发上下文（AskBuddy 自动生成，供 AI 编码参考）", ""];

  if (ctx.business_rules?.length) {
    lines.push("## 业务规则", ...ctx.business_rules.map(fmtRule), "");
  }
  if (ctx.data_structures) {
    lines.push("## 数据模型", ...ctx.data_structures.entities.map(fmtEntity), "");
  }
  if (ctx.api_requirements) {
    const rest = (ctx.api_requirements.rest ?? []).map((r) => `- \`${r.method} ${r.path}\``);
    const events = (ctx.api_requirements.events ?? []).map((e) => `- 事件 ${e.name}`);
    if (rest.length || events.length) lines.push("## API 约定", ...rest, ...events, "");
  }
  if (ctx.acceptance_criteria?.length) {
    lines.push("## 验收标准（实现后自检）", ...ctx.acceptance_criteria.map(fmtAc), "");
  }
  const constraints: string[] = [];
  if (ctx.non_functional_requirements) {
    const n = ctx.non_functional_requirements;
    for (const arr of [n.performance, n.security, n.compliance_privacy, n.reliability_availability, n.scalability, n.internationalization, n.accessibility]) {
      if (arr?.length) constraints.push(...arr.map((i) => `- ${i.requirement}`));
    }
  }
  if (constraints.length) lines.push("## 约束", ...constraints, "");

  lines.push(
    "## 红线",
    "- 不要实现本文件未提及的功能",
    "- 视觉稿见原型 HTML，路径由 AskBuddy MCP `requirement_prototype` 提供",
    ""
  );
  return lines.join("\n");
}

// ───────────────────────────────────────────────────────────
// renderClaudeMd：CLAUDE.md（项目记忆叙述风格）
// ───────────────────────────────────────────────────────────

export function renderClaudeMd(ctx: DevContext): string {
  const meta = ctx.meta;
  const lines: string[] = [
    "<!-- 本文件由 AskBuddy 自动生成，请勿手动编辑；改动请回到 AskBuddy 对应需求中进行。 -->",
    "",
    "# 项目记忆：开发上下文",
    "",
    `> 需求 ｜ 版本 v${meta.version} ｜ 完整度 ${Math.round(meta.completeness_score * 100)}% ｜ 生成时间 ${meta.generated_at}`,
    "",
  ];

  if (ctx.objective) {
    lines.push("## 目标", `本需求要解决：${ctx.objective.problem_statement}`, `目标：${ctx.objective.goal}`);
    if (ctx.objective.success_metrics?.length) lines.push("成功指标：" + ctx.objective.success_metrics.map((m) => `${m.metric} → ${m.target}`).join("；"));
    lines.push("");
  }
  if (ctx.scope) {
    lines.push("## 范围", `范围内：${ctx.scope.in_scope.join("、")}`);
    if (ctx.scope.out_of_scope?.length) lines.push(`范围外：${ctx.scope.out_of_scope.join("、")}`);
    lines.push("");
  }
  if (ctx.business_rules?.length) {
    lines.push("## 业务规则", ...ctx.business_rules.map(fmtRule), "");
  }
  if (ctx.feature_logic?.length) {
    lines.push("## 功能", ...ctx.feature_logic.map((f) => `- **${f.id}** ${f.name}：${f.description}\n  - ${f.happy_path.join(" → ")}`), "");
  }
  if (ctx.data_structures) {
    lines.push("## 数据模型", ...ctx.data_structures.entities.map(fmtEntity), "");
  }
  if (ctx.api_requirements) {
    const rest = (ctx.api_requirements.rest ?? []).map((r) => `- \`${r.method} ${r.path}\``);
    if (rest.length) lines.push("## 接口", ...rest, "");
  }
  if (ctx.acceptance_criteria?.length) {
    lines.push("## 验收标准", ...ctx.acceptance_criteria.map(fmtAc), "");
  }
  if (ctx.glossary?.length) {
    lines.push("## 术语", ...ctx.glossary.map((g) => `- **${g.term}**：${g.definition}`), "");
  }
  if (ctx.open_questions?.length) {
    lines.push("## 待确认", ...ctx.open_questions.map((q) => `- ${q.question}${q.context ? `（${q.context}）` : ""}`), "");
  }
  lines.push(
    "## 红线",
    "- 不要实现本文件未提及的功能",
    "- 视觉稿见原型 HTML，路径由 AskBuddy MCP `requirement_prototype` 提供",
    ""
  );
  return lines.join("\n");
}

// ───────────────────────────────────────────────────────────
// renderPrompt：剪贴板 Prompt
// ───────────────────────────────────────────────────────────

export function stripSource(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSource);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "_source") continue;
      out[k] = stripSource(v);
    }
    return out;
  }
  return value;
}

export function renderPrompt(ctx: DevContext): string {
  const guide = "下面是为本需求生成的结构化开发上下文（DevContext）。请依据其中的业务规则、数据模型、接口规范与验收标准实现代码。\n\n";
  const json = JSON.stringify(ctx, null, 2);
  if (json.length > 60000) {
    const slim = stripSource(ctx) as DevContext;
    return (
      guide +
      "（已剔除各条目的 _source 溯源字段以控制长度）\n\n" +
      `<dev_context>\n${JSON.stringify(slim, null, 2)}\n</dev_context>`
    );
  }
  return guide + `<dev_context>\n${json}\n</dev_context>`;
}
