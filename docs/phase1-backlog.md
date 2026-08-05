# AskBuddy Phase 1 开发任务清单（MVP 第一阶段）

> 目标：打通“项目/需求管理 → 对话式需求完善 → AI 原型生成与预览 → 版本快照”主链路。
> 凭证策略：本阶段 CloudBase 凭证以 **mock** 实现（`USE_MOCK=true`），不依赖真实环境即可本地开发联调。
> 参考：architecture.md / requirement-model.md / ai-model-strategy.md / database-schema.md

## 验收总目标（Phase 1 Done 标准）
1. 本地 `npm run dev` 可启动，登录后进入工作区。
2. 能创建项目、在项目下创建需求、推进需求状态。
3. 通过一轮 AI 对话产出结构化需求卡片。
4. 能触发 AI 生成可交互原型，iframe 预览，保存/回退版本。
5. 可生成/撤销 API Token（mock 存储）。

---

## 任务清单（按依赖排序）

### T1 项目脚手架与基础配置
- [ ] 初始化 Next.js 14 + TS（strict）+ Tailwind + shadcn 基础（已完成骨架，待 `npm install` 验证）
- [ ] 配置 ESLint / Prettier，统一 `kebab-case` 文件、`PascalCase` 组件
- [ ] 落地 `.env.example`（`USE_MOCK`、`CLOUDBASE_ENV_ID` 等占位）
- [ ] 验收：`npm run dev` 启动，首页可访问，无 TS / lint 错误

### T2 数据层与 Mock CloudBase
- [ ] `lib/cloudbase`：mock 用户会话（`getCurrentUser`），`USE_MOCK` 开关
- [ ] `lib/db`：基于 `db/schema.sql` 的访问封装；mock 模式用内存表，真实模式用 mysql2 连接池（TODO 占位）
- [ ] `types/index.ts`：Project / Requirement / RequirementCard / 各产出物类型，与 DDL 对齐
- [ ] 验收：用 mock 会话能插入并读回一条 requirement

### T3 认证（Mock）
- [ ] 登录/注册页（mock 用户），会话 Context 注入
- [ ] `middleware.ts` 保护 `/dashboard` 路由，未登录跳 `/login`
- [ ] 验收：未登录访问工作区被重定向

### T4 项目管理
- [ ] 项目列表页、创建弹窗、归档操作（CRUD）
- [ ] 路由组 `app/(dashboard)/projects`
- [ ] 验收：可创建项目并在列表中看到，可归档

### T5 需求管理
- [ ] 需求列表（按状态/标签筛选）、创建入口（对话入口 / 手动空白）
- [ ] 需求状态流转 UI（遵循 8 状态枚举）
- [ ] 需求内容树展示（对话/调研/分析/方案/原型/PRD 节点）
- [ ] 验收：项目下可创建需求、切换状态、查看内容树

### T6 对话式需求完善
- [ ] 对话面板组件（流式可选），调用 `lib/ai` 的 `dialoguing` 任务（mock 返回结构化卡片）
- [ ] 对话记录写入 `conversations`（仅追加）
- [ ] 将对话结论映射为 `RequirementCard` 并写回 `requirements.card`，状态置 `confirmed`
- [ ] 验收：一轮对话后生成结构化卡片，需求进入“已确认”

### T7 AI 原型生成 + 预览 + 版本
- [ ] 触发原型生成：写 `ai_tasks(pending)` → 调 `lib/ai` 的 `designing` 任务（mock 返回 HTML）
- [ ] 原型存 COS（mock 存内存/临时文件），`prototypes` 写当前态 + `prototype_versions` 写版本
- [ ] `<iframe sandbox>` 预览；版本列表、回退、对比
- [ ] 验收：生成原型可预览，保存版本后可回退

### T8 对外集成基础（Phase 1 末尾）
- [ ] API Token 管理页：生成（哈希存储）/ 撤销（mock 存储于 `api_tokens`）
- [ ] 验收：可生成并撤销 token，列表展示

---

##  mock 策略约定
- 所有云依赖（Auth / MySQL / COS / AI）在 `USE_MOCK=true` 时走内存/占位实现，接口签名与真实实现一致。
- mock 实现集中在 `lib/cloudbase`、`lib/db`、`lib/ai`，未来切换真实 CloudBase 仅需替换内部实现，不动业务代码。
- 真实环境接入列为 Phase 2 前置项（需用户提供 CloudBase 凭证）。

## 不在 Phase 1 范围
调研/分析/方案/PRD 的真实 AI 生成与导出、团队协作、Webhook、自定义模型 Key（见各 rules 文件的 MVP 边界）。
