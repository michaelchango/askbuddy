# 字段契约审计（M1）

> 本文件是 M1「NoSQL → CloudBase PostgreSQL」字段映射决策的勘定记录。
> 运行时映射以 `lib/db/field-map.ts` 为准；本文件解释「为什么这么映射」。
> 三副本一致性由 `npm run db:check`（`scripts/check-db-contract.ts`）强制校验。

## 1. 字段名风格漂移（核心痛点）

NoSQL 是 schema-less，字段名写错只是多一个无人读的字段。PG 会硬报错
`column "xxx" does not exist`。历史代码在两套命名之间漂移：

| 表 | 风格 | 漂移字段 |
| --- | --- | --- |
| `projects` | **混合** | `ownerId` / `createdAt` / `updatedAt` 是 camel；`deleted_at` 是 snake |
| `requirements` | **混合** | `projectId` / `titleSource` / `createdAt` / `updatedAt` 是 camel；其余 snake |
| 其余 14 张表 | snake_case | 全 snake |

为保持**业务代码零改动**（AD-1 硬约束），差异在 `field-map.ts` 一次性消化：
代码用 camelCase 键，映射层把它翻译成 PG 的 snake_case 列名。

## 2. 新增 / 删除 / 改名的列

### 删除（M1 明确不再需要）
- `requirements.status`：僵尸列，唯一事实源是 `requirement_steps.state`
  （派生逻辑见 `lib/stage.ts:deriveRequirementStatus`）。历史上写死 `'dialoguing'` 从不更新。
- `prds.cos_key` / `prd_versions.cos_key`：恒为空字符串且从未被消费（PRD 导出改为前端即时生成下载）。

### 改名
- `prototypes.cos_key` / `prototype_versions.cos_key` → `html_storage_key`。
  代码侧 14 处引用 `html_storage_key`、0 处引用 `cos_key`，语义是「通用对象存储 key」，
  当前落 `objects` 表（CloudBase 环境未开通 COS）。

### 冗余 id 列（M1 保留，M2 移除）
`research_analysis` / `solutions` / `prototypes` / `prds` 四张「需求一对一主态表」
额外保留一个恒等于 `requirement_id` 的 `id` 列。原因：MCP 路径
（`app/api/mcp/requirement/[id]/research/route.ts`、`.../prototype/route.ts`）绕过
`getOutput()` 直接 `db.get(table, id)` 用默认 `idKey="id"`，靠「代码同时写了
id 和 requirement_id 且相等」这个巧合工作。PG 不建 id 列会让这两个 MCP 工具立即 500。
M2（MCP 扩展）统一改为走 `getOutput()` 后，再 `DROP COLUMN id`。

## 3. 类型语义保真（最难的回归点）

- **时间列 `TIMESTAMPTZ`**：读出统一 `.toISOString()` 转字符串。代码全链路把时间当字符串用，
  含 `a.created_at < b.created_at` 字典序比较；若返回 `Date` 对象，比较会退化为
  `[object Date] < [object Date]`（恒 false），排序静默错乱且不报错。
- **大整数 `BIGINT`**：`conversations.id` 是 `Date.now()`（代码当数字排序），
  postgres.js 默认把 int8 返回为字符串（防精度丢失），在 `toRow` 统一 `Number()` 转回数字。
- **布尔语义列 `SMALLINT`**：`maybe_stale` / `awaiting_confirm` 用 `SMALLINT` 而非 `BOOLEAN`，
  因为代码写 `1/0`、读 `!!r.awaiting_confirm`；用 `BOOLEAN` 会破坏三后端语义等价。
- **JSONB 写入防误判**：JS 数组会被 postgres.js 误判为 PG 数组，`toColumns` 对 JSONB 列
  统一 `JSON.stringify`，由 PG 依列类型解析为 jsonb。
- **ENUM → TEXT + CHECK**：PG 原生 ENUM 加值需 `ALTER TYPE`，对迭代不友好；一律降级为
  `TEXT` + `CHECK` 约束（如 `status` / `role` / `step` / `state`）。

## 4. 契约三副本一致性

同一份表结构在三个地方必须同步修改，否则症状都是「某字段在某条路径上静默丢失」：

1. `db/drizzle/schema.ts` —— 机器事实源（drizzle-kit 据此生成迁移）
2. `db/schema.sql` —— 人读基线（不被任何程序执行）
3. `lib/db/field-map.ts` —— 运行时映射（含 TIMESTAMP_COLS / JSONB_COLS / BIGINT_COLS /
   ALLOWED_ID_KEYS / ORDER_HINT）

> ⚠️ **已知坑**：drizzle-kit 0.24.x 生成迁移时会**丢弃**表上的 `CHECK` 约束。
> `db/drizzle/migrate.ts` 在 drizzle migrator 跑完后，从 `schema.ts` 取出全部 `check()`
> 定义用幂等 DO 块补建，保证线上库与 `db/schema.sql` 的校验意图一致。改 `check()` 后
> 重新 `db:generate` + `db:migrate` 即可，无需手动维护约束 SQL。

改结构的标准动作：
```
改 db/drizzle/schema.ts → npm run db:generate → 同步 db/schema.sql 注释
  → 同步 lib/db/field-map.ts → npm run db:check
```
