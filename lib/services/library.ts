// 产出物库聚合服务：按项目聚合调研/方案/原型/文档四类产出物。
// 与 outputs.ts（按需求维度）互补：本模块面向项目级库页面。
import { db } from "@/lib/db";
import { listRequirements } from "./requirements";

export type LibraryType = "research" | "solution" | "prototype" | "prd";

export interface LibraryItem {
  requirementId: string;
  requirementTitle: string;
  requirementStatus: string;
  version: number;
  updatedAt: string;
  /** 产出物是否存在（有真实内容） */
  exists: boolean;
}

function normalizeUpdatedAt(v?: string): string {
  return v ?? "";
}

/** 表名 + 解析产出版本/更新时间的元数据提取函数。 */
const TABLE_META: Record<LibraryType, { table: string; extract: (row: { current_version?: number; updated_at?: string; doc?: string }) => { version: number; updatedAt: string; exists: boolean } }> = {
  research: {
    table: "research_analysis",
    extract: (r) => ({ version: r.current_version || 1, updatedAt: normalizeUpdatedAt(r.updated_at), exists: true }),
  },
  solution: {
    table: "solutions",
    extract: (r) => ({ version: r.current_version || 1, updatedAt: normalizeUpdatedAt(r.updated_at), exists: !!r.doc }),
  },
  prototype: {
    table: "prototypes",
    extract: (r) => ({ version: r.current_version ?? 0, updatedAt: normalizeUpdatedAt(r.updated_at), exists: (r.current_version ?? 0) > 0 }),
  },
  prd: {
    table: "prds",
    extract: (r) => ({ version: r.current_version ?? 0, updatedAt: normalizeUpdatedAt(r.updated_at), exists: (r.current_version ?? 0) > 0 }),
  },
};

/**
 * 获取项目下指定类型的所有产出物列表（仅含元数据，不含完整内容）。
 * 按 updatedAt 倒序排列。
 *
 * 关键修复（库页 N+1 → 1 次 IN 查询）：
 * 旧实现对每个需求都 `db.get(table, req.id, "requirement_id")`，项目若有 50 条需求
 * = 1 + 50 = 51 条 SQL。新实现 1 次 `findMany` 用 IN 子句批量取，1 + 1 = 2 条。
 */
export async function getProjectLibrary(
  projectId: string,
  type: LibraryType
): Promise<LibraryItem[]> {
  const requirements = await listRequirements(projectId);
  if (requirements.length === 0) return [];

  const meta = TABLE_META[type];
  const ids = requirements.map((r) => r.id);
  const rows = await db.findMany<{ requirement_id: string; current_version?: number; updated_at?: string; doc?: string }>(
    meta.table,
    { where: { requirement_id: { in: ids } } }
  );
  // 按 requirement_id 建索引，便于 O(1) 查找
  const byReqId = new Map<string, { current_version?: number; updated_at?: string; doc?: string }>();
  for (const row of rows) byReqId.set(row.requirement_id, row);

  const result: LibraryItem[] = [];
  for (const req of requirements) {
    const row = byReqId.get(req.id);
    if (!row) continue;
    const { version, updatedAt, exists } = meta.extract(row);
    if (!exists) continue;
    result.push({
      requirementId: req.id,
      requirementTitle: req.title,
      requirementStatus: req.status,
      version,
      updatedAt,
      exists: true,
    });
  }

  // 按更新时间倒序
  result.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  return result;
}
