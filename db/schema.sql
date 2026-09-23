-- ============================================================
-- AskBuddy Database Schema (PostgreSQL 14+)
-- 腾讯云 CloudBase PostgreSQL（环境 askbuddy-*）
--
-- 【本文件的定位】人读基线，不被任何程序执行。
--   机器事实源是 db/drizzle/schema.ts，迁移由 drizzle-kit 从它生成。
--   两者必须保持一致，由 scripts/check-db-contract.ts 在 CI 中校验。
--
-- 约定：
--   1. 标识符统一 snake_case；代码侧的 camelCase 键由 lib/db/field-map.ts 双向映射。
--   2. id 列一律 TEXT（代码实为 crypto.randomUUID() / `${rid}-v{n}` 复合串，
--      原 MySQL 的 CHAR(20) 早已装不下）。PG 的 TEXT 与 VARCHAR(n) 性能相同。
--   3. 时间列一律 TIMESTAMPTZ（保留 SQL 排序 / 索引 / 范围查询能力，P2 下推必需）；
--      lib/db/postgres.ts 的 toRow() 在读出时统一 .toISOString() 转回字符串，
--      因为代码全链路把时间当【字符串】用（含 a.created_at < b.created_at 字典序比较）。
--   4. 布尔语义列（maybe_stale / awaiting_confirm）用 SMALLINT 而非 BOOLEAN，
--      因为代码写 1/0 数字、读 !!r.awaiting_confirm；用 BOOLEAN 会破坏三后端语义等价。
--   5. 原 MySQL 的 ENUM 一律降级为 TEXT + CHECK 约束（PG 原生 ENUM 加值需 ALTER TYPE，
--      对迭代不友好）。
--   6. 软删除统一 deleted_at / archived_at / revoked_at；灵活结构用 JSONB。
--   7. 血缘：upstream_ids 记录来源；maybe_stale 标记可能过期。
--
-- 【M1 变更摘要】（相对 MySQL 版本）
--   - 删除废弃表：research、analysis、webhook_configs（代码 0 引用）
--   - 删除 ai_tasks 实体，仅留注释占位（D6：异步任务不实现）
--   - 新增 share_tokens、objects（代码在用，原 schema 完全缺失）
--   - requirements 删除 status 列（僵尸列，唯一事实源是 requirement_steps.state）
--   - requirements 新增 title_source；api_tokens 新增 key_preview
--   - prototypes/prototype_versions 的 cos_key 改名 html_storage_key，并补 version/model
--   - prds/prd_versions 删除恒空的 cos_key
--   - research_analysis / solutions / prototypes / prds 增加冗余 id 列（见文末说明）
--
-- 【向量检索说明】
--   本 CloudBase 环境已提供 pgvector 扩展（用户决策 M1 收尾启用真向量检索）。
--   建库脚本 scripts/db-setup-cloudbase.ts 已 CREATE EXTENSION vector。
--   embedding 列（M4 knowledge_entries 等）用 vector(N) 存储；相似度由
--   lib/db/{postgres,cloudbase}.ts 的 searchVector 经 1 - (col <=> $q::vector)
--   在 SQL 层下推，业务零改动。维度不可逆，建表前用 verify:embedding 实测确认。
-- ============================================================


-- ---------------- 项目 ----------------
CREATE TABLE projects (
  id          TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  description TEXT        NULL,
  owner_id    TEXT        NOT NULL,          -- CloudBase Auth uid（当前恒为 mock-user-001）
  status      TEXT        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'archived')),
  team_id     TEXT        NULL,              -- 预留团队层级（代码从不写）
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ NULL,
  CONSTRAINT pk_projects PRIMARY KEY (id)
);
-- T1（Auth+RLS）落地时在此追加 policy；M1 不启用 RLS，否则 mock-user-001 会被策略挡死。


