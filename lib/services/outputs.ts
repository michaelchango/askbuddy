// 输出物聚合服务 v2：4 组输出物（需求卡片 / 调研分析 / 方案设计 / 需求文档）。
// 方案设计为组类型，内含方案文档 + 原型两个子产物。
import { db } from "@/lib/db";
import { getRequirement } from "./requirements";
import { getPrototypeHtml, listVersions as listPrototypeVersions } from "./prototypes";
import { buildResearchAnalysisMarkdown } from "@/lib/render/research-analysis";
import type { RequirementCard } from "@/types";
import type { ResearchAnalysisOutput } from "@/lib/ai/types";

export type OutputType = "card" | "research_analysis" | "design" | "prd";
export type OutputContentType = "card" | "markdown" | "html";

export interface OutputVersion {
  version: number;
  note?: string;
  createdAt?: string;
}

export interface SubOutput {
  subType: string; // "solution" | "prototype"
  label: string;
  contentType: OutputContentType;
  exists: boolean;
  version: number | null;
}

export interface OutputMeta {
  type: OutputType;
  label: string;
  contentType: OutputContentType;
  exists: boolean;
  version: number | null;
  updatedAt?: string;
  subOutputs?: SubOutput[]; // 组类型下的子产物（仅 design 组使用）
}

export interface OutputContent {
  type: OutputType;
  label: string;
  contentType: OutputContentType;
  version: number | null;
  versions: OutputVersion[];
  content?: string;
  card?: Record<string, string>;
  subType?: string; // 子产物标识（design 组下 "solution" / "prototype"）
  subOutputs?: SubOutput[];
}

export const OUTPUT_DEFS: {
  type: OutputType;
  label: string;
  contentType: OutputContentType;
  subDefs?: { subType: string; label: string; contentType: OutputContentType }[];
}[] = [
  { type: "card", label: "需求卡片", contentType: "card" },
  { type: "research_analysis", label: "调研报告", contentType: "markdown" },
  {
    type: "design",
    label: "方案设计",
    contentType: "markdown",
    subDefs: [
      { subType: "solution", label: "方案文档", contentType: "markdown" },
      { subType: "prototype", label: "交互原型", contentType: "html" },
    ],
  },
  { type: "prd", label: "需求文档", contentType: "markdown" },
];

function labelOf(type: OutputType): string {
  return OUTPUT_DEFS.find((d) => d.type === type)?.label ?? type;
}

function contentTypeOf(type: OutputType): OutputContentType {
  return OUTPUT_DEFS.find((d) => d.type === type)?.contentType ?? "markdown";
}

function cardHasContent(card?: RequirementCard): boolean {
  if (!card) return false;
  return Object.values(card).some(
    (v) => typeof v === "string" && v.trim().length > 0 && !v.startsWith("（")
  );
}

// ---- 列出所有输出物元信息 ----

export async function listOutputs(requirementId: string): Promise<OutputMeta[]> {
  const req = await getRequirement(requirementId);
  const cardExists = cardHasContent(req?.card);
  const cardVersion = (req as unknown as Record<string, unknown>)?.current_version as number ?? 0;

  const [ra, solution, proto, prd] = await Promise.all([
    db.get<{ current_version?: number; updated_at?: string }>("research_analysis", requirementId, "requirement_id"),
    db.get<{ doc?: string; current_version?: number; updated_at?: string }>("solutions", requirementId, "requirement_id"),
    db.get<{ current_version: number; updated_at: string }>("prototypes", requirementId, "requirement_id"),
    db.get<{ current_version: number; updated_at: string }>("prds", requirementId, "requirement_id"),
  ]);

  return OUTPUT_DEFS.map((def) => {
    switch (def.type) {
      case "card":
        return {
          type: "card", label: def.label, contentType: def.contentType,
          exists: cardExists, version: cardExists && cardVersion > 0 ? cardVersion : (cardExists ? 1 : null),
          updatedAt: req?.updatedAt,
        };

      case "research_analysis": {
        const raVer = ra?.current_version ?? 0;
        return {
          type: "research_analysis", label: def.label, contentType: def.contentType,
          exists: !!ra, version: ra ? (raVer > 0 ? raVer : 1) : null,
          updatedAt: ra?.updated_at,
        };
      }

      case "design": {
        const solExists = !!solution?.doc;
        const solVer = solution?.current_version ?? 0;
        const protoExists = !!proto && (proto.current_version ?? 0) > 0;
        const maxVer = Math.max(
          solExists ? (solVer > 0 ? solVer : 1) : 0,
          proto?.current_version ?? 0
        );
        return {
          type: "design", label: def.label, contentType: def.contentType,
          exists: solExists || protoExists,
          version: (solExists || protoExists) ? maxVer : null,
          updatedAt: proto?.updated_at ?? solution?.updated_at,
          subOutputs: (def.subDefs ?? []).map((sd) => {
            if (sd.subType === "solution") {
              return {
                subType: "solution", label: sd.label, contentType: sd.contentType,
                exists: solExists, version: solExists ? (solVer > 0 ? solVer : 1) : null,
              };
            }
            return {
              subType: "prototype", label: sd.label, contentType: sd.contentType,
              exists: protoExists, version: protoExists ? proto!.current_version : null,
            };
          }),
        };
      }

      case "prd":
        return {
          type: "prd", label: def.label, contentType: def.contentType,
          exists: !!prd && (prd.current_version ?? 0) > 0,
          version: prd?.current_version ?? null,
          updatedAt: prd?.updated_at,
        };
    }
  });
}

