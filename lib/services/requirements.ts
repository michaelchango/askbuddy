// 需求数据服务：编排 lib/db。
import { db } from "@/lib/db";
import { listProjects } from "@/lib/services/projects";
import { listConversations } from "@/lib/services/conversations";
import { summarizeTitle } from "@/lib/ai/title";
import { initSteps } from "@/lib/services/steps";
import { attachDerivedStatus } from "@/lib/stage";
import type { Requirement, RequirementCard, TitleSource } from "@/types";

const EMPTY_CARD: RequirementCard = {
  background: "",
  targetUsers: "",
  painPoints: "",
  scope: "",
  nonFunctional: "",
  constraints: "",
};

export async function listRequirements(projectId: string): Promise<Requirement[]> {
  const list = await db.list<Requirement>(
    "requirements",
    (r) => r.projectId === projectId && !r.archived_at
  );
  return attachDerivedStatus(list);
}

/** 当前用户全部需求（跨项目），用于概览页「最近需求」。 */
export async function listRequirementsForOwner(ownerId: string): Promise<Requirement[]> {
  const owned = await listProjects(ownerId);
  const ids = new Set(owned.map((p) => p.id));
  if (ids.size === 0) return [];
  const list = await db.list<Requirement>(
    "requirements",
    (r) => ids.has(r.projectId as string) && !r.archived_at
  );
  return attachDerivedStatus(list);
}

export async function createRequirement(input: {
  projectId: string;
  title: string;
  card?: Partial<RequirementCard>;
}): Promise<Requirement> {
  const now = new Date().toISOString();
    const requirement: Requirement = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      title: input.title,
      titleSource: input.title ? "manual" : null,
      status: "dialoguing",
      card: { ...EMPTY_CARD, ...(input.card || {}) },
      createdAt: now,
      updatedAt: now,
    };
  await db.insert("requirements", requirement);
  // 自动初始化 4 行步骤记录
  await initSteps(requirement.id);
  return requirement;
}

export async function getRequirementWithStatus(
  id: string
): Promise<Requirement | undefined> {
  const req = await getRequirement(id);
  if (!req) return undefined;
  return (await attachDerivedStatus([req]))[0];
}

export async function updateRequirementTitle(
  id: string,
  title: string,
  source?: TitleSource
): Promise<void> {
  // 防御：模型偶尔返回思考链标记等脏内容，直接丢弃不写入
  const clean = (title || "").replace(/<[^>]+>/g, "").trim();
  if (!clean) return;
  const patch: Record<string, unknown> = {
    title: clean,
    updatedAt: new Date().toISOString(),
  };
  if (source !== undefined) patch.titleSource = source;
  await db.update("requirements", id, patch);
}

export async function getRequirement(id: string): Promise<Requirement | undefined> {
  return db.get<Requirement>("requirements", id);
}

/** 刷新需求的「最近更新时间」（如每次对话轮次结束后调用）。 */
export async function touchRequirement(id: string): Promise<void> {
  await db.update("requirements", id, { updatedAt: new Date().toISOString() });
}

/** 删除需求及其关联的对话与输出物。 */
export async function deleteRequirement(id: string): Promise<void> {
  await db.remove("requirements", id);
  await db.removeBy("conversations", "requirementId", id);
  await db.removeBy("outputs", "requirementId", id);
}

// 增量合并部分卡片到需求（渐进填充：仅合并非空字段，避免清空已填写内容）。
// 注意：本函数只覆盖更新当前卡片草稿内容，不产生版本。
// 版本递增统一由 finalizeCardVersion 在里程碑时刻（需求确认定版 / 需求变更）触发。
export async function mergeRequirementCard(
  id: string,
  partial: Partial<RequirementCard>
): Promise<RequirementCard> {
  const req = await getRequirement(id);
  const base: RequirementCard = req?.card ?? { ...EMPTY_CARD };
  const merged: RequirementCard = { ...base };
  (Object.keys(partial) as (keyof RequirementCard)[]).forEach((k) => {
    const v = partial[k];
    if (typeof v === "string" && v.trim() !== "") merged[k] = v;
  });

  await db.update("requirements", id, {
    card: merged,
    updatedAt: new Date().toISOString(),
  });
  return merged;
}