-- ---------------- 需求（一等公民） ----------------
CREATE TABLE requirements (
  id              TEXT        NOT NULL,
  project_id      TEXT        NOT NULL,
  title           TEXT        NOT NULL,
  title_source    TEXT        NULL              -- 代码写入 'manual'(用户改名)/'auto'(自动概括)；类型 TitleSource="auto"|"manual"|null（lib/services/requirements.ts:264/278）
                    CONSTRAINT ck_req_title_source CHECK (title_source IS NULL OR title_source IN ('manual', 'auto')),
  -- 注意：不设 status 列。需求阶段是【派生值】，唯一事实源是 requirement_steps.state。
  -- 派生逻辑见 lib/stage.ts:deriveRequirementStatus。
  -- 历史上这里有一个 ENUM 列，但它自创建后从不更新（写死 'dialoguing'），已于 M1 移除。
  -- 归档状态例外：由 requirements.archived_at IS NOT NULL 表达（见 stage.ts）。
  priority        TEXT        NULL
                    CHECK (priority IS NULL OR priority IN ('low', 'medium', 'high')),
  tags            JSONB       NULL,
  category        TEXT        NULL,
  related_ids     JSONB       NULL,             -- 关联需求 id 列表
  card            JSONB       NOT NULL,         -- 结构化需求卡片（六字段）
  current_version INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at     TIMESTAMPTZ NULL,
  CONSTRAINT pk_requirements PRIMARY KEY (id),
  CONSTRAINT fk_req_project FOREIGN KEY (project_id)
    REFERENCES projects(id) ON DELETE RESTRICT   -- 防误删项目连带删光需求
);


-- ---------------- 对话记录（仅追加） ----------------
-- 注意：id 由代码显式写入（Date.now()，见 conversations.ts:35），不是自增。
CREATE TABLE conversations (
  id              BIGINT      NOT NULL,
  requirement_id  TEXT        NOT NULL,
  role            TEXT        NOT NULL
                    CHECK (role IN ('user', 'assistant', 'system')),
  content         TEXT        NOT NULL,
  meta            JSONB       NULL,              -- { references: [...] }、模型与 token 用量
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_conversations PRIMARY KEY (id),
  CONSTRAINT fk_conv_req FOREIGN KEY (requirement_id)
    REFERENCES requirements(id) ON DELETE CASCADE
);


-- ---------------- 步骤完成度（四步工作流的唯一事实源） ----------------
-- 注意：id 是代码生成的 UUID 字符串（steps.ts:15 crypto.randomUUID()），不是自增整数。
CREATE TABLE requirement_steps (
  id               TEXT        NOT NULL,
  requirement_id   TEXT        NOT NULL,
  step             TEXT        NOT NULL
                     CHECK (step IN ('dialoguing', 'research_analysis', 'design', 'prd_writing')),
  completion       TEXT        NOT NULL DEFAULT 'full'   -- [暂不使用] 内容完整度，后续独立功能
                     CHECK (completion IN ('full', 'brief', 'skip')),
  state            TEXT        NOT NULL DEFAULT 'not_started'
                     CHECK (state IN ('not_started', 'in_progress', 'done', 'pending_update')),
  awaiting_confirm SMALLINT    NOT NULL DEFAULT 0,       -- 确认闸门：1=待用户手动确认进入下一阶段
  generating       SMALLINT    NOT NULL DEFAULT 0,       -- 生成中标记：1=该步骤产物正在生成（跨页面/会话持久化，退出页面后仍可恢复）
  design_sub_phase TEXT        NULL,                     -- design 步骤生成中的子阶段：'prototype'=交互原型生成中，NULL=方案文档生成中
  note             TEXT        NULL,
  output_version   INTEGER     NULL,
  completed_at     TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_requirement_steps PRIMARY KEY (id),
  CONSTRAINT fk_step_req FOREIGN KEY (requirement_id)
    REFERENCES requirements(id) ON DELETE CASCADE
);


-- ---------------- 需求卡片版本历史 ----------------
CREATE TABLE card_versions (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY,
  requirement_id TEXT        NOT NULL,
  version        INTEGER     NOT NULL,
  card           JSONB       NOT NULL,
  card_source    JSONB       NULL,              -- 字段级 _source（M3）：{ fieldName: Source }
  note           TEXT        NULL,
  changelog      JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- 结构化变更记录（M3）
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_card_versions PRIMARY KEY (id),
  CONSTRAINT uq_card_ver UNIQUE (requirement_id, version),
  CONSTRAINT fk_card_ver_req FOREIGN KEY (requirement_id)
    REFERENCES requirements(id) ON DELETE CASCADE
);


