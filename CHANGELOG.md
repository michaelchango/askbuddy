# 更新日志 / Changelog

本文件记录每次版本（M 阶段）的更新说明，远端 GitHub 与本地保持同步。

## M1 — 数据底座 NoSQL → CloudBase PostgreSQL（经网关 SQL 接口，不依赖 DATABASE_URL）(2026-08-06)

- **数据层四后端一套契约**：`mock` / `nosql` / `postgres`(直连 PG 协议) / `cloudbase`(网关 SQL 接口)。新增 `lib/db/cloudbase.ts`。
- **cloudbase 后端（B 通道）**：全部 SQL 走 CloudBase 公网网关 `/v1/rdb/exec-pgsql`，凭据复用 `CLOUDBASE_SECRET`（API Key），以 `Role=cloudbase_postgres` 调用；**不依赖 `DATABASE_URL`（PG 协议连接串）**，无需腾讯云密钥。
- **SQL 构造**：exec-pgsql 网关不支持参数化（占位符 `$1` 报 500），改用「安全字面量序列化」——标识符走 field-map 白名单 / TABLES 集合，值统一转义（`'` 与 `\`），JSONB 列追加 `::jsonb`，等效预处理语句、零注入风险。
- **建库脚本** `scripts/db-setup-cloudbase.ts`（`npm run db:setup:cloudbase`）：`CREATE EXTENSION IF NOT EXISTS vector` + 拆分 `db/schema.sql` 逐条执行，幂等。已建 16 张业务表 + 12 索引，`vector` 扩展可用。
- **真 pgvector（撤销临时方案）**：用户决策改回真向量检索。原「real[] + 应用层余弦」临时方案废弃；`searchVector`（lib/db/{postgres,cloudbase}.ts）经 `1 - (col <=> $q::vector)` 在 SQL 层下推余弦相似度，业务零改动。`docs/ops/pgvector-enabled.md`、`db/schema.sql` 注释同步更新。
- **对拍测试泛化**：`__tests__/db-pushdown-parity.test.ts` L3 不再强依赖 `DATABASE_URL`，`DB_BACKEND=cloudbase`（无 DATABASE_URL）也能对真实库跑 list/findMany 对拍。
- **验收**：`npm run db:check` 契约 16/16/16；`npm run test:parity DB_PARITY_PG=true` 真实 CloudBase **82/82**（含 L3）；真 pgvector `<=>` 检索端到端通过；`next build` 全绿。
- **配置**：`.env.local` 置 `DB_BACKEND=cloudbase`；`DATABASE_URL` 留空（cloudbase 路径不需要）。`tsconfig.json` 排除探索用 `scripts/probe-*.ts` 以免拖慢构建类型检查。

## M1.1 — 热修：requirements.title_source CHECK 约束值域漂移 (2026-08-06)

- **现象**：运行时 `UPDATE requirements SET title_source='auto' ...` 触发 `DATABASE_23514`，违反 `requirements_title_source_check`。
- **根因**：schema CHECK 允许 `('manual','ai')`，但代码契约 `TitleSource = "auto" | "manual" | null`（`types/index.ts:64`）实际写入 `'auto'`、`'ai'` 从未使用 —— 属 schema 落后于代码的漂移。
- **修复（三处契约源一致）**：
  - `db/drizzle/schema.ts` `ck_req_title_source`：`IN ('manual','ai')` → `IN ('manual','auto')`（migrate.ts 从 schema.ts 程序化读 CHECK，自动跟随）。
  - `db/schema.sql`：`title_source` 改为显式命名 `CONSTRAINT ck_req_title_source CHECK (... IN ('manual','auto'))`，与 drizzle 命名对齐。
  - **线上库**：经 B 通道执行 `scripts/db-fix-title-source-check.ts`，DROP 旧 `requirements_title_source_check`、ADD `ck_req_title_source`（值域 `'manual','auto'`）。已验证线上约束定义生效。
- **附带扫描**：对其余 CHECK（`ck_projects_status`/`ck_conv_role`/`ck_req_step`/`ck_req_state`/`ck_req_completion`/`ck_share_type`）与代码 enum 逐一比对，均无漂移。
- **新增脚本**：`scripts/db-fix-title-source-check.ts`（热修）、`scripts/verify-title-source-check.ts`（校验）。

## M0 — 命名统一 AskBuddy 化 + 技术债清理 (2026-08-05)

- **全站命名收敛**：`prdflow` / `PRDTube` / `prd_session` → `askbuddy` / `AskBuddy` / `askbuddy_session`
- **DOM 事件前缀常量化**：集中到 `lib/events.ts` 的 `EVT` 常量，三组件统一引用，防 dispatch/listen 字面量漂移静默失效
- **Cookie 常量下沉**：新建 `lib/auth/constants.ts`（无 next/headers 依赖）供 Edge Runtime 的 `middleware.ts` 与 `lib/auth/session.ts` 共用，避免两侧 Cookie 名不一致导致登录反复打回
- **MCP 环境变量双读**：`ASKBUDDY_*` ?? `PRDFLOW_*`，过渡期兼容存量用户本地 `mcp.json` 配置
- **三不改项（存量数据安全）**：
  - `CLOUDBASE_ENV_ID` 保持不变（永不改）
  - PAT 盐默认 `askbuddy-pat-v1`，`.env.local` 钉 `PAT_SALT=prdflow-pat-v1` 保历史 Token 可鉴权
  - 原型 script id 发 `askbuddy-structure`，`parse` 侧新旧双读旧 `prd-flow-structure`
- **清理 6 项技术债**：删 `settings/tokens` 重定向 shim、`storage.ts` COS 死分支、`markdown.tsx` 中转层内联、清 21 行调试日志（保留 `console.error`）
- **修复改名前即存在的 build blocker**：`parse.ts` 严格模式 spread 推断错误、`projects/page.tsx` 引用未定义的 `setMenuOpen`（删除成功会崩溃）
- **修复损坏的 mermaid 安装**：原 `npm install` 被网络中断截断，用 `npm pack` 重拉完整 tarball 补齐 ESM 入口与类型
- **新增文件**：`.gitattributes`（统一行尾）、`lib/auth/constants.ts`、`lib/events.ts`
- **验收**：`tsc --noEmit` 通过；`next build` 干净通过（14/14 静态页，Middleware 26.5kB）；命名扫描仅剩白名单兼容项
