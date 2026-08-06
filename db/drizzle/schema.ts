// AskBuddy 数据库的【机器事实源】。drizzle-kit 从本文件生成迁移 SQL。
//
// 【与 db/schema.sql 的关系】
//   db/schema.sql        人读基线，带完整设计意图注释，不被任何程序执行
//   db/drizzle/schema.ts 机器事实源（本文件），drizzle-kit generate 的输入
// 两者必须逐列一致，由 scripts/check-db-contract.ts 在 CI 中校验。
// 改结构时的顺序：先改本文件 → npm run db:generate → 同步更新 db/schema.sql 的注释
// → 同步更新 lib/db/field-map.ts 的三张映射表。
//
// 【AD-1】本文件只被 lib/db/** 与 db/** 引用；lib/services/** 与 app/** 禁止 import。
//
// 【类型选型的三条硬约束】（详见 db/schema.sql 文首）
//   1. 时间列一律 timestamp({ withTimezone: true })，读出由 lib/db/postgres.ts 转 ISO 字符串
//   2. 布尔语义列用 smallint 而非 boolean —— 代码写 1/0、读 !!x，改 boolean 会破坏三后端等价
//   3. 灵活结构一律 jsonb；代码键的 camelCase 漂移由 lib/db/field-map.ts 消化，不在这里迁就

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** 所有时间列的统一定义，避免逐列重复写 withTimezone。 */
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// ---------------------------------------------------------------------------
// 项目
// ---------------------------------------------------------------------------
export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    // CloudBase Auth uid（当前恒为 mock-user-001）
    ownerId: text("owner_id").notNull(),
    status: text("status").notNull().default("active"),
    // 预留团队层级（代码从不写）
    teamId: text("team_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => ({
    // 部分索引的 WHERE 直接对应代码里的 !r.deleted_at 过滤
    idxOwner: index("idx_projects_owner")
      .on(t.ownerId, t.status)
      .where(sql`deleted_at IS NULL`),
    ckStatus: check("ck_projects_status", sql`${t.status} IN ('active', 'archived')`),
  })
);

// ---------------------------------------------------------------------------
// 需求（一等公民）
// ---------------------------------------------------------------------------
// 注意：没有 status 列。需求阶段是【派生值】，唯一事实源是 requirement_steps.state
// （派生逻辑见 lib/stage.ts:deriveRequirementStatus）。历史上的 status 列自创建后
// 从不更新（写死 'dialoguing'），已于 M1 移除。归档状态由 archived_at 表达。
export const requirements = pgTable(
  "requirements",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      // RESTRICT 而非 CASCADE：防止误删项目连带删光其下所有需求
      .references(() => projects.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    titleSource: text("title_source"),
    priority: text("priority"),
    tags: jsonb("tags"),
    category: text("category"),
    /** 关联需求 id 列表 */
    relatedIds: jsonb("related_ids"),
    /** 结构化需求卡片（六字段） */
    card: jsonb("card").notNull(),
    currentVersion: integer("current_version").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    archivedAt: ts("archived_at"),
  },
  (t) => ({
    idxProject: index("idx_req_project")
      .on(t.projectId, t.updatedAt.desc())
      .where(sql`archived_at IS NULL`),
    ckTitleSource: check(
      "ck_req_title_source",
      sql`${t.titleSource} IS NULL OR ${t.titleSource} IN ('manual', 'auto')`
    ),
    ckPriority: check(
      "ck_req_priority",
      sql`${t.priority} IS NULL OR ${t.priority} IN ('low', 'medium', 'high')`
    ),
  })
);

// ---------------------------------------------------------------------------
// 对话记录（仅追加）
// ---------------------------------------------------------------------------
// id 由代码显式写入 Date.now()（lib/services/conversations.ts:35），不是自增序列。
// mode: "number" 让 drizzle 侧按数字处理；驱动层的 int8→string 由
// lib/db/postgres.ts 的 BIGINT_COLS 统一转换。
export const conversations = pgTable(
  "conversations",
  {
    id: bigint("id", { mode: "number" }).primaryKey(),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    /** { references: [...] }、模型与 token 用量 */
    meta: jsonb("meta"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    idxReq: index("idx_conv_req").on(t.requirementId, t.id),
    ckRole: check("ck_conv_role", sql`${t.role} IN ('user', 'assistant', 'system')`),
  })
);