-- ---------------- 调研分析模块（当前态，合并调研+分析）----------------
CREATE TABLE research_analysis (
  requirement_id         TEXT        NOT NULL,
  id                     TEXT        NOT NULL,   -- 冗余列，恒等于 requirement_id（见文末说明）
  framework              JSONB       NULL,       -- 调研框架（代码从不写，保留为已规划能力）
  materials              JSONB       NULL,       -- [{title,url,snippet,source}]（代码从不写）
  report                 TEXT        NULL,       -- 调研报告 / 洞察摘要
  user_stories           JSONB       NULL,       -- [{role,goal,reason}]
  features               JSONB       NULL,       -- [{name,desc,priority,module}]
  source_conversation_id BIGINT      NULL,
  upstream_ids           JSONB       NULL,
  maybe_stale            SMALLINT    NOT NULL DEFAULT 0,
  current_version        INTEGER     NOT NULL DEFAULT 0,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_research_analysis PRIMARY KEY (requirement_id),
  CONSTRAINT uq_research_analysis_id UNIQUE (id),
  CONSTRAINT fk_ra_req FOREIGN KEY (requirement_id)
    REFERENCES requirements(id) ON DELETE CASCADE
);

-- ---------------- 调研分析版本历史 ----------------
CREATE TABLE research_analysis_versions (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY,
  requirement_id TEXT        NOT NULL,
  version        INTEGER     NOT NULL,
  report         TEXT        NULL,
  user_stories   JSONB       NULL,
  features       JSONB       NULL,
  note           TEXT        NULL,
  changelog      JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- 结构化变更记录（M3）
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_research_analysis_versions PRIMARY KEY (id),
  CONSTRAINT uq_ra_ver UNIQUE (requirement_id, version),
  CONSTRAINT fk_ra_ver_req FOREIGN KEY (requirement_id)
    REFERENCES requirements(id) ON DELETE CASCADE
);


-- ---------------- 方案模块（当前态） ----------------
CREATE TABLE solutions (
  requirement_id  TEXT        NOT NULL,
  id              TEXT        NOT NULL,          -- 冗余列，恒等于 requirement_id（见文末说明）
  doc             TEXT        NULL,
  upstream_ids    JSONB       NULL,
  maybe_stale     SMALLINT    NOT NULL DEFAULT 0,
  current_version INTEGER     NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_solutions PRIMARY KEY (requirement_id),
  CONSTRAINT uq_solutions_id UNIQUE (id),
  CONSTRAINT fk_sol_req FOREIGN KEY (requirement_id)
    REFERENCES requirements(id) ON DELETE CASCADE
);

-- ---------------- 方案文档版本历史 ----------------
CREATE TABLE solution_versions (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY,
  requirement_id TEXT        NOT NULL,
  version        INTEGER     NOT NULL,
  doc            TEXT        NULL,
  note           TEXT        NULL,
  changelog      JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- 结构化变更记录（M3）
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_solution_versions PRIMARY KEY (id),
  CONSTRAINT uq_sol_ver UNIQUE (requirement_id, version),
  CONSTRAINT fk_sol_ver_req FOREIGN KEY (requirement_id)
    REFERENCES requirements(id) ON DELETE CASCADE
);


-- ---------------- 原型（当前态） ----------------
-- 字段名说明：原 cos_key 已更名 html_storage_key，与代码保持一致（代码侧 14 处引用
-- html_storage_key，0 处引用 cos_key）。语义是「通用对象存储 key」，当前落 objects 表。
CREATE TABLE prototypes (
  requirement_id   TEXT        NOT NULL,
  id               TEXT        NOT NULL,         -- 冗余列，恒等于 requirement_id（见文末说明）
  structure        JSONB       NULL,             -- 页面结构
  html_storage_key TEXT        NULL,             -- 原型 HTML 的存储 key，形如 proto-html/v3/<rid>
  version          INTEGER     NULL,             -- 代码 prototypes.ts:103 写入，与 current_version 同值
  model            TEXT        NULL,             -- 生成所用模型标识
  current_version  INTEGER     NOT NULL DEFAULT 0,
  upstream_ids     JSONB       NULL,
  maybe_stale      SMALLINT    NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_prototypes PRIMARY KEY (requirement_id),
  CONSTRAINT uq_prototypes_id UNIQUE (id),
  CONSTRAINT fk_proto_req FOREIGN KEY (requirement_id)
    REFERENCES requirements(id) ON DELETE CASCADE
);

