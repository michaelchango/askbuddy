// 代码键 ⇄ PostgreSQL 列名 的双向映射与列类型元数据。
//
// 【为什么需要这一层】
// NoSQL 是 schema-less，字段名写错只是多一个无人读的字段，静默通过；
// PG 会直接 `ERROR: column "requirementId" of relation "conversations" does not exist`。
// 历史代码在 projects / requirements 两张表上写的是 camelCase（ownerId / createdAt /
// projectId / titleSource…），其余 14 张表写的是 snake_case。为了让业务代码零改动
// （AD-1 硬约束），差异在这里一次性消化。
//
// 【维护约定】
// 1. 本文件是「代码实际读写的键」的唯一声明处。新增字段必须同时改这里、
//    db/drizzle/schema.ts 和 db/schema.sql，由 scripts/check-db-contract.ts 校验。
// 2. FIELD_MAP 必须列全每张表的所有代码键（含与列名同名的），因为
//    lib/db/postgres.ts 的 toColumns() 遇到不在映射里的键会【抛错】而不是静默丢弃。
//    这是把「字段契约漂移」从上线后的随机 500 提前到开发期硬报错的关键。
// 3. 勘定依据见 docs/ops/db-field-audit.md。

/** 16 张在用表。不在此集合内的表名一律拒绝（PG 无 NoSQL 的自动建集合魔法）。 */
export const TABLES: ReadonlySet<string> = new Set([
  "projects",
  "requirements",
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
  "api_tokens",
  "share_tokens",
  "objects",
  "dev_contexts",
  "dev_context_versions",
]);

/** 代码键 → PG 列名。同名项也必须显式列出（见维护约定 2）。 */
export const FIELD_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // ⚠️ camelCase 漂移表之一：ownerId / createdAt / updatedAt 是 camel，deleted_at 是 snake
  projects: {
    id: "id",
    name: "name",
    description: "description",
    ownerId: "owner_id",
    status: "status",
    team_id: "team_id", // 代码从不写，保持与 schema 同名
    createdAt: "created_at",
    updatedAt: "updated_at",
    deleted_at: "deleted_at", // archiveProject 写的就是 snake
  },

  // ⚠️ camelCase 漂移表之二。注意：没有 status 列（M1 T9 移除，阶段是派生值）
  requirements: {
    id: "id",
    projectId: "project_id",
    title: "title",
    titleSource: "title_source",
    priority: "priority", // 代码从不写
    tags: "tags", // 代码从不写
    category: "category", // 代码从不写
    related_ids: "related_ids", // 代码从不写
    card: "card",
    current_version: "current_version",
    createdAt: "created_at",
    updatedAt: "updated_at",
    archived_at: "archived_at",
  },

  conversations: {
    id: "id",
    requirement_id: "requirement_id",
    role: "role",
    content: "content",
    meta: "meta",
    created_at: "created_at",
  },

  requirement_steps: {
    id: "id",
    requirement_id: "requirement_id",
    step: "step",
    completion: "completion", // [暂不使用]
    state: "state",
    awaiting_confirm: "awaiting_confirm",
    note: "note",
    output_version: "output_version",
    completed_at: "completed_at",
    created_at: "created_at",
    updated_at: "updated_at",
  },

  card_versions: {
    id: "id", // BIGINT IDENTITY，代码从不写
    requirement_id: "requirement_id",
    version: "version",
    card: "card",
    note: "note",
    created_at: "created_at",
  },

  research_analysis: {
    id: "id", // 冗余列，恒等于 requirement_id
    requirement_id: "requirement_id",
    framework: "framework", // 代码从不写
    materials: "materials", // 代码从不写
    report: "report",
    user_stories: "user_stories",
    features: "features",
    source_conversation_id: "source_conversation_id",
    upstream_ids: "upstream_ids",
    maybe_stale: "maybe_stale",
    current_version: "current_version",
    updated_at: "updated_at",
  },

  research_analysis_versions: {
    id: "id", // BIGINT IDENTITY，代码从不写
    requirement_id: "requirement_id",
    version: "version",
    report: "report",
    user_stories: "user_stories",
    features: "features",
    note: "note",
    created_at: "created_at",
  },

  solutions: {
    id: "id", // 冗余列
    requirement_id: "requirement_id",
    doc: "doc",
    upstream_ids: "upstream_ids",
    maybe_stale: "maybe_stale",
    current_version: "current_version",
    updated_at: "updated_at",
  },

  solution_versions: {
    id: "id", // BIGINT IDENTITY，代码从不写
    requirement_id: "requirement_id",
    version: "version",
    doc: "doc",
    note: "note",
    created_at: "created_at",
  },

  prototypes: {
    id: "id", // 冗余列
    requirement_id: "requirement_id",
    structure: "structure",
    html_storage_key: "html_storage_key", // 原 schema 名为 cos_key，M1 以代码为准更名
    version: "version",
    model: "model",
    current_version: "current_version",
    upstream_ids: "upstream_ids",
    maybe_stale: "maybe_stale",
    updated_at: "updated_at",
  },

  prototype_versions: {
    id: "id", // TEXT，值为 `${requirement_id}-v${version}`
    requirement_id: "requirement_id",
    version: "version",
    structure: "structure",
    html_storage_key: "html_storage_key",
    model: "model",
    note: "note", // 代码从不写
    created_at: "created_at",
  },

  prds: {
    id: "id", // 冗余列
    requirement_id: "requirement_id",
    markdown: "markdown",
    current_version: "current_version",
    upstream_ids: "upstream_ids",
    maybe_stale: "maybe_stale",
    updated_at: "updated_at",
  },

  prd_versions: {
    id: "id", // BIGINT IDENTITY，代码从不写
    requirement_id: "requirement_id",
    version: "version",
    markdown: "markdown",
    note: "note",
    created_at: "created_at",
  },

  api_tokens: {
    id: "id",
    user_id: "user_id",
    name: "name",
    token_hash: "token_hash",
    key_preview: "key_preview",
    last_used_at: "last_used_at", // 技术债：代码从不更新
    expires_at: "expires_at",
    created_at: "created_at",
    revoked_at: "revoked_at",
  },

  share_tokens: {
    id: "id",
    requirement_id: "requirement_id",
    type: "type",
    created_at: "created_at",
    expires_at: "expires_at",
  },

  objects: {
    id: "id",
    key: "key",
    content: "content",
    created_at: "created_at",
    updated_at: "updated_at",
  },

  // 开发上下文（机器读产物）。与 prds/solutions 同惯例，代码键用 snake_case。
  dev_contexts: {
    requirement_id: "requirement_id",
    content: "content",
    completeness_score: "completeness_score",
    status: "status",
    current_version: "current_version",
    applicable_count: "applicable_count",
    present_count: "present_count",
    upstream_ids: "upstream_ids",
    maybe_stale: "maybe_stale",
    generated_by: "generated_by",
    updated_at: "updated_at",
  },

  dev_context_versions: {
    id: "id", // TEXT，值为 `${requirement_id}-v${version}`
    requirement_id: "requirement_id",
    version: "version",
    content: "content",
    completeness_score: "completeness_score",
    status: "status",
    changelog: "changelog",
    note: "note",
    created_at: "created_at",
  },
};

