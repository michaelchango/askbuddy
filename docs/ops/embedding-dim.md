# Embedding 维度（M4 知识复利）

## 结论

`EMBEDDING_DIMENSIONS` **= 1024**（不可变，R3 红线）。定义在 `lib/ai/embedding.ts`，
与 `db/schema.sql` 的 `vector(1024)`、`db/drizzle/schema.ts` 的
`vector("embedding", { dimensions: 1024 })` 强绑定。

## 为什么不可逆

`knowledge_entries.embedding` 用 pgvector 的 `vector(1024)` 存储。PG 的 vector(N)
维度是列类型的一部分，一旦建表落定，改维度需要 `ALTER TYPE`（对既有数据是破坏性
操作，需重算全表向量）。因此建表前必须实测模型维度（`scripts/poc/embedding-probe.ts`）。

## 模型

腾讯 **TokenHub** 向量模型 `kinfra-text-embedding-0.6b`，**固定输出 1024 维**
（模型自身决定，`dimensions` 参数不可自定义 —— 这正是它能承接 1024 红线的原因）。

| 项 | 值 |
| --- | --- |
| 接口 | `POST {TOKENHUB_BASE}/embeddings`（OpenAI 兼容协议） |
| 广州地域 | `https://tokenhub.tencentmaas.com/v1`（默认） |
| 新加坡地域 | `https://tokenhub-intl.tencentmaas.com/v1` |
| 鉴权 | `Authorization: Bearer $TOKENHUB_API_KEY` |
| 请求体 | `{ model, input, encoding_format: "float" }` |
| 响应 | `{ data: [{ index, embedding: number[] }], usage: {...} }` |

- 密钥：`TOKENHUB_API_KEY`（独立于 `CLOUDBASE_SECRET` 生成密钥 —— 非对称密钥分离，
  见 `lib/ai/embedding.ts` 头注释）。
- 模型名：`EMBED_MODEL` 环境变量可覆盖（默认 `kinfra-text-embedding-0.6b`）。
- 注意事项：**不支持跨地域调用**，Key 与地域必须匹配，否则鉴权失败。

## 存储形态

`embedding vector(1024)`，检索由 `lib/db/{postgres,cloudbase}.ts` 的 `searchVector`
经 `1 - (embedding <=> $q::vector)` 余弦距离下推到 SQL 层。软删（`status='deprecated'`）
时置 `embedding = NULL`，禁参与检索。

## 建表闸门

1. 确认 pgvector 已开通：`npm run db:setup:cloudbase`（脚本会 `CREATE EXTENSION vector`）。
2. 实测维度：`npx tsx scripts/poc/embedding-probe.ts`，输出维度 === 1024 才可建表。
3. 建表：执行 `db/schema.sql` 中的 `knowledge_entries`（或 `db:setup` 全量）。

> ✅ **现状（2026-09-22）**：闸门已通过。真实调用 TokenHub 实测返回 1024 维，
> 与 `EMBEDDING_DIMENSIONS` 一致。

### 踩过的坑（务必保留这段经验）

- **闸门脚本曾有假通过**：`scripts/poc/embedding-probe.ts` 早期在 import 顺序上犯错
  （先 import embedding 模块、后 `loadEnvConfig`）。ESM 的 import 提升会让模块级密钥
  常量在装载前求值 → 恒 undefined → 静默走确定性 mock，脚本却打印「✓ 维度 1024」。
  现已修正为 `import "../_env"` 优先，并新增 `embeddingMockActive()` 防伪断言。
- **不要在脚本体内先 import 业务模块再 `loadEnvConfig`**：`scripts/_env.ts` 就是为此
  存在的独立装载模块，所有验证/回填脚本必须以它作为第一个 import。
- **已废弃：hunyuan 直连**。曾直连 `hunyuan.tencentcloudapi.com` 的 `GetEmbedding`
  （自签 TC3-HMAC-SHA256），但该账号未开通 embedding 服务，恒返回
  `FailedOperation.ServiceNotActivated`；且该 API 的参数契约与常见假设不符
  （接受 `Input` / `InputList`，**不接受** `Model` / `Inputs`），自签协议维护成本高。
  2026-09 已整体切到 TokenHub，旧实现从代码中删除（需要时可从 git 历史取回）。

## 历史

M1 阶段 pgvector 曾不可用，故当时落的是 `real[]` 应用层余弦骨架。M1 收尾时用户决策
启用真 pgvector（见 `pgvector-enabled.md`），M4 正式落 `vector(1024)` 下推检索。
M4 早期 embedding 走混元直连，2026-09 切换到 TokenHub。
