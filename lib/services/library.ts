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

/**
 * 获取项目下指定类型的所有产出物列表（仅含元数据，不含完整内容）。
 * 按 updatedAt 倒序排列。
 */
export async function getProjectLibrary(
  projectId: string,
  type: LibraryType
): Promise<LibraryItem[]> {
  const requirements = await listRequirements(projectId);

  // 批量查询产出物表
  const checks = await Promise.all(
    requirements.map(async (req) => {
      switch (type) {
        case "research": {
          const row = await db.get<{ current_version?: number; updated_at?: string }>(
            "research_analysis",
            req.id,
            "requirement_id"
          );
          if (!row) return null;
          return {
            requirementId: req.id,
            requirementTitle: req.title,
            requirementStatus: req.status,
            version: row.current_version || 1,
            updatedAt: normalizeUpdatedAt(row.updated_at),
            exists: true,
          };
        }
        case "solution": {
          const row = await db.get<{ doc?: string; current_version?: number; updated_at?: string }>(
            "solutions",
            req.id,
            "requirement_id"
          );
          if (!row?.doc) return null;
          return {
            requirementId: req.id,
            requirementTitle: req.title,
            requirementStatus: req.status,
            version: row.current_version || 1,
            updatedAt: normalizeUpdatedAt(row.updated_at),
            exists: true,
          };
        }
        case "prototype": {
          const row = await db.get<{
            current_version: number;
            updated_at?: string;
          }>("prototypes", req.id, "requirement_id");
          if (!row || (row.current_version ?? 0) <= 0) return null;
          return {
            requirementId: req.id,
            requirementTitle: req.title,
            requirementStatus: req.status,
            version: row.current_version,
            updatedAt: normalizeUpdatedAt(row.updated_at),
            exists: true,
          };
        }
        case "prd": {
          const row = await db.get<{
            current_version: number;
            updated_at?: string;
          }>("prds", req.id, "requirement_id");
          if (!row || (row.current_version ?? 0) <= 0) return null;
          return {
            requirementId: req.id,
            requirementTitle: req.title,
            requirementStatus: req.status,
            version: row.current_version,
            updatedAt: normalizeUpdatedAt(row.updated_at),
            exists: true,
          };
        }
        default:
          return null;
      }
    })
  );

  const result: LibraryItem[] = checks.filter(
    (item): item is NonNullable<typeof item> => item != null
  );

  // 按更新时间倒序
  result.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  return result;
}