// 里程碑定版：将当前卡片草稿冻结为新版本（current_version+1 并写入 card_versions）。
// 触发时机：
// 1) 首次定版——需求确认阶段（dialoguing）置 done 时冻结 v1（见 steps.ts markStepDone）；
// 2) 变更定版——变更模式修改卡片成功后递增版本（见 card.ts applyCardChange），note 记录变更摘要。
// 返回新版本号；卡片为空或需求不存在时返回当前版本号（不产生空版本）。
export async function finalizeCardVersion(id: string, note?: string): Promise<number> {
  const req = await getRequirement(id);
  const currentVer =
    ((req as unknown as Record<string, unknown>)?.current_version as number) ?? 0;
  if (!req) return currentVer;

  const card: RequirementCard = req.card ?? { ...EMPTY_CARD };
  // 卡片无任何实质内容时不定版，避免产生空版本快照
  const hasContent = Object.values(card).some(
    (v) => typeof v === "string" && v.trim() !== ""
  );
  if (!hasContent) return currentVer;

  const now = new Date().toISOString();
  const nextVersion = currentVer + 1;

  try {
    await db.insert("card_versions", {
      requirement_id: id,
      version: nextVersion,
      card,
      note: (note ?? "").slice(0, 255),
      created_at: now,
    });
  } catch {
    /* 版本写入失败不阻塞主流程 */
    return currentVer;
  }

  await db.update("requirements", id, {
    current_version: nextVersion,
    updatedAt: now,
  });
  return nextVersion;
}

// 由对话记录生成结构化需求卡片。卡片生成后仍保持在 dialoguing 阶段；
// 步骤完成度由 requirement_steps 表独立管理，不再通过 status 切换阶段。
export async function generateCard(id: string): Promise<RequirementCard> {
  const convs = await db.list("conversations", (r) => r.requirement_id === id);
  const userText = convs
    .filter((c) => c.role === "user")
    .map((c) => c.content)
    .join("\n");

  const card: RequirementCard = {
    background: userText.slice(0, 500) || "（暂无对话内容）",
    targetUsers: "待补充",
    painPoints: "待补充",
    scope: "待补充",
    nonFunctional: "待补充",
    constraints: "待补充",
  };

  const now = new Date().toISOString();
  const req = await getRequirement(id);
  const currentVer = (req as unknown as Record<string, unknown>)?.current_version as number ?? 0;
  const nextVersion = currentVer + 1;

  // 保存版本历史
  try {
    await db.insert("card_versions", {
      requirement_id: id,
      version: nextVersion,
      card,
      note: "",
      created_at: now,
    });
  } catch { /* 版本写入失败不阻塞主流程 */ }

  await db.update("requirements", id, {
    card,
    current_version: nextVersion,
    updatedAt: now,
  });

  return card;
}

/**
 * 当需求尚未有标题（空字符串）且对话已有足够信息时，自动概括并更新标题。
 * 返回新标题或 null（无需更新）。
 */
export async function maybeAutoTitle(id: string): Promise<string | null> {
  const req = await getRequirement(id);
  if (!req) return null;
  // 已锁定的标题（自动概括或手动改名）不再改写；
  // 仅在标题为空且未锁定时生成一次，避免重新进入/重新加载后标题被重复改写。
  if (req.titleSource === "auto" || req.titleSource === "manual") return null;
  if (req.title && req.title.trim() !== "") return null; // 已有标题，不覆盖

  const convs = await listConversations(id);
  if (convs.length < 2) return null; // 至少完成一轮对话（用户+助手）

  const title = await summarizeTitle(
    convs.map((c) => ({
      role: (c.role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: c.content,
    }))
  );
  if (!title || title.trim() === "") return null;

  await updateRequirementTitle(id, title, "auto");
  return title;
}
