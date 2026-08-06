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
  // 下推：完整命中 idx_req_project (project_id, updated_at DESC) WHERE archived_at IS NULL
  // —— 过滤、部分索引条件、排序三者都由这一个索引满足，无需额外 Sort 节点。
  // 排序口径取 updatedAt desc 而非 createdAt：调用方 app/api/requirements/route.ts
  // 拿到结果后本来就按 updatedAt desc 重排一遍，与其让库里出一个随后被推翻的顺序，
  // 不如一开始就按最终口径出，那次内存 sort 随之退化为无操作。
  const list = await db.findMany<Requirement>("requirements", {
    where: { projectId: { eq: projectId }, archived_at: { isNull: true } },
    orderBy: [["updatedAt", "desc"]],
  });
  return attachDerivedStatus(list);
}

/** 当前用户全部需求（跨项目），用于概览页「最近需求」。 */
export async function listRequirementsForOwner(ownerId: string): Promise<Requirement[]> {
  const owned = await listProjects(ownerId);
  const ids = owned.map((p) => p.id);
  if (ids.length === 0) return [];
  // 下推：闭包里的 Set.has 是「无法翻译成 SQL」的典型 —— 换成声明式的 in 之后，
  // 同一个语义就能直接落到 project_id IN (...)，不必再把全表拉回内存。
  const list = await db.findMany<Requirement>("requirements", {
    where: { projectId: { in: ids }, archived_at: { isNull: true } },
    orderBy: [["updatedAt", "desc"]],
  });
  return attachDerivedStatus(list);
}

export async function createRequirement(input: {
  projectId: string;
  title: string;
  card?: Partial<RequirementCard>;
}): Promise<Requirement> {
  const now = new Date().toISOString();
  // 不写 status：需求阶段是【派生值】，唯一事实源是 requirement_steps.state
  // （见 lib/stage.ts:deriveRequirementStatus）。历史上这里写死过 "dialoguing"，
  // 且此后从不更新 —— 一个只会误导读者的僵尸字段，M1 随 PG 列一并移除。
  // Omit 让「持久化形状」与「带派生字段的视图形状」在类型上就分得清清楚楚。
  const persisted: Omit<Requirement, "status"> = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    title: input.title,
    titleSource: input.title ? "manual" : null,
    card: { ...EMPTY_CARD, ...(input.card || {}) },
    createdAt: now,
    updatedAt: now,
  };
  await db.insert("requirements", persisted);
  // 自动初始化 4 行步骤记录
  await initSteps(persisted.id);
  // 4 行步骤刚写入且均为 not_started，派生结果必然是工作流第一阶段，
  // 这里直接给出，省掉一次为了拿 status 而回查 requirement_steps 的往返。
  return { ...persisted, status: "dialoguing" };
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

/**
 * 需求的全部子表。删除需求时逐表清理。
 *
 * 【为什么不能只依赖数据库外键级联】
 * PG 侧这些表都带 ON DELETE CASCADE，但 mock 与 nosql 两个后端没有外键概念。
 * 显式清理是三后端行为一致的唯一保证；在 PG 上重复删除只是空操作，无副作用。
 */
const REQUIREMENT_CHILD_TABLES = [
  "conversations",
  "requirement_steps",
  "card_versions",
  "research_analysis",
  "research_analysis_versions",
  "solutions",
  "solution_versions",
  "prototypes",
  "prototype_versions",
  "prds",
  "prd_versions",
  "share_tokens",
] as const;

/**
 * 删除需求及其全部关联数据。
 *
 * 【M1 修复的两个死调用】原实现是：
 *     db.removeBy("conversations", "requirementId", id)   // ← 字段名错，实际列是 requirement_id
 *     db.removeBy("outputs", "requirementId", id)         // ← 表名错，从来不存在 outputs 表
 * 两处都不会报错：NoSQL 里字段不匹配等于删 0 行，表不存在则被 ensureCollection
 * 自动建成空集合掩盖。结果是删需求后对话与产物全部残留成孤儿数据。
 * PG 会对这两种写法直接抛错，问题因此暴露。
 */
export async function deleteRequirement(id: string): Promise<void> {
  // 先子后主：mock / nosql 无级联，顺序反了会留下孤儿；PG 侧顺序无所谓。
  for (const table of REQUIREMENT_CHILD_TABLES) {
    await db.removeBy(table, "requirement_id", id);
  }
  await db.remove("requirements", id);
  // 遗留项：原型 HTML 存在 objects 表（key = proto-html/v{n}/<id>），该表没有
  // requirement_id 列，无法按需求批量清理。孤儿对象的回收留待 M2 的存储治理处理。
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
  // 下推：只取该需求下的 user 消息，过滤全部交给 SQL
  const convs = await db.findMany<{ role: string; content: string }>("conversations", {
    where: { requirement_id: { eq: id }, role: { eq: "user" } },
    orderBy: [["id", "asc"]],
  });
  const userText = convs.map((c) => c.content).join("\n");

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