// ---------------------------------------------------------------------------
// 步骤完成度（四步工作流的唯一事实源）
// ---------------------------------------------------------------------------
// id 是代码生成的 UUID 字符串（lib/services/steps.ts:15），不是自增整数。
export const requirementSteps = pgTable(
  "requirement_steps",
  {
    id: text("id").primaryKey(),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    step: text("step").notNull(),
    /** [暂不使用] 内容完整度，后续独立功能 */
    completion: text("completion").notNull().default("full"),
    state: text("state").notNull().default("not_started"),
    /** 确认闸门：1 = 待用户手动确认进入下一阶段 */
    awaitingConfirm: smallint("awaiting_confirm").notNull().default(0),
    note: text("note"),
    outputVersion: integer("output_version"),
    completedAt: ts("completed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    // 唯一索引而非普通索引：updateWhere({requirement_id, step}) 依赖这组键唯一定位
    uqStep: uniqueIndex("uq_step").on(t.requirementId, t.step),
    ckStep: check(
      "ck_step_name",
      sql`${t.step} IN ('dialoguing', 'research_analysis', 'design', 'prd_writing')`
    ),
    ckCompletion: check(
      "ck_step_completion",
      sql`${t.completion} IN ('full', 'brief', 'skip')`
    ),
    ckState: check(
      "ck_step_state",
      sql`${t.state} IN ('not_started', 'in_progress', 'done', 'pending_update')`
    ),
  })
);

// ---------------------------------------------------------------------------
// 需求卡片版本历史
// ---------------------------------------------------------------------------
export const cardVersions = pgTable(
  "card_versions",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    card: jsonb("card").notNull(),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uqVer: unique("uq_card_ver").on(t.requirementId, t.version),
    idxReq: index("idx_card_ver_req").on(t.requirementId, t.version),
  })
);

// ---------------------------------------------------------------------------
// 调研分析模块（当前态，合并调研 + 分析）
// ---------------------------------------------------------------------------
// 冗余 id 列（恒等于 requirement_id）的存在理由见 db/schema.sql 附录 A：
// MCP 路径绕过 getOutput() 直接 db.get(table, id) 用默认 idKey="id"。
export const researchAnalysis = pgTable(
  "research_analysis",
  {
    requirementId: text("requirement_id")
      .primaryKey()
      .references(() => requirements.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    /** 调研框架（代码从不写，保留为已规划能力） */
    framework: jsonb("framework"),
    /** [{title,url,snippet,source}]（代码从不写） */
    materials: jsonb("materials"),
    /** 调研报告 / 洞察摘要 */
    report: text("report"),
    /** [{role,goal,reason}] */
    userStories: jsonb("user_stories"),
    /** [{name,desc,priority,module}] */
    features: jsonb("features"),
    sourceConversationId: bigint("source_conversation_id", { mode: "number" }),
    upstreamIds: jsonb("upstream_ids"),
    maybeStale: smallint("maybe_stale").notNull().default(0),
    currentVersion: integer("current_version").notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uqId: unique("uq_research_analysis_id").on(t.id),
  })
);

export const researchAnalysisVersions = pgTable(
  "research_analysis_versions",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    report: text("report"),
    userStories: jsonb("user_stories"),
    features: jsonb("features"),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uqVer: unique("uq_ra_ver").on(t.requirementId, t.version),
    idxReq: index("idx_ra_ver_req").on(t.requirementId, t.version),
  })
);

// ---------------------------------------------------------------------------
// 方案模块（当前态）
// ---------------------------------------------------------------------------
export const solutions = pgTable(
  "solutions",
  {
    requirementId: text("requirement_id")
      .primaryKey()
      .references(() => requirements.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    doc: text("doc"),
    upstreamIds: jsonb("upstream_ids"),
    maybeStale: smallint("maybe_stale").notNull().default(0),
    currentVersion: integer("current_version").notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uqId: unique("uq_solutions_id").on(t.id),
  })
);

export const solutionVersions = pgTable(
  "solution_versions",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    doc: text("doc"),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uqVer: unique("uq_sol_ver").on(t.requirementId, t.version),
    idxReq: index("idx_sol_ver_req").on(t.requirementId, t.version),
  })
);

