// 知识库服务（M4 知识复利）：CRUD + 软删 + 语义检索 + 召回 + 降级。
//
// 【M4 总原则：增强不阻断主流程】
// 所有 embedding 调用失败返回 null，检索降级为「最近 N 条 active 知识」；
// 检索全程 catch，绝不抛出。知识只是生成链路的「外挂增强」，不是前置依赖。

import crypto from "crypto";
import { db } from "@/lib/db";
import { embedText, embedTexts, EMBEDDING_DIMENSIONS } from "@/lib/ai/embedding";
import { invalidateCache } from "@/lib/utils/memo";
import type {
  CreateKnowledgeInput,
  KnowledgeItem,
  KnowledgeRef,
  KnowledgeSearchResult,
  SearchKnowledgeInput,
} from "@/lib/schemas/knowledge";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 语义检索默认召回数。 */
const DEFAULT_TOPK = 8;
/** 相似度下限：低于此值视为不相关（-1..1，1 为完全相同）。 */
const MIN_SIMILARITY = 0;
/** 生成链路注入上下文的知识条数上限。 */
const RETRIEVE_LIMIT = 6;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 内容去重指纹：normalize 后 sha256（三道去重闸之一）。 */
export function computeSourceHash(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim().toLowerCase();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function normalizeEmbedding(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  if (v.length !== EMBEDDING_DIMENSIONS) return null;
  return v as number[];
}

function invalidateKnowledgeCache(projectId?: string): void {
  invalidateCache("listKnowledge:*");
  invalidateCache(`listKnowledge:${projectId ?? "*"}`);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface ListKnowledgeQuery {
  category?: string;
  status?: "active" | "deprecated";
  limit?: number;
}

/** 列出项目知识（默认只返回 active）。 */
export async function listKnowledge(
  projectId: string,
  q: ListKnowledgeQuery = {}
): Promise<KnowledgeItem[]> {
  const where: Record<string, unknown> = { project_id: projectId };
  if (q.category) where.category = q.category;
  // 默认只返回 active；显式传 status 才覆盖。
  if (q.status) where.status = q.status;
  else where.status = "active";

  const rows = await db.findMany<KnowledgeItem>("knowledge_entries", {
    where: Object.fromEntries(
      Object.entries(where).map(([k, v]) => [k, { eq: v }])
    ),
    orderBy: [["updated_at", "desc"]],
    limit: q.limit ?? 500,
  });
  // 不外泄 1024 维向量（列表页不需要，也避免 JSON 体积爆炸）。
  return rows.map((r) => ({ ...r, embedding: null }));
}

/** 获取单条知识（不返回 embedding，供 UI 编辑/详情）。 */
export async function getKnowledge(
  projectId: string,
  entryId: string
): Promise<KnowledgeItem | undefined> {
  const row = await db.get<KnowledgeItem>("knowledge_entries", entryId);
  if (!row || row.project_id !== projectId) return undefined;
  return { ...row, embedding: null };
}

/** 创建知识：fire-and-forget 触发 embedding 计算。 */
export async function createKnowledge(
  projectId: string,
  input: CreateKnowledgeInput
): Promise<KnowledgeItem> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const item: KnowledgeItem = {
    id,
    project_id: projectId,
    title: input.title.trim(),
    content: input.content.trim(),
    embedding: null,
    category: input.category,
    source_type: input.sourceType,
    source_ref: input.sourceRef ?? null,
    source_decision_id: input.sourceDecisionId ?? null,
    source_hash: computeSourceHash(input.content),
    status: "active",
    access_count: 0,
    created_at: now,
    updated_at: now,
  };

  await db.insert("knowledge_entries", item);
  invalidateKnowledgeCache(projectId);

  // fire-and-forget：embedding 失败不阻塞创建（软删/未索引由 UI 徽标兜底）。
  void refreshEmbedding(projectId, id);

  return { ...item, embedding: null };
}

/** 更新知识：仅 content 变化时重算 embedding。 */
export async function updateKnowledge(
  projectId: string,
  entryId: string,
  input: { title?: string; content?: string; category?: KnowledgeItem["category"]; source_ref?: string | null }
): Promise<KnowledgeItem | undefined> {
  const existing = await db.get<KnowledgeItem>("knowledge_entries", entryId);
  if (!existing || existing.project_id !== projectId) return undefined;

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  let contentChanged = false;
  if (input.title !== undefined && input.title.trim() !== "") patch.title = input.title.trim();
  if (input.content !== undefined && input.content.trim() !== "") {
    patch.content = input.content.trim();
    patch.source_hash = computeSourceHash(input.content);
    contentChanged = input.content.trim() !== existing.content;
  }
  if (input.category !== undefined) patch.category = input.category;
  if (input.source_ref !== undefined) patch.source_ref = input.source_ref ?? null;

  await db.update("knowledge_entries", entryId, patch);
  invalidateKnowledgeCache(projectId);

  if (contentChanged) {
    // content 变化：清空旧向量并异步重算，避免旧向量污染检索。
    await db.update("knowledge_entries", entryId, { embedding: null });
    void refreshEmbedding(projectId, entryId);
  }

  const updated = await db.get<KnowledgeItem>("knowledge_entries", entryId);
  return updated ? { ...updated, embedding: null } : undefined;
}

/** 软删：status='deprecated' + embedding=NULL（保留 DevContext 溯源引用）。 */
export async function deleteKnowledge(projectId: string, entryId: string): Promise<void> {
  const existing = await db.get<KnowledgeItem>("knowledge_entries", entryId);
  if (!existing || existing.project_id !== projectId) return;

  await db.update("knowledge_entries", entryId, {
    status: "deprecated",
    embedding: null,
    updated_at: new Date().toISOString(),
  });
  invalidateKnowledgeCache(projectId);
}

// ---------------------------------------------------------------------------
// embedding 回填（fire-and-forget）
// ---------------------------------------------------------------------------

/** 计算并写回单条 embedding。失败静默（增强不阻断），由回填脚本兜底。 */
async function refreshEmbedding(projectId: string, entryId: string): Promise<void> {
  try {
    const row = await db.get<KnowledgeItem>("knowledge_entries", entryId);
    if (!row || row.project_id !== projectId || row.status !== "active") return;

    const vec = await embedText(row.content);
    if (!vec) return; // 失败返回 null，不写入

    await db.update("knowledge_entries", entryId, {
      embedding: vec,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[knowledge] refreshEmbedding 失败（entry=${entryId}）：${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// 语义检索 + 召回
// ---------------------------------------------------------------------------

/**
 * 语义检索：pgvector 余弦下推。失败降级为「最近 N 条 active」。
 * 返回附 score 与 degraded 标记的结果。
 */
export async function searchKnowledgeEntries(
  opts: {
    projectId: string;
    query: string;
    topK?: number;
    category?: string;
    minSimilarity?: number;
  }
): Promise<{ results: KnowledgeSearchResult[]; degraded: boolean }> {
  const topK = opts.topK ?? DEFAULT_TOPK;
  const minSim = opts.minSimilarity ?? MIN_SIMILARITY;

  const where: Record<string, unknown> = { project_id: opts.projectId, status: "active" };
  if (opts.category) where.category = opts.category;

  try {
    const vec = await embedText(opts.query);
    if (!vec) {
      // embedding 失败：关键词降级
      return { results: await keywordFallback(opts.projectId, opts.query, topK), degraded: true };
    }

    const rows = await db.searchVector<KnowledgeItem>("knowledge_entries", {
      column: "embedding",
      query: vec,
      topK: Math.max(topK * 2, topK), // 多召回再按相似度截断
      where: Object.fromEntries(Object.entries(where).map(([k, v]) => [k, { eq: v }])),
      minScore: minSim,
    });

    // 命中不足时用关键词兜底补足。
    let results = rows.slice(0, topK).map((r) => ({
      ...r,
      embedding: null as number[] | null,
      score: r.score,
    }));

    if (results.length < topK) {
      const keyword = await keywordFallback(opts.projectId, opts.query, topK - results.length);
      const seen = new Set(results.map((r) => r.id));
      for (const k of keyword) {
        if (!seen.has(k.id)) {
          results.push(k);
          seen.add(k.id);
        }
      }
    }

    return { results, degraded: false };
  } catch (e) {
    console.error(`[knowledge] searchKnowledgeEntries 异常：${(e as Error).message}`);
    return { results: await keywordFallback(opts.projectId, opts.query, topK), degraded: true };
  }
}

/** 关键词兜底：LIKE 匹配 title/content，按更新时间排序。 */
async function keywordFallback(
  projectId: string,
  query: string,
  limit: number
): Promise<KnowledgeSearchResult[]> {
  try {
    const keyword = query.trim().slice(0, 50);
    const rows = await db.findMany<KnowledgeItem>("knowledge_entries", {
      where: {
        project_id: { eq: projectId },
        status: { eq: "active" },
      },
      orderBy: [["updated_at", "desc"]],
      limit: 200,
    });
    // 内存过滤：title/content 含关键词（大小写不敏感）
    const lower = keyword.toLowerCase();
    const matched = rows.filter(
      (r) =>
        r.title.toLowerCase().includes(lower) || r.content.toLowerCase().includes(lower)
    );
    return matched
      .slice(0, limit)
      .map((r) => ({ ...r, embedding: null as number[] | null, score: 0.3 }));
  } catch {
    return [];
  }
}

/**
 * 生成链路召回：检索相关知识并裁剪为轻量 KnowledgeRef。
 * 失败返回 []（绝不阻断生成）。
 */
export async function retrieveRelevantKnowledge(
  projectId: string,
  queryText: string,
  limit = RETRIEVE_LIMIT
): Promise<KnowledgeRef[]> {
  if (!queryText || !projectId) return [];
  try {
    const { results } = await searchKnowledgeEntries({
      projectId,
      query: queryText.slice(0, 500),
      topK: limit,
      minSimilarity: MIN_SIMILARITY,
    });
    // 命中后递增 access_count（fire-and-forget，不阻塞）。
    void bumpAccessCount(results.map((r) => r.id));

    return results.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      category: r.category,
      score: r.score,
    }));
  } catch (e) {
    console.error(`[knowledge] retrieveRelevantKnowledge 异常：${(e as Error).message}`);
    return [];
  }
}

async function bumpAccessCount(ids: string[]): Promise<void> {
  try {
    for (const id of ids) {
      const row = await db.get<KnowledgeItem>("knowledge_entries", id);
      if (row) {
        await db.update("knowledge_entries", id, {
          access_count: (row.access_count ?? 0) + 1,
        });
      }
    }
  } catch {
    /* 计数失败不阻塞 */
  }
}

/** 批量回填：为 status=active 且 embedding 为 NULL 的条目计算向量。返回成功数。 */
export async function backfillEmbeddings(projectId: string): Promise<number> {
  const rows = await db.findMany<KnowledgeItem>("knowledge_entries", {
    where: { project_id: { eq: projectId }, status: { eq: "active" } },
    limit: 1000,
  });
  const pending = rows.filter((r) => normalizeEmbedding(r.embedding) === null);
  if (pending.length === 0) return 0;

  const texts = pending.map((r) => r.content);
  const vectors = await embedTexts(texts);
  let done = 0;
  for (let i = 0; i < pending.length; i++) {
    const vec = vectors[i];
    if (vec && vec.length === EMBEDDING_DIMENSIONS) {
      try {
        await db.update("knowledge_entries", pending[i].id, {
          embedding: vec,
          updated_at: new Date().toISOString(),
        });
        done++;
      } catch {
        /* 单条失败跳过 */
      }
    }
  }
  if (done > 0) invalidateKnowledgeCache(projectId);
  return done;
}
