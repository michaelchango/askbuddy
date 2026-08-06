# M1 数据切换手册（NoSQL → CloudBase PostgreSQL）

> 适用范围：把 AskBuddy 的数据库从 CloudBase NoSQL 切到新建的 CloudBase PostgreSQL。
> M1 是**新增一个后端**而非就地迁移数据 —— 默认仍是 NoSQL，显式开启才走 PG。

## 0. 前置条件

- 已在 CloudBase 控制台开好 **PostgreSQL** 环境（不是云数据库 / NoSQL 环境）；
- 拿到实例的 `postgresql://` 连接串（与 `CLOUDBASE_SECRET`(ApiKey) 是**两套独立凭据**）；
- 已 `npm install`（依赖 `postgres` / `drizzle-orm` / `drizzle-kit` / `tsx` / `@next/env` 均已装齐）。

## 1. 建库（一次性）

```bash
# 1) 把连接串写进 .env.local（切勿提交进 git）
#    DATABASE_URL=postgresql://<user>:<password>@<host>:<port>/<db>?sslmode=require

# 2) 生成迁移 SQL（离线，只需 schema.ts）
npm run db:generate

# 3) 应用迁移
npm run db:migrate
#    → 建 16 张表 + 外键 + 部分索引 + CHECK 约束（drizzle-kit 漏生成的 CHECK 由脚本补建）

# 4)（可选）写最小冒烟数据
DB_BACKEND=postgres npm run db:seed
```

## 2. 切换后端

三后端优先级（`lib/cloudbase/index.ts:resolveDbBackend`）：
**USE_MOCK > DB_BACKEND > 默认 nosql**。

| 想要的行为 | 环境变量 |
| --- | --- |
| 继续用 NoSQL（M1 前默认） | 不设任何新变量 |
| 走 PostgreSQL | `DB_BACKEND=postgres`（保持 `USE_MOCK` 未设） |
| 本地内存 mock | `USE_MOCK=true` |

切换 = 在运行环境设 `DB_BACKEND=postgres`。**不设 = 与 M1 前逐字节一致**，可随时回退。

## 3. 冒烟验证（T6）

1. `npm run db:check` —— 三副本契约一致；
2. `npm run test:parity` —— 18 个下推点对拍全绿；
3. 起服务（`DB_BACKEND=postgres npm run dev`），走一遍主流程：
   建项目 → 建需求 → 发对话 → 存卡片/调研/方案/PRD 版本 → 列表/详情读取 → 分享令牌；
4. `npm run verify:embedding` —— 确认向量存储策略与维度配置无误。

## 4. 回退

设回 `DB_BACKEND` 为空（或删掉该变量）→ 下次请求自动回到 NoSQL。
PG 是**增量引入**，原 NoSQL 数据未被触碰，回退零数据风险。

> ⚠️ M1 **不**做历史 NoSQL 数据向 PG 的迁移。新 PostgreSQL 环境是空的，
> 老数据仍在 NoSQL 里。若未来需要把存量数据搬过来，是独立的导出/导入任务，不在 M1 范围。

## 5. ⚠️ 构建期会真实查库（切换前必读）

`next build` 的静态预渲染阶段会**真实访问数据库**，不是只编译代码。

原因链：`app/dashboard/layout.tsx` 是 async server component，构建期调用
`listProjects(session.uid)`；而 `lib/auth/session.ts:getSession()` 目前硬编码返回
`mock-user-001` 且**不读 cookies** —— 没有动态信号，于是 Next 把
`/dashboard`、`/dashboard/projects`、`/dashboard/projects/new`、`/dashboard/tokens`
四个路由判定为 `○ (Static)`，在构建期就执行了这次查询。

实测（2026-08-06）：CloudBase NoSQL 凭据失效后，`npm run build` 在
`Generating static pages` 阶段报 `INVALID_ACCESS_TOKEN` 并以 `Export encountered errors`
失败 —— **但 14/14 页面本身已全部成功生成，编译无误**。同一份代码
`USE_MOCK=true npm run build` 干净 exit 0。即：这类失败是**数据源不可达**，不是代码问题。

切到 PG 后的三个选项：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A. 构建机连库（默认） | CI 上配好 `DATABASE_URL` + `DB_BACKEND=postgres` | 构建机需持有生产库凭据 |
| B. 构建时用 mock | `USE_MOCK=true npm run build` | 烤进静态壳的 `hideSidebar` 基于 mock 数据 |
| C. 关掉该页预渲染（推荐） | `app/dashboard/layout.tsx` 加一行 `export const dynamic = "force-dynamic";` | 无 —— dashboard 本就是登录后个性化页面，不该静态预渲染 |

**方案 C 是语义上正确的解**，且改动仅一行。但它属于渲染策略调整，
已超出 M1「只换数据底座」的范围声明，故 M1 **未擅自实施**，留作切换前的一次性决策。
在采用 A 或 C 之前，CI 上的 `next build` 会失败。

## 6. 生产注意

- `CLOUDBASE_SECRET`（NoSQL / Auth / 存储）与 `DATABASE_URL`（PG SQL）**两者都要配**；
- 连接串含密码，只放 `.env.local`，已被 `.gitignore` 忽略，切勿提交；
- `DB_POOL_MAX`（默认 5）、`DB_LIST_LIMIT`（默认 1000）、`DB_LOG_SQL`（默认 false，调试时开）
  等可在 `.env.local` 调；
- 托管 PG 常在前面挂 PgBouncer（transaction 模式），默认 `DB_PG_PREPARE=false`（关 prepared statement）；
  确认是直连实例后可设 `DB_PG_PREPARE=true` 换一点性能。
