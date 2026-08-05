-- ============================================================
-- AskBuddy MVP Database Schema (MySQL 8.0+)
-- 腾讯云 CloudBase 云数据库 MySQL
-- 约定：
--   1. 存储引擎 InnoDB，字符集 utf8mb4，时间统一 UTC (DATETIME(3))
--   2. 软删除统一使用 deleted_at；业务灵活结构用 JSON 列
--   3. 需求下各模块以 requirement_id 为主键（一对一），版本表单独存
--   4. 血缘：source_* / upstream_ids 记录来源；maybe_stale 标记过期
-- ============================================================

SET NAMES utf8mb4;

-- ---------------- 项目 ----------------
CREATE TABLE projects (
  id          CHAR(20)      NOT NULL,
  name        VARCHAR(120)  NOT NULL,
  description TEXT          NULL,
  owner_id    VARCHAR(64)   NOT NULL,            -- CloudBase Auth uid
  status      ENUM('active','archived') NOT NULL DEFAULT 'active',
  team_id     VARCHAR(64)   NULL,                -- 预留团队层级
  created_at  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at  DATETIME(3)   NULL,
  PRIMARY KEY (id),
  KEY idx_projects_owner (owner_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- 需求（一等公民） ----------------
CREATE TABLE requirements (
  id              CHAR(20)     NOT NULL,
  project_id      CHAR(20)     NOT NULL,
  title           VARCHAR(200) NOT NULL,
  status          ENUM('dialoguing','researching','designing',
                       'prd_writing','completed','archived')
                      NOT NULL DEFAULT 'dialoguing',
  priority        ENUM('low','medium','high') NULL,
  tags            JSON         NULL,
  category        VARCHAR(80)  NULL,
  related_ids     JSON         NULL,             -- 关联需求 id 列表
  card            JSON         NOT NULL,         -- 结构化需求卡片
  current_version INT          NOT NULL DEFAULT 0, -- 需求卡片当前版本号
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  archived_at     DATETIME(3)  NULL,
  PRIMARY KEY (id),
  KEY idx_req_project (project_id, status),
  CONSTRAINT fk_req_project FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- 对话记录（仅追加） ----------------
CREATE TABLE conversations (
  id              BIGINT       NOT NULL AUTO_INCREMENT,
  requirement_id  CHAR(20)     NOT NULL,
  role            ENUM('user','assistant','system') NOT NULL,
  content         MEDIUMTEXT   NOT NULL,
  meta            JSON         NULL,              -- 模型、token 用量
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_conv_req (requirement_id, id),
  CONSTRAINT fk_conv_req FOREIGN KEY (requirement_id) REFERENCES requirements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- 步骤完成度（弹性模型） ----------------  
CREATE TABLE requirement_steps (
  id              INT          NOT NULL AUTO_INCREMENT,
  requirement_id  CHAR(20)     NOT NULL,
  step            VARCHAR(30)  NOT NULL,
                -- 'dialoguing' | 'research_analysis' | 'design' | 'prd_writing'
  completion      ENUM('full','brief','skip') NOT NULL DEFAULT 'full',  -- [暂不使用] 内容完整度，后续独立功能
  state           ENUM('not_started','in_progress','done','pending_update') NOT NULL DEFAULT 'not_started',  -- 流程节点状态（当前使用）
  awaiting_confirm TINYINT(1)   NOT NULL DEFAULT 0,  -- 确认闸门：1=已生成/达标等待用户手动确认进入下一阶段
  note            VARCHAR(255) NULL,
  output_version  INT          NULL,
  completed_at    DATETIME(3)  NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_step (requirement_id, step),
  CONSTRAINT fk_step_req FOREIGN KEY (requirement_id) REFERENCES requirements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- 调研分析模块（合并调研+分析）----------------
CREATE TABLE research_analysis (
  requirement_id         CHAR(20)    NOT NULL,
  framework              JSON        NULL,        -- 调研框架
  materials              JSON        NULL,        -- [{title,url,snippet,source}]
  report                 MEDIUMTEXT  NULL,        -- 调研报告 / 洞察摘要
  user_stories           JSON        NULL,        -- [{role,goal,reason}]
  features               JSON        NULL,        -- [{name,desc,priority,module}]
  source_conversation_id BIGINT      NULL,
  upstream_ids           JSON        NULL,
  maybe_stale            TINYINT(1)  NOT NULL DEFAULT 0,
  current_version        INT         NOT NULL DEFAULT 0, -- 当前版本号
  updated_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (requirement_id),
  CONSTRAINT fk_ra_req FOREIGN KEY (requirement_id) REFERENCES requirements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- [DEPRECATED] 旧调研模块 — v2 起由 research_analysis 替代，保留仅用于存量数据兼容。
CREATE TABLE research (
  requirement_id         CHAR(20)    NOT NULL,
  framework              JSON        NULL,
  materials              JSON        NULL,
  report                 MEDIUMTEXT  NULL,
  source_conversation_id BIGINT      NULL,
  maybe_stale            TINYINT(1)  NOT NULL DEFAULT 0,
  updated_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (requirement_id),
  CONSTRAINT fk_research_req FOREIGN KEY (requirement_id) REFERENCES requirements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- [DEPRECATED] 旧分析模块 — v2 起由 research_analysis 替代，保留仅用于存量数据兼容。
CREATE TABLE analysis (
  requirement_id  CHAR(20)   NOT NULL,
  user_stories    JSON       NULL,
  features        JSON       NULL,
  upstream_ids    JSON       NULL,
  maybe_stale     TINYINT(1) NOT NULL DEFAULT 0,
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (requirement_id),
  CONSTRAINT fk_analysis_req FOREIGN KEY (requirement_id) REFERENCES requirements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- 方案模块 ----------------
CREATE TABLE solutions (
  requirement_id  CHAR(20)   NOT NULL,
  doc             MEDIUMTEXT NULL,
  upstream_ids    JSON       NULL,
  maybe_stale     TINYINT(1) NOT NULL DEFAULT 0,
  current_version INT        NOT NULL DEFAULT 0, -- 当前版本号
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (requirement_id),
  CONSTRAINT fk_sol_req FOREIGN KEY (requirement_id) REFERENCES requirements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- 原型（当前态） ----------------
CREATE TABLE prototypes (
  requirement_id  CHAR(20)    NOT NULL,
  structure       JSON        NULL,              -- 页面结构
  cos_key         VARCHAR(255) NULL,             -- 原型 HTML 包在 COS 的 key
  current_version INT         NOT NULL DEFAULT 0,
  upstream_ids    JSON        NULL,
  maybe_stale     TINYINT(1)  NOT NULL DEFAULT 0,
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (requirement_id),
  CONSTRAINT fk_proto_req FOREIGN KEY (requirement_id) REFERENCES requirements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- 原型版本历史 ----------------
CREATE TABLE prototype_versions (
  id              INT         NOT NULL AUTO_INCREMENT,
  requirement_id  CHAR(20)    NOT NULL,
  version         INT         NOT NULL,
  structure       JSON        NULL,
  cos_key         VARCHAR(255) NOT NULL,
  note            VARCHAR(255) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_proto_ver (requirement_id, version),
  CONSTRAINT fk_proto_ver_req FOREIGN KEY (requirement_id) REFERENCES requirements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- 需求卡片版本历史 ----------------
CREATE TABLE card_versions (
  id              INT         NOT NULL AUTO_INCREMENT,
  requirement_id  CHAR(20)    NOT NULL,
  version         INT         NOT NULL,
  card            JSON        NOT NULL,
  note            VARCHAR(255) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_card_ver (requirement_id, version),
  CONSTRAINT fk_card_ver_req FOREIGN KEY (requirement_id) REFERENCES requirements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- 调研分析版本历史 ----------------
CREATE TABLE research_analysis_versions (
  id              INT         NOT NULL AUTO_INCREMENT,
  requirement_id  CHAR(20)    NOT NULL,
  version         INT         NOT NULL,
  report          MEDIUMTEXT  NULL,
  user_stories    JSON        NULL,
  features        JSON        NULL,
  note            VARCHAR(255) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ra_ver (requirement_id, version),
  CONSTRAINT fk_ra_ver_req FOREIGN KEY (requirement_id) REFERENCES requirements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- 方案文档版本历史 ----------------
CREATE TABLE solution_versions (
  id              INT         NOT NULL AUTO_INCREMENT,
  requirement_id  CHAR(20)    NOT NULL,
  version         INT         NOT NULL,
  doc             MEDIUMTEXT  NULL,
  note            VARCHAR(255) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sol_ver (requirement_id, version),
  CONSTRAINT fk_sol_ver_req FOREIGN KEY (requirement_id) REFERENCES requirements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- PRD（当前态） ----------------
CREATE TABLE prds (
  requirement_id  CHAR(20)    NOT NULL,
  markdown        MEDIUMTEXT  NULL,
  cos_key         VARCHAR(255) NULL,             -- 导出的 docx 等
  current_version INT         NOT NULL DEFAULT 0,
  upstream_ids    JSON        NULL,
  maybe_stale     TINYINT(1)  NOT NULL DEFAULT 0,
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (requirement_id),
  CONSTRAINT fk_prd_req FOREIGN KEY (requirement_id) REFERENCES requirements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- PRD 版本历史 ----------------
CREATE TABLE prd_versions (
  id              INT         NOT NULL AUTO_INCREMENT,
  requirement_id  CHAR(20)    NOT NULL,
  version         INT         NOT NULL,
  markdown        MEDIUMTEXT  NULL,
  cos_key         VARCHAR(255) NULL,
  note            VARCHAR(255) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_prd_ver (requirement_id, version),
  CONSTRAINT fk_prd_ver_req FOREIGN KEY (requirement_id) REFERENCES requirements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- 异步 AI 任务 ----------------
CREATE TABLE ai_tasks (
  id              CHAR(24)    NOT NULL,
  user_id         VARCHAR(64) NOT NULL,
  requirement_id  CHAR(20)    NULL,
  task_type       VARCHAR(40) NOT NULL,          -- prototype_generate / prd_generate / research ...
  status          ENUM('pending','running','success','failed') NOT NULL DEFAULT 'pending',
  progress        TINYINT     NOT NULL DEFAULT 0,
  result          JSON        NULL,
  error           VARCHAR(500) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_task_user_status (user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- API Token（PAT） ----------------
CREATE TABLE api_tokens (
  id            CHAR(24)    NOT NULL,
  user_id       VARCHAR(64) NOT NULL,
  name          VARCHAR(80) NOT NULL,
  token_hash    VARCHAR(128) NOT NULL,
  last_used_at  DATETIME(3) NULL,
  expires_at    DATETIME(3) NULL COMMENT 'NULL 表示永不过期',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at    DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_token_hash (token_hash),
  KEY idx_token_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------- Webhook 配置（预留，MVP 不启用） ----------------
CREATE TABLE webhook_configs (
  id          CHAR(24)    NOT NULL,
  project_id  CHAR(20)    NOT NULL,
  url         VARCHAR(500) NOT NULL,
  events      JSON        NULL,
  secret      VARCHAR(128) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_wh_project FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
