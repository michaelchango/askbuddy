# db/drizzle —— 数据库迁移工作区（M1）

## 三副本契约（核心纪律）

同一份表结构在仓库里有 **三个副本**，任何一处漂移都会在 PG 上变成随机 500：

| 文件 | 角色 | 谁改 |
| --- | --- | --- |
| `db/drizzle/schema.ts` | **机器事实源**，drizzle-kit 据此生成迁移 | 改结构时**先改这里** |
| `db/schema.sql` | **人读基线**，带完整设计意图注释，不被任何程序执行 | 同步更新注释 |
| `lib/db/field-map.ts` | **运行时映射**，代码键 ⇄ 列名 + 类型元数据 | 同步更新映射 |

三者一致性由 `npm run db:check`（`scripts/check-db-contract.ts`）强制校验，**可直接接 CI**。
改任何一张表的结构，顺序必须是：

```
改 db/drizzle/schema.ts  →  npm run db:generate  →  同步 db/schema.sql 注释  →  同步 lib/db/field-map.ts  →  npm run db:check
```

## 命令

| 命令 | 作用 | 是否需要 DATABASE_URL |
| --- | --- | --- |
| `npm run db:check` | 校验三副本一致性 | 否 |
| `npm run db:generate` | 据 schema.ts 生成迁移 SQL 到 `./migrations`（**离线**） | 否（占位串即可） |
| `npm run db:migrate` | 把 `./migrations` 应用到 PG（`db/drizzle/migrate.ts`） | **是（真实串）** |
| `DB_RESET_CONFIRM=1 npm run db:reset` | 开发用：DROP 全部表回到空库 | 是 |
| `DB_BACKEND=postgres npm run db:seed` | 开发用：写入最小冒烟数据（幂等） | 是 |
| `npm run verify:embedding` | 校验 embedding 维度与向量存储策略 | 选（探测时才需要） |

## 迁移工作流（首次建库 / 结构变更）

```bash
# 1. 首次：在 CloudBase 控制台拿到 PostgreSQL 实例的 postgresql:// 连接串，
#    填进 .env.local 的 DATABASE_URL（与 CLOUDBASE_SECRET 是两套独立凭据）。

# 2. 生成迁移 SQL（离线，不需要连库）
npm run db:generate

# 3. 应用迁移
npm run db:migrate

# 4.（可选）写演示数据
DB_BACKEND=postgres npm run db:seed
```

> **不要**直接 `drizzle-kit migrate`：CLI 不读 `@next/env`，拿不到 `.env.local` 的
> `DATABASE_URL`，且缺少 `migrate.ts` 里的防呆逻辑。统一走 `npm run db:migrate`。

> **不要**手改 `./migrations/*.sql`：每次 `db:generate` 会重新生成，手改会被覆盖。
> 需要定制迁移时，改 `schema.ts` 后重新 generate，或追加新的迁移文件。

## 向量检索（M1 只落骨架）

当前 CloudBase 实例**未提供 pgvector 扩展**（CREATE EXTENSION 被拒）。因此：

- embedding 用 PostgreSQL 原生 `real[]`（float4[]）存储；
- 相似度在 Node 应用层用余弦距离计算（`lib/db/postgres.ts:searchVector`）；
- `db/drizzle/schema.ts` 不含任何 `vector` 类型列，`db/schema.sql` 不含 `knowledge_entries` 表（属 M4）。

pgvector 可用后的改造路径：`ALTER TABLE ... ALTER COLUMN embedding TYPE vector(1024)`，
并把 `searchVector` 的应用层余弦换成 `<=>` 算子下推，接口签名不变。详见
`docs/ops/pgvector-enabled.md` 与 `docs/ops/embedding-dim.md`。

## 重要约束（AD-1）

`db/**` 与 `lib/db/**` 之外的代码（尤其 `lib/services/**`、`app/**`）**禁止** import
`drizzle-orm` / `postgres` / `@/db/drizzle`，业务层只认 `lib/db/index.ts` 门面。
由 `.eslintrc.json` 的 `no-restricted-imports` 强制，违反即 lint 失败。