// ---------------------------------------------------------------------------
// 原型（当前态）
// ---------------------------------------------------------------------------
// 字段名说明：原 cos_key 已更名 html_storage_key，与代码保持一致
// （代码侧 14 处引用 html_storage_key，0 处引用 cos_key）。
export const prototypes = pgTable(
  "prototypes",
  {
    requirementId: text("requirement_id")
      .primaryKey()
      .references(() => requirements.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    /** 页面结构 */
    structure: jsonb("structure"),
    /** 原型 HTML 的存储 key，形如 proto-html/v3/<rid> */
    htmlStorageKey: text("html_storage_key"),
    /** 代码 prototypes.ts:103 写入，与 current_version 同值 */
    version: integer("version"),
    /** 生成所用模型标识 */
    model: text("model"),
    currentVersion: integer("current_version").notNull().default(0),
    upstreamIds: jsonb("upstream_ids"),
    maybeStale: smallint("maybe_stale").notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uqId: unique("uq_prototypes_id").on(t.id),
  })
);

// id 是代码写入的复合串 `${requirement_id}-v${version}`（prototypes.ts:89），
// 不能改为自增 —— getPrototypeHtml / restoreVersion 直接用它 db.get。
export const prototypeVersions = pgTable(
  "prototype_versions",
  {
    id: text("id").primaryKey(),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    structure: jsonb("structure"),
    htmlStorageKey: text("html_storage_key").notNull(),
    model: text("model"),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uqVer: unique("uq_proto_ver").on(t.requirementId, t.version),
    idxReq: index("idx_proto_ver_req").on(t.requirementId, t.version),
  })
);

// ---------------------------------------------------------------------------
// PRD（当前态）
// ---------------------------------------------------------------------------
// 原 cos_key（导出 docx 的 COS key）已删除：PRD 导出当前为前端即时生成下载。
// 若未来支持服务端导出，新增 export_storage_key（命名与 prototypes.html_storage_key 对齐）。
export const prds = pgTable(
  "prds",
  {
    requirementId: text("requirement_id")
      .primaryKey()
      .references(() => requirements.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    markdown: text("markdown"),
    currentVersion: integer("current_version").notNull().default(0),
    upstreamIds: jsonb("upstream_ids"),
    maybeStale: smallint("maybe_stale").notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uqId: unique("uq_prds_id").on(t.id),
  })
);

export const prdVersions = pgTable(
  "prd_versions",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    markdown: text("markdown"),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uqVer: unique("uq_prd_ver").on(t.requirementId, t.version),
    idxReq: index("idx_prd_ver_req").on(t.requirementId, t.version),
  })
);

// ---------------------------------------------------------------------------
// API Token（PAT）
// ---------------------------------------------------------------------------
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** 代码 tokens.ts:66 写入，原 schema 缺失 */
    keyPreview: text("key_preview"),
    /** 技术债：代码从不更新此列 */
    lastUsedAt: ts("last_used_at"),
    /** NULL 表示永不过期 */
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
  },
  (t) => ({
    idxUser: index("idx_token_user").on(t.userId).where(sql`revoked_at IS NULL`),
    // Bearer 鉴权热路径 db.get("api_tokens", hash, "token_hash") 依赖此唯一索引
    uqHash: uniqueIndex("uq_token_hash").on(t.tokenHash),
  })
);

// ---------------------------------------------------------------------------
// 原型分享令牌
// ---------------------------------------------------------------------------
export const shareTokens = pgTable(
  "share_tokens",
  {
    /** token 本身（randomBytes(16).hex，32 字符） */
    id: text("id").primaryKey(),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    type: text("type").notNull().default("prototype"),
    createdAt: ts("created_at").notNull().defaultNow(),
    /** NULL = 永不过期 */
    expiresAt: ts("expires_at"),
  },
  (t) => ({
    idxReq: index("idx_share_req").on(t.requirementId, t.type, t.createdAt.desc()),
    ckType: check("ck_share_type", sql`${t.type} IN ('prototype')`),
  })
);

// ---------------------------------------------------------------------------
// 通用对象存储回落表
// ---------------------------------------------------------------------------
// COS 未配置时（当前 CloudBase 环境未开通 COS），原型 HTML 等大文本落在此表。
export const objects = pgTable("objects", {
  /** 存储 key，如 proto-html/v3/<requirement_id> */
  id: text("id").primaryKey(),
  /** 与 id 同值（lib/storage.ts:25 双写，保留以免读侧漂移） */
  key: text("key").notNull(),
  content: text("content").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
