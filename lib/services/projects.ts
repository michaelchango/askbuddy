// 项目数据服务：编排 lib/db，供 Route Handler 调用。
import { db } from "@/lib/db";
import type { Project, Requirement, RequirementStatus } from "@/types";
import { attachDerivedStatus } from "@/lib/stage";

export async function listProjects(ownerId: string): Promise<Project[]> {
  return db.list<Project>("projects", (r) => r.ownerId === ownerId && !r.deleted_at);
}

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
  return project;
}

export async function archiveProject(id: string): Promise<void> {
  await db.update("projects", id, {
    status: "archived",
    deleted_at: new Date().toISOString(),
  });
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
  const raw = await db.list<Requirement>(
    "requirements",
    (r) => r.projectId === projectId && !r.archived_at
  );
  const requirements = await attachDerivedStatus(raw);

  const total = requirements.length;
  const active = requirements.filter(
    (r) => r.status !== "completed" && r.status !== "archived"
  ).length;

  const weekAgo = Date.now() - 7 * 864e4;
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
