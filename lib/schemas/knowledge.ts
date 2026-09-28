// 知识库（M4 知识复利）的 Zod schema 与类型。零运行时依赖（只 import zod），
// 可被服务端与客户端同时 import（与 lib/schemas/devcontext.ts 同理）。

import { z } from "zod";

/** 知识类别。rule=业务规则 / term=术语 / decision=决策 / constraint=约束。 */
export const KNOWLEDGE_CATEGORIES = ["rule", "term", "decision", "constraint"] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

/** 知识来源类型。manual=人工录入 / decision=从 M3 decisions 沉淀。 */
export const KNOWLEDGE_SOURCE_TYPES = ["manual", "decision"] as const;
export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

/** 知识状态。active=正常 / deprecated=软删（保留溯源引用，embedding 置 NULL）。 */
export const KNOWLEDGE_STATUSES = ["active", "deprecated"] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const CategoryLabel: Record<KnowledgeCategory, string> = {
  rule: "业务规则",
  term: "术语",
  decision: "决策",
  constraint: "约束",
};

/** 创建知识条目的输入。 */
export const CreateKnowledgeSchema = z.object({
  title: z.string().trim().min(1, "标题不能为空").max(200),
  content: z.string().trim().min(1, "内容不能为空"),
  category: z.enum(KNOWLEDGE_CATEGORIES).default("rule"),
  sourceType: z.enum(KNOWLEDGE_SOURCE_TYPES).default("manual"),
  sourceRef: z.string().trim().max(500).nullish(),
  sourceDecisionId: z.string().nullish(),
});

/** 更新知识条目（部分字段，仅 content 变化才重算 embedding）。 */
export const UpdateKnowledgeSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).optional(),
  category: z.enum(KNOWLEDGE_CATEGORIES).optional(),
  sourceRef: z.string().trim().max(500).nullish(),
});

/** 语义检索请求体。 */
export const SearchKnowledgeSchema = z.object({
  query: z.string().trim().min(1, "查询词不能为空"),
  topK: z.number().int().min(1).max(50).default(8),
  category: z.enum(KNOWLEDGE_CATEGORIES).optional(),
  minSimilarity: z.number().min(-1).max(1).default(0),
});

export type CreateKnowledgeInput = z.infer<typeof CreateKnowledgeSchema>;
export type UpdateKnowledgeInput = z.infer<typeof UpdateKnowledgeSchema>;
export type SearchKnowledgeInput = z.infer<typeof SearchKnowledgeSchema>;

/** 落库的知识条目行（代码键口径，与 lib/db/field-map.ts 对齐）。 */
export interface KnowledgeItem {
  id: string;
  project_id: string;
  title: string;
  content: string;
  /** number[]（1024 维），软删后为 null。 */
  embedding: number[] | null;
  category: KnowledgeCategory;
  source_type: KnowledgeSourceType;
  source_ref: string | null;
  source_decision_id: string | null;
  source_hash: string | null;
  status: KnowledgeStatus;
  access_count: number;
  created_at: string;
  updated_at: string;
}

/** 检索结果（附相似度得分与降级标记）。 */
export interface KnowledgeSearchResult extends KnowledgeItem {
  score: number;
}

/** 注入生成上下文的轻量引用（不携带 embedding，避免把 1024 维向量塞进 prompt）。 */
export interface KnowledgeRef {
  id: string;
  title: string;
  content: string;
  category: KnowledgeCategory;
  score: number;
}
