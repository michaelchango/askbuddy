# pgvector 可用性（M1 收尾）

## 结论

**CloudBase PostgreSQL 环境现已提供 pgvector 扩展**（用户决策：M1 收尾改用真向量检索）。

- 建库脚本 `scripts/db-setup-cloudbase.ts` 在初始化时已执行 `CREATE EXTENSION IF NOT EXISTS vector`。
- `lib/db/cloudbase.ts` 与 `lib/db/postgres.ts` 的 `searchVector` 均走 `1 - (col <=> $q::vector)`
  在 SQL 层下推余弦相似度（`<==>` 为 pgvector 余弦距离），业务零改动。
- 之前「无 pgvector → 用 real[] + 应用层余弦」的临时方案已废弃。

## 如何确认

```sql
SELECT extname FROM pg_extension WHERE extname = 'vector';
-- 返回 vector → 扩展已安装，可用
```

也可用本仓库脚本在线探测：

```bash
npm run db:probe          # 看通道状态
npm run verify:embedding  # （postgres 后端）实测向量维度与下推
```

## 为什么能直接用 pgvector（本环境）

pgvector 是 PostgreSQL 的托管扩展，是否可用取决于 CloudBase 实例的扩展白名单。
本环境的可用扩展列表里**包含** `vector`（及 `vectorscale`、`zhparser` / `pg_jieba` 中文分词），
因此可创建该类型并用 `<=>` 算子做 SQL 层向量检索。

## 現状与使用约定

- embedding 列（M4 的 `knowledge_entries` 等）用 `vector(N)` 存储；
- 维度不可逆，**建表前**必须用 `verify:embedding` 实测确认（参考 `EMBEDDING_DIM`）；
- `lib/db` 三后端（mock / nosql 回落、postgres / cloudbase 下推）对 `searchVector` 语义一致，
  由对拍测试 `db-pushdown-parity.test.ts` 保证。