/** PG 列名 → 代码键（由 FIELD_MAP 反转，构建期一次性生成）。 */
export const REVERSE_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.fromEntries(
    Object.entries(FIELD_MAP).map(([table, map]) => [
      table,
      Object.fromEntries(Object.entries(map).map(([code, col]) => [col, code])),
    ])
  );

/**
 * TIMESTAMPTZ 列（列名口径）。读出时统一 .toISOString() 转字符串。
 * 原因：代码全链路把时间当字符串用，含 `a.created_at < b.created_at` 字典序比较。
 * 若驱动返回 Date 对象，字典序比较会退化为 `[object Date] < [object Date]`（恒 false），
 * 排序静默错乱且不报错 —— 这是最难查的一类 bug。
 */
export const TIMESTAMP_COLS: Readonly<Record<string, readonly string[]>> = {
  projects: ["created_at", "updated_at", "deleted_at"],
  requirements: ["created_at", "updated_at", "archived_at"],
  conversations: ["created_at"],
  requirement_steps: ["completed_at", "created_at", "updated_at"],
  card_versions: ["created_at"],
  research_analysis: ["updated_at"],
  research_analysis_versions: ["created_at"],
  solutions: ["updated_at"],
  solution_versions: ["created_at"],
  prototypes: ["updated_at"],
  prototype_versions: ["created_at"],
  prds: ["updated_at"],
  prd_versions: ["created_at"],
  api_tokens: ["last_used_at", "expires_at", "created_at", "revoked_at"],
  share_tokens: ["created_at", "expires_at"],
  objects: ["created_at", "updated_at"],
  dev_contexts: ["updated_at"],
  dev_context_versions: ["created_at"],
};

