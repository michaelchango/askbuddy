// 开发上下文落库与读取服务（M2-A3）。
//
// 严格照抄 lib/services/outputs.ts saveResearchAnalysis() 的范式（版本表写入 try/catch 容错、
// 主表 update/insert 二分支、返回新版本号），但【不引入任何 [DEBUG] 日志】（M0 已清旧债）。
//
// 四个消费方（MCP 路由 / Web API / UI panel / 渲染器）必须走本服务层，不得直触 db。

import { db } from "@/lib/db";
import {
  DevContextSchema,
  type DevContext,
  type DevContextBody,
  type SectionKey,
} from "@/lib/schemas/devcontext";
import { getRequirement } from "@/lib/services/requirements";
import { getConversationTurn } from "@/lib/services/conversations";
import type { OutputVersion } from "@/lib/services/outputs";
import type { CompletenessReport, ConsistencyIssue } from "@/lib/services/devcontext-validate";

/** dev_contexts 主表行（代码键口径，snake_case，与 field-map.ts 一致）。 */
export interface DevContextRecord {
  requirement_id: string;
  content: DevContext;
  completeness_score: number;
  status: string;
  current_version: number;
  applicable_count: number;
  present_count: number;
  upstream_ids: unknown[];
  maybe_stale: number;
  generated_by?: string | null;
  updated_at: string;
}

/** B4 主循环传入的已计算结果，本服务据此组装完整 meta + references 并二次校验落库。 */
export interface SaveMetaInput {
  score: CompletenessReport;
  issues: ConsistencyIssue[];
  status: "draft" | "confirmed";
  trigger: "prd_writing" | "manual" | "change_analysis";
  note?: string;
}

/** 读取开发上下文：不传 version 读主表；传了从 dev_context_versions 用复合 id 精确取。 */
export async function getDevContext(
  requirementId: string,
  version?: number
): Promise<DevContextRecord | null> {
  if (version != null) {
    const v = await db.get<{
      requirement_id: string;
      content: DevContext;
      completeness_score: number;
      status: string;
      version: number;
      created_at: string;
    }>("dev_context_versions", `${requirementId}-v${version}`); // 复合 id，复用 prototype_versions 惯例
    if (!v) return null;
    return {
      requirement_id: v.requirement_id,
      content: v.content,
      completeness_score: v.completeness_score,
      status: v.status,
      current_version: v.version,
      applicable_count: v.content?.meta?.applicable_sections?.length ?? 0,
      present_count: v.content?.meta?.present_sections?.length ?? 0,
      upstream_ids: [],
      maybe_stale: 0,
      generated_by: null,
      updated_at: v.created_at,
    };
  }
  const row = await db.get<DevContextRecord>("dev_contexts", requirementId, "requirement_id");
  return row ?? null;
}

/** 列出某需求的全部开发上下文版本（与 prototypes.listVersions 同构）。 */
export async function listDevContextVersions(requirementId: string): Promise<OutputVersion[]> {
  const rows = await db.findMany<{
    version: number;
    note?: string;
    created_at?: string;
  }>("dev_context_versions", {
    where: { requirement_id: { eq: requirementId } },
    orderBy: [["version", "asc"]],
  });
  return rows.map((r) => ({
    version: r.version,
    note: r.note,
    createdAt: r.created_at,
  }));
}

/** 取某个 section 的内容（MCP section 工具的服务层入口，避免路由层解 JSONB）。 */
export async function getDevContextSection(
  requirementId: string,
  section: SectionKey
): Promise<unknown | null> {
  const rec = await getDevContext(requirementId);
  if (!rec) return null;
  const v = (rec.content as Record<string, unknown>)[section];
  if (v == null) return null;
  if (Array.isArray(v)) return v.length > 0 ? v : null;
  if (typeof v === "object") return Object.keys(v).length > 0 ? v : null;
  return v;
}

/**
 * 落库一份开发上下文：current_version+1 → 组装完整 meta/references →
 * DevContextSchema 二次校验 → 写 dev_context_versions → upsert dev_contexts → 返回版本号。
 */
