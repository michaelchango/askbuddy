// 需求数据服务：编排 lib/db。
import { db } from "@/lib/db";
import { listProjects } from "@/lib/services/projects";
import { listConversations } from "@/lib/services/conversations";
import { summarizeTitle } from "@/lib/ai/title";
import { extractCard } from "@/lib/ai/orchestrator";
import { initSteps } from "@/lib/services/steps";
import { attachDerivedStatus } from "@/lib/stage";
import { memo, invalidateCache } from "@/lib/utils/memo";
import type { Requirement, RequirementCard, TitleSource } from "@/types";

export const EMPTY_CARD: RequirementCard = {
  background: "",
  targetUsers: "",
  painPoints: "",
  scope: "",
  nonFunctional: "",
  constraints: "",
};

// ---------------------------------------------------------------------------
// 【P0 修遗漏】数据层内存缓存（listRequirements + listRequirementsForOwner +
// getRequirementWithStatus）。这是单页打开时「热到烫手」的三个入口：
//
// 1. dashboard/project 页 → GET /api/requirements → listRequirements
// 2. 跨项目 dashboard → listRequirementsForOwner
// 3. 需求详情页 RSC → getRequirementWithStatus
//
// 旧实现裸调 db.findMany + attachDerivedStatus，每次都打 2 SQL（1 requirements +
// 1 requirement_steps），单页扇出阶段这里就贡献 6+ SQL。in-flight dedup 救不了
// 不同 id 数组（不同 SQL 字符串），必须用 TTL 缓存。
//
// 失效时机：touch / update / create / delete / 步骤状态变更 → invalidate。
// 5s TTL 让读多写少场景几乎零 DB 开销，又避免长期脏数据。
// ---------------------------------------------------------------------------
const LIST_TTL_MS = 5000;

export const listRequirements = memo(
  (projectId: string, opts?: ListRequirementsOpts) =>
    `listRequirements:${projectId}:${opts?.limit ?? "all"}:${opts?.offset ?? 0}`,
  LIST_TTL_MS,
  async (projectId: string, opts?: ListRequirementsOpts): Promise<Requirement[]> => {
    // 下推：完整命中 idx_req_project (project_id, updated_at DESC) WHERE archived_at IS NULL
    // —— 过滤、部分索引条件、排序三者都由这一个索引满足，无需额外 Sort 节点。
    const list = await db.findMany<Requirement>("requirements", {
      where: { projectId: { eq: projectId }, archived_at: { isNull: true } },
      orderBy: [["updatedAt", "desc"]],
      ...(opts?.limit != null ? { limit: opts.limit } : {}),
      ...(opts?.offset ? { offset: opts.offset } : {}),
    });
    return attachDerivedStatus(list);
  }
);

/** 单个项目下的需求总数，用于需求列表分页控件算总页数。 */
export const countRequirements = memo(
  (projectId: string) => `countRequirements:${projectId}`,
  LIST_TTL_MS,
  async (projectId: string): Promise<number> => {
    return db.countMany("requirements", {
      projectId: { eq: projectId },
      archived_at: { isNull: true },
    });
  }
);

/** 需求列表分页参数。不传 = 返回全部（与历史行为一致）。 */
export interface ListRequirementsOpts {
  /** 每页条数上限 */
  limit?: number;
  /** 跳过前 offset 条（与 limit 配合做分页） */
  offset?: number;
}

/**
 * owner 维度需求查询下推成单条带子查询的 SQL，把原本
 * 「listProjects → findMany(requirements IN 项目ids) → attachDerivedStatus(steps)」
 * 的 3 趟串行砍成 2 趟（这条子查询 + steps 那趟）。子查询在数据库内完成
 * project_id 过滤，省掉一次跨网关往返（生产环境部署海外、数据库在境内时关键）。
 *
 * 仅在支持 queryRaw 的 cloudbase / postgres 后端走快路径；不支持的后端
 * （mock / nosql）由调用方 try/catch 回落到旧的三趟组合。
 * 列名直接用库内真实列（queryRaw 透传 SQL，不经 field-map 翻译）；ownerId
 * 经 :owner 占位由 db.queryRaw 内部 lit() 转义，等效预处理，防注入。
 */
function buildOwnerReqSql(
  ownerId: string,
  opts?: ListRequirementsOpts
): { sql: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = { owner: ownerId };
  let sql =
    `SELECT r.* FROM requirements r ` +
    `WHERE r.project_id IN (SELECT id FROM projects WHERE owner_id = :owner AND deleted_at IS NULL) ` +
    `AND r.archived_at IS NULL ORDER BY r.updated_at DESC`;
  // 不传 limit 时与 findMany 默认 listLimit()=1000 对齐，避免误拉全表。
  if (opts?.limit != null) {
    sql += ` LIMIT :lim`;
    params.lim = opts.limit;
  } else {
    sql += ` LIMIT 1000`;
  }
  if (opts?.offset) {
    sql += ` OFFSET :off`;
    params.off = opts.offset;
  }
  return { sql, params };
}

const OWNER_COUNT_SQL = `
SELECT COUNT(*)::text AS n FROM requirements r
WHERE r.project_id IN (SELECT id FROM projects WHERE owner_id = :owner AND deleted_at IS NULL)
AND r.archived_at IS NULL`;