-- ---------------- 原型版本历史 ----------------
-- 注意：id 是代码写入的复合串 `${requirement_id}-v${version}`（prototypes.ts:89），
-- 不能改为自增 —— getPrototypeHtml / restoreVersion 直接用它 db.get。
CREATE TABLE prototype_versions (
  id               TEXT        NOT NULL,
  requirement_id   TEXT        NOT NULL,
  version          INTEGER     NOT NULL,
  structure        JSONB       NULL,
  html_storage_key TEXT        NOT NULL,
  model            TEXT        NULL,
  note             TEXT        NULL,
  changelog      JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- 结构化变更记录（M3）
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_prototype_versions PRIMARY KEY (id),
  CONSTRAINT uq_proto_ver UNIQUE (requirement_id, version),
  CONSTRAINT fk_proto_ver_req FOREIGN KEY (requirement_id)
    REFERENCES requirements(id) ON DELETE CASCADE
);


-- ---------------- PRD（当前态） ----------------
-- 说明：原 cos_key（导出 docx 的 COS key）已删除。
-- PRD 导出当前为前端即时生成下载，不落对象存储；
-- 若未来支持服务端导出，请新增 export_storage_key TEXT（命名与 prototypes.html_storage_key 对齐）。
CREATE TABLE prds (
  requirement_id  TEXT        NOT NULL,
  id              TEXT        NOT NULL,          -- 冗余列，恒等于 requirement_id（见文末说明）
  markdown        TEXT        NULL,
  current_version INTEGER     NOT NULL DEFAULT 0,
  upstream_ids    JSONB       NULL,
  maybe_stale     SMALLINT    NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_prds PRIMARY KEY (requirement_id),
  CONSTRAINT uq_prds_id UNIQUE (id),
  CONSTRAINT fk_prd_req FOREIGN KEY (requirement_id)
    REFERENCES requirements(id) ON DELETE CASCADE
);

-- ---------------- PRD 版本历史 ----------------
-- 说明：原 cos_key 已删除，理由同 prds 表。
CREATE TABLE prd_versions (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY,
  requirement_id TEXT        NOT NULL,
  version        INTEGER     NOT NULL,
  markdown       TEXT        NULL,
  note           TEXT        NULL,
  changelog      JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- 结构化变更记录（M3）
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_prd_versions PRIMARY KEY (id),
  CONSTRAINT uq_prd_ver UNIQUE (requirement_id, version),
  CONSTRAINT fk_prd_ver_req FOREIGN KEY (requirement_id)
    REFERENCES requirements(id) ON DELETE CASCADE
);

-- ---------------- 开发上下文（机器读产物） ----------------
-- 一个需求一份，多段式 JSON 存 content。版本独立自增，不与 PRD 版本绑定（M2-D2）。
CREATE TABLE dev_contexts (
  requirement_id     TEXT        PRIMARY KEY REFERENCES requirements(id) ON DELETE CASCADE,
  content            JSONB       NOT NULL,              -- DevContextSchema 全量（含 meta / references）
  completeness_score NUMERIC(4,3) NOT NULL DEFAULT 0,   -- 冗余出列，便于列表页排序/筛选而不解 JSONB
  status             TEXT        NOT NULL DEFAULT 'draft'  CHECK (status IN ('draft','confirmed')),
  current_version    INTEGER     NOT NULL DEFAULT 0,
  applicable_count   INTEGER     NOT NULL DEFAULT 0,    -- 评分分母，冗余列
  present_count      INTEGER     NOT NULL DEFAULT 0,
  upstream_ids       JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- 与 prds/solutions 同惯例，供 M5 变更联动
  maybe_stale        SMALLINT    NOT NULL DEFAULT 0,            -- 同上
  generated_by       TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_devctx_score ON dev_contexts (completeness_score);

-- 版本快照（与 prd_versions / solution_versions 完全同构）
CREATE TABLE dev_context_versions (
  id             TEXT        PRIMARY KEY,          -- `${requirement_id}-v${version}`，沿用 prototype_versions 的复合 id 惯例
  requirement_id TEXT        NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  version        INTEGER     NOT NULL,
  content        JSONB       NOT NULL,
  completeness_score NUMERIC(4,3) NOT NULL DEFAULT 0,
  status         TEXT        NOT NULL DEFAULT 'draft',
  changelog      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  note           TEXT        NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (requirement_id, version)
);
CREATE INDEX idx_devctx_ver_req ON dev_context_versions (requirement_id, version DESC);


-- ============================================================
-- M3 · 条目级 HITL + 分级溯源
-- ============================================================

-- ---------------- 建议卡（AI 产出先落此表，pending 等待用户决策） ----------------
-- 一条 AI 建议 = 一次对用户产出的修改提议（add/modify/remove）。
-- 经 lib/services/proposals.ts 写入；用户 accept/edit/ignore 后才真正写库。
CREATE TABLE suggestions (
  id              TEXT        NOT NULL,
  requirement_id  TEXT        NOT NULL,
  target_type     TEXT        NOT NULL
                    CHECK (target_type IN ('research', 'solution', 'prototype', 'prd', 'dev_context')),
  target_path     TEXT        NULL,              -- 产物内定位路径（section.id / 字段名 / md anchor / page id）
  op              TEXT        NOT NULL
                    CHECK (op IN ('add', 'modify', 'remove')),
  payload         JSONB       NOT NULL,           -- 建议的具体内容（accept/edit 后成为产物数据）
  status          TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'edited', 'ignored')),
  source          JSONB       NULL,               -- 溯源（conversation_turn / knowledge_ids / confirmed_by / confirmed_at）
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_suggestions PRIMARY KEY (id),
  CONSTRAINT fk_sug_req FOREIGN KEY (requirement_id)
    REFERENCES requirements(id) ON DELETE CASCADE
);
CREATE INDEX idx_sug_req ON suggestions (requirement_id, status);

