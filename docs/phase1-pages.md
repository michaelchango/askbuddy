# Phase 1 页面与路由清单（详细）

> 配合 `phase1-backlog.md` 使用。本文件细化每个任务的页面、组件、API 路由与数据获取策略。
> 路由约定：`/dashboard/**` 全部受 `middleware.ts` 保护，未登录跳 `/login`。

## 1. 路由总览

### 公开
| 路由 | 页面 | 任务 |
| :--- | :--- | :--- |
| `/` | 落地页（已有） | T1 |
| `/login` | 登录 / 注册（mock） | T3 |

### 受保护（/dashboard）
| 路由 | 页面 | 任务 |
| :--- | :--- | :--- |
| `/dashboard` | 重定向到 `/dashboard/projects` | T3 |
| `/dashboard/projects` | 项目列表 + 新建入口 | T4 |
| `/dashboard/projects/new` | 新建项目表单 | T4 |
| `/dashboard/projects/[projectId]` | 项目详情 / 需求列表容器 | T5 |
| `/dashboard/projects/[projectId]/requirements/new` | 新建需求（对话入口/手动） | T5 |
| `/dashboard/requirements/[requirementId]` | 需求工作区（Tab：对话/调研/分析/方案/原型/PRD） | T5–T7 |
| `/dashboard/settings/tokens` | API Token 管理 | T8 |

## 2. 组件拆分

- `components/layout/`: `DashboardShell`（侧边栏 + 导航 + 退出）、`LogoutButton`（客户端）
- `components/ui/`: `Button`（已有）、后续 `Dialog`/`Input`/`Card`/`Tabs` 按需从 shadcn 复制
- `components/projects/`: `ProjectList`、`ProjectCard`、`NewProjectForm`
- `components/requirements/`: `RequirementList`、`StatusFlow`（状态流转）、`ContentTree`（产出物树）
- `components/dialogue/`: `ConversationPanel`（T6）
- `components/prototype/`: `PrototypePreview`(`<iframe sandbox>`)、`VersionList`（T7）
- `components/tokens/`: `TokenManager`（T8）

## 3. API 路由（统一 `ApiResult` 结构）

| 方法 | 路由 | 说明 | 任务 |
| :--- | :--- | :--- | :--- |
| POST | `/api/auth/login` | 设置 mock 会话 cookie | T3 |
| POST | `/api/auth/logout` | 清除 cookie | T3 |
| GET  | `/api/projects` | 列出当前用户项目 | T4 |
| POST | `/api/projects` | 创建项目 | T4 |
| PATCH| `/api/projects/[id]` | 归档项目 | T4 |
| GET  | `/api/requirements` | 项目下需求列表（`?projectId=`） | T5 |
| POST | `/api/requirements` | 创建需求 | T5 |
| PATCH| `/api/requirements/[id]` | 状态流转 / 更新卡片 | T5 |
| POST | `/api/requirements/[id]/conversation` | 追加对话、生成卡片 | T6 |
| POST | `/api/requirements/[id]/prototype` | 触发/获取原型生成 | T7 |
| GET  | `/api/requirements/[id]/prototype/versions` | 原型版本列表 | T7 |
| GET  | `/api/tokens` | Token 列表 | T8 |
| POST | `/api/tokens` | 生成 Token（哈希） | T8 |
| POST | `/api/tokens/[id]/revoke` | 撤销 Token | T8 |
| GET  | `/api/tasks/[id]` | 轮询 AI 任务进度 | T6/T7 |

## 4. 数据获取策略

- **读**：页面用 Server Component 直接经 `lib/services/*` 读 `lib/db`（同一进程，最快）；需要实时刷新的列表用客户端 `swr` 调 API。
- **写（变更）**：一律走 API Route（同时作为 MCP/CLI 对外契约），客户端 `fetch` 后 `router.refresh()` 或 `mutate()`。
- **会话**：`lib/auth/session.getSession()` 读 `prd_session` cookie；`middleware.ts` 守卫 `/dashboard`。

## 5. 开发顺序对应 backlog
T1 脚手架 ✅ → T2 数据层 ✅ → **T3 认证（本文档已实现）** → **T4 项目管理（已实现）** → T5 需求管理 → T6 对话完善 → T7 原型 → T8 Token。
