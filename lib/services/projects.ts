// 项目数据服务：编排 lib/db，供 Route Handler 调用。
import { db } from "@/lib/db";
import { memo, invalidateCache } from "@/lib/utils/memo";
import type { Project, Requirement, RequirementStatus } from "@/types";
import { attachDerivedStatus } from "@/lib/stage";

// 进程内缓存（5s）。意义：一次 API 请求里常要连续调 listProjects 多次
// （例如概览页既要列需求又要统计总数，两者内部都要先取「我的项目 id 列表」）。
// 每次都是一次跨网关 SQL 往返（生产环境部署在海外、数据库在境内，单次 ~1.7s），
// 缓存后同一请求内只真正查一次。跨请求在 Serverless 下本就不共享，无脏读风险。
const PROJECTS_TTL_MS = 5000;

export const listProjects = memo(
  (ownerId: string) => `listProjects:${ownerId}`,
  PROJECTS_TTL_MS,
  async (ownerId: string): Promise<Project[]> => {
    // 下推：过滤命中 idx_projects_owner (owner_id, status) WHERE deleted_at IS NULL；
    // 排序列不在该索引里，PG 会在其上再加一次 Sort —— 项目数是个位数量级，可以接受。
    // orderBy 与 ORDER_HINT 保持一致，让三个后端返回同一顺序 —— mock 是插入序、
    // NoSQL 本就无序，PG 不显式排序同样不保证顺序，加上它才谈得上「行为等价」。
    return db.findMany<Project>("projects", {
      where: { ownerId: { eq: ownerId }, deleted_at: { isNull: true } },
      orderBy: [["createdAt", "asc"]],
    });
  }
);

export async function getProject(id: string): Promise<Project | null> {
  const p = await db.get<Project>("projects", id);
  if (!p || p.status === "archived") return null;
  return p;
}

export async function createProject(input: {
  name: string;
  description?: string;
  ownerId: string;
}): Promise<Project> {
  const now = new Date().toISOString();
  const project: Project = {
    id: crypto.randomUUID(),
    name: input.name,
    description: input.description,
    ownerId: input.ownerId,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  await db.insert("projects", project);
  invalidateCache("listProjects:*");
  return project;
}

export async function archiveProject(id: string): Promise<void> {
  await db.update("projects", id, {
    status: "archived",
    deleted_at: new Date().toISOString(),
  });
  invalidateCache("listProjects:*");
}

export async function updateProject(
  id: string,
  input: { name?: string; description?: string }
): Promise<Project> {
  const patch: Partial<Project> = { updatedAt: new Date().toISOString() };
  if (typeof input.name === "string" && input.name.trim()) {
    patch.name = input.name.trim();
  }
  if (typeof input.description === "string") {
    patch.description = input.description;
  }
  const updated = await db.update<Project>("projects", id, patch);
  if (!updated) {
    throw new Error("project_not_found");
  }
  invalidateCache("listProjects:*");
  return updated;
}

export interface ProjectStats {
  /** 需求总数（不含已归档） */
  total: number;
  /** 进行中（未完结、未归档）需求数 */
  active: number;
  /** 本周完成（近 7 天完成）需求数 */
  doneThisWeek: number;
  /** 待开始（仍处于对话/确认/调研等早期阶段、尚未进入分析/设计/PRD 的需求数） */
  notStarted: number;
}

/** 仍处于对话阶段（需求确认），视为「待开始/未推进」 */
const NOT_STARTED: RequirementStatus[] = ["dialoguing"];

/**
 * 统计项目需求概况：总需求、进行中、本周完成、待开始。
 * 仅依赖项目内需求数据，避免引入额外写库逻辑。
 */
export async function getProjectStats(projectId: string): Promise<ProjectStats> {
  // 下推：完整命中 idx_req_project (project_id, updated_at DESC) WHERE archived_at IS NULL。
  // 本函数只做计数，顺序对结果无影响；仍显式声明是为了与 listRequirements 同一口径，
  // 让两条查询在执行计划里长得一样，排查问题时不必分辨「这条为什么多了个 Sort」。
  const raw = await db.findMany<Requirement>("requirements", {
    where: { projectId: { eq: projectId }, archived_at: { isNull: true } },
    orderBy: [["updatedAt", "desc"]],
  });
  const requirements = await attachDerivedStatus(raw);

  const total = requirements.length;
  const active = requirements.filter(
    (r) => r.status !== "completed" && r.status !== "archived"
  ).length;

  const weekAgo = Date.now() - 7 * 864e5; // 一天 = 864e5 ms（之前误用 864e4，算成 16.8h 而非 7 天）
  const doneThisWeek = requirements.filter(
    (r) => r.status === "completed" && new Date(r.updatedAt).getTime() >= weekAgo
  ).length;

  const notStarted = requirements.filter((r) => NOT_STARTED.includes(r.status)).length;

  return { total, active, doneThisWeek, notStarted };
}

/** 同一用户下、未删除的项目中是否已有同名（忽略大小写/首尾空格），可排除自身 id。 */
export async function isProjectNameTaken(
  ownerId: string,
  name: string,
  exceptId?: string
): Promise<boolean> {
  const list = await listProjects(ownerId);
  const n = name.trim().toLowerCase();
  return list.some(
    (p) => p.id !== exceptId && p.name.trim().toLowerCase() === n
  );
}
