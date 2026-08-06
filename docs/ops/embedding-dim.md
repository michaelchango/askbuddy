# Embedding 维度（M1）

## 结论

`EMBEDDING_DIM` 默认 **1024**。可在 `.env.local` 覆盖。

```
EMBEDDING_DIM=1024
```

## 背景

M1 的向量检索（`lib/db/postgres.ts:searchVector`）只落**骨架 + 对拍单测**，不接业务
（业务接入在 M4 知识复利）。因此 M1 阶段**不会真正生成任何 embedding**，维度只是预留配置。

## 维度选型

主流 embedding 模型的输出维度：

| 模型 | 维度 |
| --- | --- |
| OpenAI text-embedding-3-small | 1536 |
| OpenAI text-embedding-3-large | 3072 |
| bge-m3（常见开源） | 1024 |
| Cohere embed-multilingual-v3 | 1024 |

选 **1024** 作为默认是「安全的中间值」：
- 与 bge-m3 / Cohere 对齐，若 M4 用这类模型无需改造；
- `real[]`（float4[]）存储下，1024 维每行约 4KB，单表百万行约 4GB，可接受；
- M4 确定具体模型后，按模型维度设 `EMBEDDING_DIM` 即可，无需改代码。

## 存储形态

embedding 以 PostgreSQL 原生 `real[]`（float4[]）存储，**不是** `vector` 类型
（当前 CloudBase 实例未提供 pgvector 扩展，见 `pgvector-enabled.md`）。
相似度在 Node 应用层用余弦距离计算（`lib/db/backend.ts:cosineSimilarity`）。

pgvector 可用后的改造路径：`ALTER TABLE ... ALTER COLUMN embedding TYPE vector(1024)`，
并把 `searchVector` 的应用层余弦换成 `<=>` 算子下推，接口签名不变。