-- ---------------- 决策记录（每次 accept/edit/ignore 落一条） ----------------
-- ignore 仅记 history（summary='ignored'），不写任何产物（AD-4 红线）。
CREATE TABLE decisions (
  id               TEXT        NOT NULL,
  requirement_id   TEXT        NOT NULL,
  suggestion_id    TEXT        NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
  summary          TEXT        NULL,              -- 人类可读摘要（如 'ignored' / 'accepted: 新增扫码登录'）
  conversation_turn INTEGER    NULL,              -- 产生此建议的对话轮次（来自 conversations 序）
  confirmed_by     TEXT        NULL,              -- 确认人（M3 先用固定/会话身份）
  confirmed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_decisions PRIMARY KEY (id),
  CONSTRAINT fk_dec_req FOREIGN KEY (requirement_id)
    REFERENCES requirements(id) ON DELETE CASCADE
);
CREATE INDEX idx_dec_sug ON decisions (suggestion_id);
CREATE INDEX idx_dec_req ON decisions (requirement_id);

-- ---------------- MD 章节级溯源映射（正文保持纯净） ----------------
-- anchor → source 双向映射：渲染时按 h2 锚点查表，得到该章节的 _source。
-- target_type 覆盖 research / solution / prd（三种 Markdown 产物）。
CREATE TABLE doc_sections (
  id              TEXT        NOT NULL,
  requirement_id  TEXT        NOT NULL,
  target_type     TEXT        NOT NULL
                    CHECK (target_type IN ('research', 'solution', 'prd')),
  version         INTEGER     NULL,
  anchor          TEXT        NOT NULL,           -- markdown 章节锚点（h2 的 slug）
  title           TEXT        NULL,               -- 章节标题
  source          JSONB       NOT NULL,           -- 该章节的 _source
  CONSTRAINT pk_doc_sections PRIMARY KEY (id),
  CONSTRAINT fk_docsec_req FOREIGN KEY (requirement_id)
    REFERENCES requirements(id) ON DELETE CASCADE
);
CREATE INDEX idx_docsec_req ON doc_sections (requirement_id, target_type, version);


-- ============================================================
-- M4 · 知识复利（项目级知识库 + 语义检索）
-- ============================================================
-- 沉淀已确立的业务规则/术语/决策/约束，生成时经向量检索注入上下文并溯源。
-- 维度 1024 不可逆（R3 红线）：建表前已由 scripts/poc/embedding-probe.ts 实测
-- 混元 Embedding 返回维度 === EMBEDDING_DIMENSIONS（1024），留档后建表。
-- embedding 列用 vector(1024)，检索走 1 - (embedding <=> $q::vector) 余弦下推。