export async function saveDevContext(
  requirementId: string,
  body: DevContextBody,
  meta: SaveMetaInput
): Promise<number> {
  const now = new Date().toISOString();
  const req = await getRequirement(requirementId);
  const title = req?.title ?? requirementId;

  const existing = await db.get<{ current_version: number }>("dev_contexts", requirementId, "requirement_id");
  const nextVersion = (existing?.current_version ?? 0) + 1;

  // 组装上游版本链接与 references（meta.source_links / references 的赋值发生在落库层，不算模型输入）
  const [ra, sol, proto, prd] = await Promise.all([
    db.get<{ current_version: number }>("research_analysis", requirementId, "requirement_id").catch(() => null),
    db.get<{ current_version: number }>("solutions", requirementId, "requirement_id").catch(() => null),
    db.get<{ current_version: number }>("prototypes", requirementId, "requirement_id").catch(() => null),
    db.get<{ current_version: number }>("prds", requirementId, "requirement_id").catch(() => null),
  ]);

  const full = DevContextSchema.parse({
    ...body,
    $schema: "https://askbuddy.dev/schemas/dev-context/v1.json",
    schema_version: "1.0",
    meta: {
      requirement_id: requirementId,
      title,
      version: nextVersion,
      status: meta.status,
      generated_at: now,
      generated_by: "devcontext-agent@v1",
      completeness_score: meta.score.score,
      applicable_sections: meta.score.applicable as SectionKey[],
      present_sections: meta.score.present as SectionKey[],
      consistency_issues: meta.issues,
      source_links: {
        card: { id: requirementId, version: ((req as Record<string, unknown> | undefined)?.current_version as number | undefined) ?? 0 },
        research_analysis: ra ? { id: requirementId, version: ra.current_version } : undefined,
        solution: sol ? { id: requirementId, version: sol.current_version } : undefined,
        prototype: proto ? { id: requirementId, version: proto.current_version } : undefined,
        prd: prd ? { id: requirementId, version: prd.current_version } : undefined,
      },
      changelog: [{
        version: nextVersion,
        updated_at: now,
        trigger: meta.trigger,
        note: meta.note,
      }],
    },
    references: {
      prototype_id: proto ? requirementId : null,
      prototype_version: proto?.current_version ?? null,
      prd_version: prd?.current_version ?? null,
      research_version: ra?.current_version ?? null,
      solution_version: sol?.current_version ?? null,
    },
  });

  // M3 · 填充 DevContext 各条目 _source.conversation_turn（分级溯源 + 验收红线回溯）
  const turn = (await getConversationTurn(requirementId).catch(() => 0)) ?? 0;
  if (turn > 0) injectConversationTurn(full, turn);

  // 写版本历史（异常容错：版本历史写入失败不阻断主表更新）
  try {
    await db.insert("dev_context_versions", {
      id: `${requirementId}-v${nextVersion}`,
      requirement_id: requirementId,
      version: nextVersion,
      content: full,
      completeness_score: full.meta.completeness_score,
      status: full.meta.status,
      changelog: full.meta.changelog,
      note: meta.note ?? "",
      created_at: now,
    });
  } catch (verErr) {
    console.error("[saveDevContext] 版本历史写入失败:", verErr);
  }

  const row = {
    requirement_id: requirementId,
    content: full,
    completeness_score: full.meta.completeness_score,
    status: full.meta.status,
    current_version: nextVersion,
    applicable_count: full.meta.applicable_sections.length,
    present_count: full.meta.present_sections.length,
    upstream_ids: [],
    maybe_stale: 0,
    generated_by: full.meta.generated_by,
    updated_at: now,
  };
  if (existing) {
    await db.update("dev_contexts", requirementId, row, "requirement_id");
  } else {
    await db.insert("dev_contexts", row);
  }
  return nextVersion;
}

/** 删除需求的开发上下文（挂到 requirements.deleteRequirement）。 */
export async function deleteDevContext(requirementId: string): Promise<void> {
  await db.removeBy("dev_context_versions", "requirement_id", requirementId);
  await db.remove("dev_contexts", requirementId, "requirement_id");
}

// M3 · DevContext 分级溯源辅助函数已抽到 db 无关的 lib/services/devcontext-source.ts，
// 避免客户端组件引用时把 @cloudbase/node-sdk 拖进浏览器打包。
export { firstSourceTurn } from "@/lib/services/devcontext-source";
import { injectConversationTurn } from "@/lib/services/devcontext-source";