// ---- 获取输出物内容 ----

export async function getOutput(
  requirementId: string,
  type: OutputType,
  version?: number,
  subType?: string
): Promise<OutputContent> {
  const def = OUTPUT_DEFS.find((d) => d.type === type);
  const base = {
    type,
    label: labelOf(type),
    contentType: contentTypeOf(type),
    version: null as number | null,
    versions: [] as OutputVersion[],
    subType,
  };

  // 需求卡片
  if (type === "card") {
    const req = await getRequirement(requirementId);
    const card = (req?.card ?? {}) as Record<string, string>;

    // 从 card_versions 读取版本列表
    let vs: OutputVersion[] = [];
    let targetCard = card;
    let targetVersion = null as number | null;
    try {
      // 下推：命中 idx_card_ver_req (requirement_id, version)
      const rows = await db.findMany<{
        version: number; card: unknown; note?: string; created_at: string;
      }>("card_versions", {
        where: { requirement_id: { eq: requirementId } },
        orderBy: [["version", "asc"]],
      });
      vs = rows.map((v) => ({
        version: v.version, note: v.note, createdAt: v.created_at,
      }));
      if (version != null && vs.length > 0) {
        const t = rows.find((r) => r.version === version);
        if (t) { targetCard = (t.card as Record<string, string>) ?? card; targetVersion = t.version; }
      } else {
        // 里程碑定版前（尚无版本记录）为草稿态：不伪造 v1，version 为 null 时前端不展示版本徽标
        targetVersion = vs.length > 0 ? vs[vs.length - 1].version : null;
      }
    } catch { /* 版本表查询失败降级 */ }

    return { ...base, version: targetVersion, versions: vs, card: targetCard };
  }

  // 调研分析
  if (type === "research_analysis") {
    // 从版本表读取版本列表
    let vs: OutputVersion[] = [];
    let targetReport: string | undefined;
    let targetStories: unknown[] = [];
    let targetFeatures: unknown[] = [];
    let targetVersion = null as number | null;

    try {
      // 下推：命中 idx_ra_ver_req (requirement_id, version)
      const rows = await db.findMany<{
        version: number; report?: string; user_stories?: unknown[]; features?: unknown[]; note?: string; created_at: string;
      }>("research_analysis_versions", {
        where: { requirement_id: { eq: requirementId } },
        orderBy: [["version", "asc"]],
      });
      vs = rows.map((v) => ({
        version: v.version, note: v.note, createdAt: v.created_at,
      }));

      if (version != null && vs.length > 0) {
        const t = rows.find((r) => r.version === version);
        if (t) {
          targetReport = t.report;
          targetStories = Array.isArray(t.user_stories) ? t.user_stories : [];
          targetFeatures = Array.isArray(t.features) ? t.features : [];
          targetVersion = t.version;
        }
      }

      // 未指定版本则取最新
      if (targetVersion == null) {
        const latest = rows[rows.length - 1];
        if (latest) {
          targetReport = latest.report;
          targetStories = Array.isArray(latest.user_stories) ? latest.user_stories : [];
          targetFeatures = Array.isArray(latest.features) ? latest.features : [];
          targetVersion = latest.version;
        }
      }
    } catch { /* 版本表查询失败降级到主表 */ }

    // 降级：从主表读取当前内容
    if (targetVersion == null) {
      const row = await db.get<{
        report?: string; user_stories?: unknown[]; features?: unknown[]; updated_at: string;
      }>("research_analysis", requirementId, "requirement_id");
      const exists = !!row;
      if (exists) {
        targetReport = row!.report;
        targetStories = Array.isArray(row!.user_stories) ? row!.user_stories : [];
        targetFeatures = Array.isArray(row!.features) ? row!.features : [];
        targetVersion = 1;
        vs = [{ version: 1, createdAt: row!.updated_at }];
      }
      return {
        ...base,
        version: targetVersion,
        versions: vs,
        content: exists ? buildResearchAnalysisMarkdown({ report: targetReport, user_stories: targetStories, features: targetFeatures }) : "",
      };
    }

    return {
      ...base,
      version: targetVersion,
      versions: vs,
      content: buildResearchAnalysisMarkdown({ report: targetReport, user_stories: targetStories, features: targetFeatures }),
    };
  }

  // 方案设计（组类型，按 subType 分发）
  if (type === "design") {
    if (subType === "solution") {
      // 从 solution_versions 读取版本列表
      let vs: OutputVersion[] = [];
      let targetDoc = "";
      let targetVersion: number | null = null;

      try {
        // 下推：命中 idx_sol_ver_req (requirement_id, version)
        const rows = await db.findMany<{
          version: number; doc?: string; note?: string; created_at: string;
        }>("solution_versions", {
          where: { requirement_id: { eq: requirementId } },
          orderBy: [["version", "asc"]],
        });
        vs = rows.map((v) => ({
          version: v.version, note: v.note, createdAt: v.created_at,
        }));

        if (version != null && vs.length > 0) {
          const t = rows.find((r) => r.version === version);
          if (t) { targetDoc = t.doc ?? ""; targetVersion = t.version; }
        }
        if (targetVersion == null && rows.length > 0) {
          const latest = rows[rows.length - 1];
          targetDoc = latest.doc ?? "";
          targetVersion = latest.version;
        }
      } catch { /* 版本表查询失败降级 */ }

      // 降级：从主表读取
      if (targetVersion == null) {
        const row = await db.get<{ doc?: string; updated_at: string }>("solutions", requirementId, "requirement_id");
        const exists = !!row?.doc;
        return {
          ...base,
          label: "方案文档",
          contentType: "markdown",
          version: exists ? 1 : null,
          versions: exists ? [{ version: 1, createdAt: row!.updated_at }] : [],
          content: row?.doc ?? "",
          subType: "solution",
        };
      }

      return {
        ...base,
        label: "方案文档",
        contentType: "markdown",
        version: targetVersion,
        versions: vs,
        content: targetDoc,
        subType: "solution",
      };
    }
    if (subType === "prototype") {
      const versions = await listPrototypeVersions(requirementId);
      const vs: OutputVersion[] = versions.map((v) => ({
        version: v.version, note: v.note, createdAt: v.created_at,
      }));
      const target = version != null
        ? versions.find((v) => v.version === version)
        : versions[versions.length - 1];
      const html = target ? await getPrototypeHtml(requirementId, target.version) : null;
      return {
        ...base,
        label: "交互原型",
        contentType: "html",
        version: target?.version ?? null,
        versions: vs,
        content: html ?? "",
        subType: "prototype",
      };
    }
    // 未指定 subType：返回方案文档 + 子产物列表
    const sol = await db.get<{ doc?: string; current_version?: number; updated_at: string }>("solutions", requirementId, "requirement_id");
    const proto = await db.get<{ current_version: number }>("prototypes", requirementId, "requirement_id");
    const solVer = sol?.current_version ?? 0;

    // 从 solution_versions 读取方案文档版本列表
    let solVersions: OutputVersion[] = [];
    try {
      // 下推：命中 idx_sol_ver_req (requirement_id, version)
      const rows = await db.findMany<{ version: number; note?: string; created_at: string }>(
        "solution_versions",
        {
          where: { requirement_id: { eq: requirementId } },
          orderBy: [["version", "asc"]],
        }
      );
      solVersions = rows.map((v) => ({
        version: v.version, note: v.note, createdAt: v.created_at,
      }));
    } catch { /* ignore */ }

    const subOutputs: SubOutput[] = OUTPUT_DEFS.find((d) => d.type === "design")?.subDefs
      ?.map((sd) => {
        if (sd.subType === "solution") {
          return { subType: "solution", label: sd.label, contentType: sd.contentType as OutputContentType, exists: !!sol?.doc, version: sol?.doc ? (solVer > 0 ? solVer : 1) : null };
        }
        return { subType: "prototype", label: sd.label, contentType: sd.contentType as OutputContentType, exists: !!proto && proto.current_version > 0, version: proto?.current_version ?? null };
      }) ?? [];
    return {
      ...base,
      version: sol?.doc ? (solVer > 0 ? solVer : 1) : null,
      versions: sol?.doc ? (solVersions.length > 0 ? solVersions : [{ version: 1, createdAt: sol.updated_at }]) : [],
      content: sol?.doc ?? "",
      subOutputs,
    };
  }

  // PRD
  // 下推：命中 idx_prd_ver_req (requirement_id, version)
  const rows = await db.findMany<{
    version: number; markdown: string; note?: string; created_at: string;
  }>("prd_versions", {
    where: { requirement_id: { eq: requirementId } },
    orderBy: [["version", "asc"]],
  });
  const vs: OutputVersion[] = rows.map((v) => ({
    version: v.version, note: v.note, createdAt: v.created_at,
  }));
  const target = version != null
    ? rows.find((r) => r.version === version)
    : rows[rows.length - 1];
  return {
    ...base,
    version: target?.version ?? null,
    versions: vs,
    content: target?.markdown ?? "",
  };
}