/**
 * JSONB 列（列名口径）。写入时 JSON.stringify 后作为「未指定类型」参数下发，
 * 由 PG 依列类型解析为 jsonb（避免 postgres.js 把 JS 数组误判为 PG 数组）。
 * 读出时 postgres.js 已自动解析为 JS 对象，无需处理。
 */
export const JSONB_COLS: Readonly<Record<string, readonly string[]>> = {
  projects: [],
  requirements: ["tags", "related_ids", "card"],
  conversations: ["meta"],
  requirement_steps: [],
  card_versions: ["card"],
  research_analysis: [
    "framework",
    "materials",
    "user_stories",
    "features",
    "upstream_ids",
  ],
  research_analysis_versions: ["user_stories", "features"],
  solutions: ["upstream_ids"],
  solution_versions: [],
  prototypes: ["structure", "upstream_ids"],
  prototype_versions: ["structure"],
  prds: ["upstream_ids"],
  prd_versions: [],
  api_tokens: [],
  share_tokens: [],
  objects: [],
  dev_contexts: ["content", "upstream_ids"],
  dev_context_versions: ["content", "changelog"],
};

/**
 * BIGINT 列（列名口径）。postgres.js 默认把 int8 返回为【字符串】以防精度丢失，
 * 但代码把它们当数字用（如 conversations 的 `a.id - b.id` 排序），
 * 故在 toRow 中统一转 Number。取值范围（Date.now() ≈ 1.7e12、自增序列）
 * 远小于 Number.MAX_SAFE_INTEGER（9e15），转换安全。
 */
export const BIGINT_COLS: Readonly<Record<string, readonly string[]>> = {
  projects: [],
  requirements: [],
  conversations: ["id"],
  requirement_steps: [],
  card_versions: ["id"],
  research_analysis: ["source_conversation_id"],
  research_analysis_versions: ["id"],
  solutions: [],
  solution_versions: ["id"],
  prototypes: [],
  prototype_versions: [],
  prds: [],
  prd_versions: ["id"],
  api_tokens: [],
  share_tokens: [],
  objects: [],
  dev_contexts: ["requirement_id"],
  dev_context_versions: ["id"],
};

/**
 * db.get(table, id, idKey) 允许的 idKey 白名单（代码键口径）。
 * 作用有二：
 *   1. idKey 会被拼进 SQL 的标识符位置，白名单是注入防线的第二道保险；
 *   2. 未来若有人写出 db.get(t, x, "userId") 这类漂移，开发期立刻抛错，
 *      而不是上线后变成一条没有索引的慢查询。
 * 白名单内的列必须都有 PRIMARY KEY 或 UNIQUE 索引（由 scripts/check-db-contract.ts 校验）。
 */
export const ALLOWED_ID_KEYS: Readonly<Record<string, readonly string[]>> = {
  projects: ["id"],
  requirements: ["id"],
  conversations: ["id"],
  requirement_steps: ["id"],
  card_versions: ["id"],
  research_analysis: ["id", "requirement_id"],
  research_analysis_versions: ["id"],
  solutions: ["id", "requirement_id"],
  solution_versions: ["id"],
  prototypes: ["id", "requirement_id"],
  prototype_versions: ["id"],
  prds: ["id", "requirement_id"],
  prd_versions: ["id"],
  api_tokens: ["id", "token_hash"], // token_hash 是 Bearer 鉴权热路径，有 UNIQUE 索引
  share_tokens: ["id"],
  objects: ["id"],
  dev_contexts: ["requirement_id"],       // requirement_id 是 PRIMARY KEY
  dev_context_versions: ["id"],            // id 是 PRIMARY KEY（复合 id 惯例）
};

/**
 * db.list 的默认排序列（列名口径）。
 * 作用：把 mock 后端的「插入序」在 PG 上复现，消除三后端之间的排序不确定性。
 * 这是 P1 唯一超出「逐字节等价」的部分 —— NoSQL 本就是无序返回，属于隐性不确定性。
 */
export const ORDER_HINT: Readonly<Record<string, string | undefined>> = {
  projects: "created_at",
  requirements: "created_at",
  conversations: "id",
  requirement_steps: "created_at",
  card_versions: "id",
  research_analysis: "requirement_id",
  research_analysis_versions: "id",
  solutions: "requirement_id",
  solution_versions: "id",
  prototypes: "requirement_id",
  prototype_versions: "created_at",
  prds: "requirement_id",
  prd_versions: "id",
  api_tokens: "created_at",
  share_tokens: "created_at",
  objects: "created_at",
  dev_contexts: "updated_at",
  dev_context_versions: "created_at",
};