-- ---------------- 知识条目 ----------------
CREATE TABLE knowledge_entries (
  id                 TEXT        NOT NULL,
  project_id         TEXT        NOT NULL,
  title              TEXT        NOT NULL,
  content            TEXT        NOT NULL,
  embedding          vector(1024) NULL,            -- 语义向量（软删后置 NULL，禁参与检索）
  category           TEXT        NOT NULL DEFAULT 'rule'
                       CHECK (category IN ('rule', 'term', 'decision', 'constraint')),
  source_type        TEXT        NOT NULL DEFAULT 'manual'
                       CHECK (source_type IN ('manual', 'decision')),
  source_ref         TEXT        NULL,              -- 来源引用（如需求 id / 决策 id 的可读描述）
  source_decision_id TEXT        NULL,              -- 沉淀上游：M3 decisions.id（三道去重闸之一）
  source_hash        TEXT        NULL,              -- 内容去重指纹（sha256，normalize 后）
  status             TEXT        NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'deprecated')),
  access_count       INTEGER     NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_knowledge_entries PRIMARY KEY (id),
  CONSTRAINT fk_know_project FOREIGN KEY (project_id)
    REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX idx_know_project ON knowledge_entries (project_id, status, updated_at DESC);
CREATE INDEX idx_know_hash ON knowledge_entries (project_id, source_hash);
CREATE INDEX idx_know_decision ON knowledge_entries (source_decision_id)
  WHERE source_decision_id IS NOT NULL;
-- HNSW 向量索引：检索向量列，加快 topK 召回（pgvector 0.5+ 支持）。
-- 数据量较小时可不建，量级上来的再开；先注释留档，避免空表建索引无意义开销。
-- CREATE INDEX idx_know_embedding ON knowledge_entries USING hnsw (embedding vector_cosine_ops);


-- ---------------- API Token（PAT） ----------------
CREATE TABLE api_tokens (
  id           TEXT        NOT NULL,
  user_id      TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  token_hash   TEXT        NOT NULL,
  key_preview  TEXT        NULL,                 -- 代码 tokens.ts:66 写入，原 schema 缺失
  last_used_at TIMESTAMPTZ NULL,                 -- 最近使用时间，由 verifyToken 写入（F9）
  expires_at   TIMESTAMPTZ NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ NULL,
  CONSTRAINT pk_api_tokens PRIMARY KEY (id)
);
COMMENT ON COLUMN api_tokens.expires_at IS 'NULL 表示永不过期';
COMMENT ON COLUMN api_tokens.last_used_at IS '最近一次鉴权使用时间，由 verifyToken 写入（F9）';