// ---- 内部辅助 ----

// buildResearchAnalysisMarkdown 已抽离至 @/lib/render/research-analysis，本文件直接引用。

// ---- 写回：AI 生成结果落库 ----
// 以下三个函数从 orchestrator.ts 的 finalizeStep 直接写库逻辑原样迁移，
// 行为与重构前严格一致（版本递增、版本历史容错、诊断日志均保留）。

export async function saveResearchAnalysis(
  requirementId: string,
  output: ResearchAnalysisOutput
): Promise<number> {
  const now = new Date().toISOString();
  const existing = await db.get<{ current_version: number }>("research_analysis", requirementId, "requirement_id");
  const nextVersion = (existing?.current_version ?? 0) + 1;

  // 插入版本历史（异常容错：版本历史写入失败不阻断主表更新）
  try {
    await db.insert("research_analysis_versions", {
      requirement_id: requirementId,
      version: nextVersion,
      report: output.report,
      user_stories: output.userStories,
      features: output.features,
      note: "",
      created_at: now,
    });
  } catch (verErr) {
    console.error("[saveResearchAnalysis] 版本历史写入失败:", verErr);
  }

  const row = {
    id: requirementId,
    requirement_id: requirementId,
    report: output.report,
    user_stories: output.userStories,
    features: output.features,
    source_conversation_id: null,
    upstream_ids: [],
    maybe_stale: 0,
    current_version: nextVersion,
    updated_at: now,
  };
  if (existing) {
    await db.update("research_analysis", requirementId, row as unknown as Record<string, unknown>, "requirement_id");
  } else {
    await db.insert("research_analysis", row as unknown as Record<string, unknown>);
  }
  return nextVersion;
}

