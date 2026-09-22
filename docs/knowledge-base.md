# 知识库（M4 知识复利）

## 目标

让平台从「每个需求各做各的」升级为「同一项目下知识跨需求累积复用」：沉淀已确立的
业务规则 / 术语 / 决策 / 约束，生成时 AI 自动引用并溯源。

## 架构

```
用户对话/生成
  → lib/ai/context/builder.ts（buildStepContext 并行召回知识）
    → lib/services/knowledge.ts retrieveRelevantKnowledge
      → searchKnowledgeEntries（pgvector 余弦下推 1-(embedding<=>$q)）
        → knowledge_entries.embedding vector(1024)
  → 组装 prompt（知识段 + budget 预算裁剪）
    → AI step 生成
      → DevContext _source.knowledge_ids 溯源（幻觉 id 白名单过滤）

M3 decisions（已确认）
  → lib/services/knowledge-extractor.ts extractFromDecisions（三道去重闸）
    → knowledge_entries
```

## 关键约束（不可逆，R3 红线）

- **维度 1024 不可改**：`EMBEDDING_DIMENSIONS = 1024`（`lib/ai/embedding.ts`）与
  `vector(1024)`（`db/schema.sql` / `db/drizzle/schema.ts`）强绑定。改维度要重建表。
- **软删除保留溯源**：`deleteKnowledge` 置 `status='deprecated'` + `embedding=NULL`，
  不物理删除 —— DevContext `_source.knowledge_ids` 会引用知识 id，物理删除会打红溯源校验。
- **召回失败不阻断**：`retrieveRelevantKnowledge` 全程 catch，失败回退「最近 N 条 active」，
  绝不抛出（M4 总原则：增强不阻断主流程）。

## Embedding

走 **腾讯 TokenHub**（OpenAI 兼容协议）：`POST {TOKENHUB_BASE}/embeddings`，
Bearer 鉴权，模型 `kinfra-text-embedding-0.6b`（固定 1024 维，承接 R3 红线）。

密钥与生成密钥（`CLOUDBASE_SECRET`）分开管理——非对称密钥分离，
防越权（embedding 密钥泄露也仅能读语义、无法伪造生成内容）。

> 历史：曾直连 hunyuan.tencentcloudapi.com + TC3-HMAC-SHA256，因账号未开通
> embedding 服务且自签维护成本高，2026-09 已整体切到 TokenHub（旧实现已删除）。
> 维度闸门与踩坑经验见 `docs/ops/embedding-dim.md`。

- CloudBase Node SDK **无 embedding 接口**（仅 `createModel` 文本 + `createImageModel`），
  故直连 HTTP API。
- 失败返回 `null`（调用方降级关键词检索），TTL 60s 冷却替代永久闩锁。
- 无密钥/mock 时走确定性伪向量（1024 维），保证「无凭证也能联调」。

## 数据模型

`knowledge_entries`（项目级，`project_id` 外键 + RLS）：

| 列 | 说明 |
| --- | --- |
| `embedding` | `vector(1024)`，软删后 `NULL`（禁参与检索） |
| `category` | `rule` / `term` / `decision` / `constraint` |
| `source_type` | `manual`（人工）/ `decision`（从 decisions 沉淀） |
| `source_decision_id` | 沉淀上游 decisions.id（去重闸门一） |
| `source_hash` | 内容 sha256 指纹（去重闸门二） |
| `status` | `active` / `deprecated`（软删） |

## 去重三道闸

1. `source_decision_id`：同一 decision 只沉淀一次（确定性生效，闸门一）。
2. 标题 normalize（去空白 + 小写）：同项目内已存在同标题则跳过（`reason=title_dup`）。
   > 注：`source_hash` 目前只在 CRUD 侧计算并落库，抽取链路未用它做去重判定。
3. 语义：embedding 余弦相似度 ≥ 0.95 视为重复（`reason=semantic_dup`）。
   > ⚠️ **该闸仅在「能拿到向量」时生效**（`knowledge-extractor.ts:150`）。若 embedding
   > 不可用（如混元 Embedding 服务未开通），本闸**静默跳过**，知识库失去语义级去重保护——
   > 此时仅剩闸门一与精确标题匹配两道防线。

## 预算裁剪

`lib/ai/context/budget.ts`：知识段总预算 12000 字符，单条 2000。优先级
`card > upstream > existingDoc > history > knowledge`（知识最先裁）。

## API

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/api/projects/[id]/knowledge` | GET/POST | 列表 / 创建 |
| `/api/projects/[id]/knowledge/[entryId]` | GET/PATCH/DELETE | 详情 / 更新 / 软删 |
| `/api/projects/[id]/knowledge/search` | POST | 语义检索（Bearer/PAT，MCP 可用） |
| `/api/projects/[id]/knowledge/extract` | POST | 沉淀触发（dryRun 预览） |
| `/api/projects/[id]/knowledge/backfill` | POST | embedding 回填 |
| `/api/mcp/knowledge/search` | POST/GET | MCP 平台侧检索 |

## MCP

`search_knowledge` 工具（`mcp/server.ts`）：`projectId` + `query` + `topK`，
经 `callPlatform`（支持 POST）调 `/api/mcp/knowledge/search`。输出裁剪，不携带 embedding。

## 回填

- 创建时 `refreshEmbedding` fire-and-forget。
- `scripts/backfill-embeddings.ts [projectId]`：为 active 且未索引条目批量回填。
- UI「未索引」徽标标记 embedding 尚未就绪的条目。

## 建表闸门

1. pgvector 已开通（`docs/ops/pgvector-enabled.md`）。
2. `npx tsx scripts/poc/embedding-probe.ts` 实测维度 === 1024。
3. `db:setup`（或 `db:setup:cloudbase`）建 `knowledge_entries`。