-- ---------------- 原型分享令牌 ----------------
-- 代码依据：lib/services/prototypes.ts:145-171（createShareToken / getShareToken）
--          app/share/prototype/[token]/route.ts（公开访问，token 即凭据）
CREATE TABLE share_tokens (
  id             TEXT        NOT NULL,           -- token 本身（randomBytes(16).hex，32 字符）
  requirement_id TEXT        NOT NULL,
  type           TEXT        NOT NULL DEFAULT 'prototype'
                   CHECK (type IN ('prototype')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NULL,               -- NULL = 永不过期
  CONSTRAINT pk_share_tokens PRIMARY KEY (id),
  CONSTRAINT fk_share_req FOREIGN KEY (requirement_id)
    REFERENCES requirements(id) ON DELETE CASCADE
);


-- ---------------- 通用对象存储回落表 ----------------
-- 代码依据：lib/storage.ts:21-26 / 35-36
-- COS 未配置（COS_BUCKET/COS_REGION 为空）时，原型 HTML 等大文本落在此表。
-- 当前 CloudBase 环境未开通 COS，本表即为唯一对象存储实现。
CREATE TABLE objects (
  id         TEXT        NOT NULL,   -- 存储 key，如 proto-html/v3/<requirement_id>
  key        TEXT        NOT NULL,   -- 与 id 同值（storage.ts:25 双写，保留以免读侧漂移）
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_objects PRIMARY KEY (id)
);


-- ---------------- 体验访问记录（运营统计） ----------------
-- 体验模式（/try 填昵称）下，每次「开始体验」记一条，用于统计有多少人来体验、谁在活跃。
-- 仅作访问埋点，不参与业务数据隔离（业务数据仍按 projects.owner_id = 昵称 隔离）。
CREATE TABLE visits (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY,
  nickname   TEXT        NOT NULL,           -- 体验昵称（= cookie askbuddy_session）
  user_agent TEXT        NULL,               -- 浏览器 UA（粗粒度设备识别）
  referer    TEXT        NULL,               -- 来源页（从哪分享进来）
  ip         TEXT        NULL,               -- 取 x-forwarded-for 首段
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_visits PRIMARY KEY (id)
);


-- ============================================================
-- 索引（P2 下推的性能基础，与 lib/db 的 findMany 下推点一一对应）
-- 部分索引的 WHERE 条件直接对应代码里的 !r.archived_at / !r.deleted_at / !r.revoked_at 过滤
-- ============================================================
CREATE INDEX idx_projects_owner ON projects (owner_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_req_project    ON requirements (project_id, updated_at DESC) WHERE archived_at IS NULL;
CREATE INDEX idx_conv_req       ON conversations (requirement_id, id);
CREATE UNIQUE INDEX uq_step     ON requirement_steps (requirement_id, step);
CREATE INDEX idx_card_ver_req   ON card_versions (requirement_id, version);
CREATE INDEX idx_ra_ver_req     ON research_analysis_versions (requirement_id, version);
CREATE INDEX idx_sol_ver_req    ON solution_versions (requirement_id, version);
CREATE INDEX idx_proto_ver_req  ON prototype_versions (requirement_id, version);
CREATE INDEX idx_prd_ver_req    ON prd_versions (requirement_id, version);
CREATE INDEX idx_token_user     ON api_tokens (user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX uq_token_hash ON api_tokens (token_hash);
CREATE INDEX idx_share_req      ON share_tokens (requirement_id, type, created_at DESC);
CREATE INDEX idx_visits_created ON visits (created_at DESC);
CREATE INDEX idx_visits_nick    ON visits (nickname);


-- ============================================================
-- 附录 A：冗余 id 列说明（research_analysis / solutions / prototypes / prds）
-- ============================================================
-- 这 4 张「需求一对一主态表」的主键是 requirement_id，但同时保留一个恒等于
-- requirement_id 的冗余 id 列。原因：
--   - 正常路径用 db.get(table, rid, "requirement_id")；
--   - 但 MCP 路径（app/api/mcp/requirement/[id]/research/route.ts:17 与
--     .../prototype/route.ts:22）绕过 getOutput() 直接 db.get(table, id)，用默认
--     idKey="id"，靠「代码同时写了 id 和 requirement_id 且两者相等」这个巧合工作。
--   - 若 PG 不建 id 列，MCP 的 research/prototype 两个工具会立刻 500。
-- 处置：M1 保留冗余列（成本 = 4 列 TEXT + 4 个唯一索引），保证 PG 与 NoSQL 行为一致；
--       由 M2（MCP 扩展）统一改为走 getOutput()，届时再 DROP COLUMN id。
-- 详见 docs/ops/db-field-audit.md。


-- ============================================================
-- 附录 B：异步 AI 任务（D6：暂不实现，T3 复查项）
-- ============================================================
-- 决策：长任务继续走同步 SSE（lib/ai/client.ts 流式），不引入任务表与队列。
-- 若未来启用（复查项 T3），预期结构如下，届时以新迁移文件创建，不要在此处直接建表：
--   ai_tasks(id TEXT PK, user_id TEXT NOT NULL, requirement_id TEXT NULL,
--            task_type TEXT NOT NULL,           -- prototype_generate|prd_generate|research...
--            status TEXT NOT NULL DEFAULT 'pending'
--              CHECK (status IN ('pending','running','success','failed')),
--            progress SMALLINT NOT NULL DEFAULT 0,
--            result JSONB NULL, error TEXT NULL,
--            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
--            updated_at TIMESTAMPTZ NOT NULL DEFAULT now())
--   INDEX (user_id, status)


-- ============================================================
-- 附录 C：已移除的表（M1）
-- ============================================================
-- research          [DEPRECATED] v2 起由 research_analysis 替代，代码 0 引用
-- analysis          [DEPRECATED] v2 起由 research_analysis 替代，代码 0 引用
-- webhook_configs   预留未启用，代码 0 引用
-- ai_tasks          见附录 B
-- outputs           从来不存在。lib/services/requirements.ts 曾有 removeBy("outputs", ...)
--                   死调用（NoSQL 下被 ensureCollection 自动建空集合掩盖），已于 M1 删除。