export async function saveSolution(
  requirementId: string,
  doc: string
): Promise<number> {
  const now = new Date().toISOString();
  const existing = await db.get<{ current_version: number }>("solutions", requirementId, "requirement_id");
  const nextVersion = (existing?.current_version ?? 0) + 1;

  // 插入版本历史（异常容错：版本历史写入失败不阻断主表更新）
  try {
    await db.insert("solution_versions", {
      requirement_id: requirementId,
      version: nextVersion,
      doc,
      note: "",
      created_at: now,
    });
  } catch (verErr) {
    console.error("[saveSolution] 版本历史写入失败:", verErr);
  }

  const row = {
    id: requirementId,
    requirement_id: requirementId,
    doc,
    upstream_ids: [],
    maybe_stale: 0,
    current_version: nextVersion,
    updated_at: now,
  };
  if (existing) {
    await db.update("solutions", requirementId, row as unknown as Record<string, unknown>, "requirement_id");
  } else {
    await db.insert("solutions", row as unknown as Record<string, unknown>);
  }
  return nextVersion;
}

export async function savePRD(
  requirementId: string,
  markdown: string
): Promise<number> {
  const now = new Date().toISOString();
  const existing = await db.get<{ current_version: number }>("prds", requirementId, "requirement_id");
  const nextVersion = (existing?.current_version ?? 0) + 1;

  // 插入版本历史（异常容错：版本历史写入失败不阻断主表更新）
  try {
    await db.insert("prd_versions", {
      requirement_id: requirementId,
      version: nextVersion,
      markdown,
      note: "",
      created_at: now,
    });
  } catch (verErr) {
    console.error("[savePRD] 版本历史写入失败:", verErr);
  }

  const prdRow = {
    id: requirementId,
    requirement_id: requirementId,
    markdown,
    current_version: nextVersion,
    upstream_ids: [],
    maybe_stale: 0,
    updated_at: now,
  };
  if (existing) {
    await db.update("prds", requirementId, prdRow as unknown as Record<string, unknown>, "requirement_id");
  } else {
    await db.insert("prds", prdRow as unknown as Record<string, unknown>);
  }
  return nextVersion;
}