/** 当前用户全部需求（跨项目），用于概览页「最近需求」。支持分页。 */
export const listRequirementsForOwner = memo(
  (ownerId: string, opts?: ListRequirementsOpts) =>
    `listRequirementsForOwner:${ownerId}:${opts?.limit ?? "all"}:${opts?.offset ?? 0}`,
  LIST_TTL_MS,
  async (ownerId: string, opts?: ListRequirementsOpts): Promise<Requirement[]> => {
    try {
      // 快路径：一条带子查询的 SQL 取代「查项目 + 查需求」两趟（cloudbase/postgres）。
      const { sql, params } = buildOwnerReqSql(ownerId, opts);
      const list = await db.queryRaw<Requirement>("requirements", sql, params);
      return attachDerivedStatus(list);
    } catch {
      // 回落：mock / nosql 等不支持 queryRaw 的后端，走旧的三趟组合。
      const owned = await listProjects(ownerId);
      const ids = owned.map((p) => p.id);
      if (ids.length === 0) return [];
      const list = await db.findMany<Requirement>("requirements", {
        where: { projectId: { in: ids }, archived_at: { isNull: true } },
        orderBy: [["updatedAt", "desc"]],
        ...(opts?.limit != null ? { limit: opts.limit } : {}),
        ...(opts?.offset ? { offset: opts.offset } : {}),
      });
      return attachDerivedStatus(list);
    }
  }
);

/**
 * 当前用户需求总数（跨项目），用于分页控件算总页数。
 * 与 listRequirementsForOwner 搭配使用时，两者内部都要取「我的项目」，
 * 靠 listProjects 的进程内缓存保证同一请求内只查一次。
 */
export const countRequirementsForOwner = memo(
  (ownerId: string) => `countRequirementsForOwner:${ownerId}`,
  LIST_TTL_MS,
  async (ownerId: string): Promise<number> => {
    try {
      // 快路径：单条带子查询的 COUNT，取代「查项目 + countMany」两趟。
      const rows = await db.queryRaw<{ n: string }>(
        "requirements",
        OWNER_COUNT_SQL,
        { owner: ownerId }
      );
      return Number(rows[0]?.n ?? 0);
    } catch {
      // 回落：不支持 queryRaw 的后端。
      const owned = await listProjects(ownerId);
      const ids = owned.map((p) => p.id);
      if (ids.length === 0) return 0;
      return db.countMany("requirements", {
        projectId: { in: ids },
        archived_at: { isNull: true },
      });
    }
  }
);

/** 列表缓存失效。写操作（创建/删除/更新/步骤变更）后调用。 */
export function invalidateRequirementsCache(): void {
  invalidateCache("listRequirements:*");
  invalidateCache("listRequirementsForOwner:*");
  invalidateCache("countRequirementsForOwner:*");
  invalidateCache("getRequirementWithStatus:*");
  invalidateCache("listOutputs:*");
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

export const getRequirementWithStatus = memo(
  (id: string) => `getRequirementWithStatus:${id}`,
  LIST_TTL_MS,
  async (id: string): Promise<Requirement | undefined> => {
    const req = await getRequirement(id);
    if (!req) return undefined;
    return (await attachDerivedStatus([req]))[0];
  }
);

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
  // 写后失效缓存（让 listRequirements / getRequirementWithStatus 立即读到新值）
  invalidateRequirementsCache();
}

export async function getRequirement(id: string): Promise<Requirement | undefined> {
  return db.get<Requirement>("requirements", id);
}

/** 刷新需求的「最近更新时间」（如每次对话轮次结束后调用）。 */
export async function touchRequirement(id: string): Promise<void> {
  await db.update("requirements", id, { updatedAt: new Date().toISOString() });
  // 写后失效缓存（updatedAt 变化会影响 list 排序）
  invalidateRequirementsCache();
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
  "dev_contexts",
  "dev_context_versions",
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
//
// 注意：不再用「用户原话前 500 字 + 其余字段写『待补充』」的退化实现——
// 那会把未填写字段写成占位串污染卡片、且无法抽取目标用户/痛点等结构化信息。
// 改为走整段对话的 AI 抽取（extractCardFromConversation），与对话过程的渐进抽取一致。
export async function generateCard(id: string): Promise<RequirementCard> {
  const merged = await extractCardFromConversation(id);
  // 手动「生成/重新生成卡片」视为一次定版：冻结为新版本并记录摘要。
  await finalizeCardVersion(id, "AI 抽取生成卡片").catch(() => {});
  return merged;
}

// 渐进抽取需求卡片：把整段对话交给专门的 extract-card prompt 压缩为结构化卡片，
// 再经 mergeRequirementCard 增量合并（只填非空、覆盖已有值，支持逐步完善与纠正）。
// 用作对话过程中自动写回卡片的可靠路径，弥补「模型在回复里夹带 JSON 卡片块」的不稳定。
// 返回合并后的完整卡片（AI 无有效输出时原样返回库内现有卡片）。
export async function extractCardFromConversation(id: string): Promise<RequirementCard> {
  const card = await extractCard(id);
  if (card && Object.keys(card).length) {
    return mergeRequirementCard(id, card);
  }
  const req = await getRequirement(id);
  return (req?.card ?? { ...EMPTY_CARD });
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
