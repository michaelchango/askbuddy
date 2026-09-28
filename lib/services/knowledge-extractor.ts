// 知识自动沉淀（M4 知识复利）：从 M3 已确认 decisions 抽取 → 落 knowledge_entries。
//
// 【三道去重闸】
//   1. source_decision_id：同一 decision 只沉淀一次（闸门一）
//   2. title：同项目内标题（normalize 后）重复则跳过（闸门二）
//   3. 语义：embedding 余弦相似度 ≥ 0.95 视为重复（闸门三，仅在能拿到向量时生效）
//
// 【触发方式】
//   自动：需求完成（prd_writing done）后异步调用 extractFromDecisions
//   手动：知识库管理页 / 需求页「沉淀知识」按钮 → API（含 dryRun 预览）

import { db } from "@/lib/db";
import { getPrompt } from "@/lib/ai/prompts";
import { callAI } from "@/lib/ai/client";
import { embedText, EMBEDDING_DIMENSIONS } from "@/lib/ai/embedding";
import { computeSourceHash, createKnowledge } from "@/lib/services/knowledge";
import type { KnowledgeCategory } from "@/lib/schemas/knowledge";

interface DecisionRow {
  id: string;
  requirement_id: string;
  suggestion_id: string;
  summary: string | null;
}

interface ExtractedItem {
  title: string;
  content: string;
  category: KnowledgeCategory;
}

export interface ExtractResult {
  extracted: number;
  skipped: number;
  items: Array<{ title: string; content: string; category: KnowledgeCategory; reason: string }>;
}

const SEMANTIC_DUP_THRESHOLD = 0.95;

/** 解析 AI 输出（```json 代码块内）为抽取项列表。失败返回 []。 */
function parseExtractOutput(raw: string): ExtractedItem[] {
  const m = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/(\{[\s\S]*\})/);
  if (!m) return [];
  try {
    const obj = JSON.parse(m[1]);
    const items = obj?.items;
    if (!Array.isArray(items)) return [];
    return items
      .filter((it) => it && typeof it.title === "string" && typeof it.content === "string")
      .map((it) => ({
        title: String(it.title).trim().slice(0, 200),
        content: String(it.content).trim().slice(0, 2000),
        category: (["rule", "term", "decision", "constraint"].includes(it.category)
          ? it.category
          : "rule") as KnowledgeCategory,
      }))
      .filter((it) => it.title && it.content);
  } catch {
    return [];
  }
}

/** 读取项目下、已确认（有 summary 且非 ignored）的 decisions。 */
async function listProjectDecisions(projectId: string): Promise<DecisionRow[]> {
  // decisions 无 project_id 列，经 requirement 归集到项目。
  const reqs = await db.findMany<{ id: string }>("requirements", {
    where: { projectId: { eq: projectId } },
  });
  const reqIds = reqs.map((r) => r.id);
  if (reqIds.length === 0) return [];

  const decisions = await db.findMany<DecisionRow>("decisions", {
    where: { requirement_id: { in: reqIds } },
    orderBy: [["confirmed_at", "desc"]],
  });
  return decisions.filter((d) => {
    const s = (d.summary ?? "").trim();
    return s && s !== "ignored";
  });
}

/**
 * 从 decisions 抽取知识并入库。
 * dryRun=true 时只返回抽取结果，不写库（供「沉淀知识」预览）。
 */
export async function extractFromDecisions(
  projectId: string,
  opts: { dryRun?: boolean; limit?: number } = {}
): Promise<ExtractResult> {
  const decisions = await listProjectDecisions(projectId);
  if (decisions.length === 0) {
    return { extracted: 0, skipped: 0, items: [] };
  }

  // 闸门一：过滤已沉淀过的 decision（source_decision_id 已存在）。
  const already = await db.findMany<{ source_decision_id: string | null }>(
    "knowledge_entries",
    { where: { project_id: { eq: projectId } } }
  );
  const knownDecisionIds = new Set(
    already.map((k) => k.source_decision_id).filter(Boolean) as string[]
  );
  const pending = decisions.filter((d) => !knownDecisionIds.has(d.id)).slice(0, opts.limit ?? 100);
  if (pending.length === 0) {
    return { extracted: 0, skipped: 0, items: [] };
  }

  // 闸门二：标题去重（同项目内已有条目标题 normalize 后集合）。
  const existingEntries = already as unknown as Array<{
    title: string;
    content: string;
    embedding: number[] | null;
  }>;
  const existingTitles = new Set(
    existingEntries.map((e) => (e.title ?? "").replace(/\s+/g, "").toLowerCase())
  );

  // 调 AI 抽取。
  const prompt = getPrompt("knowledge_extract");
  const user = prompt.buildUser({
    message: "",
    decisions: pending.map((d) => ({ id: d.id, summary: d.summary ?? "" })),
    projectName: "",
  });
  const res = await callAI("knowledge_extract", [
    { role: "system", content: prompt.system },
    { role: "user", content: user },
  ]);

  const items = parseExtractOutput(res.content);
  if (items.length === 0) {
    return { extracted: 0, skipped: pending.length, items: [] };
  }

  const result: ExtractResult = { extracted: 0, skipped: 0, items: [] };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const decision = pending[i % pending.length]; // 按序对应（AI 未保证一一对应，退化为轮转）

    // 闸门二：标题去重
    const normTitle = item.title.replace(/\s+/g, "").toLowerCase();
    if (existingTitles.has(normTitle)) {
      result.skipped++;
      result.items.push({ ...item, reason: "title_dup" });
      continue;
    }

    // 闸门三：语义去重（仅当能拿到向量）
    const vec = await embedText(item.content);
    if (vec && vec.length === EMBEDDING_DIMENSIONS) {
      let semanticDup = false;
      for (const e of existingEntries) {
        const ev = Array.isArray(e.embedding) ? e.embedding : null;
        if (ev && ev.length === EMBEDDING_DIMENSIONS) {
          if (cosineSimilarity(vec, ev) >= SEMANTIC_DUP_THRESHOLD) {
            semanticDup = true;
            break;
          }
        }
      }
      if (semanticDup) {
        result.skipped++;
        result.items.push({ ...item, reason: "semantic_dup" });
        continue;
      }
    }

    if (opts.dryRun) {
      result.items.push({ ...item, reason: "would_extract" });
      result.extracted++;
      continue;
    }

    await createKnowledge(projectId, {
      title: item.title,
      content: item.content,
      category: item.category,
      sourceType: "decision",
      sourceRef: decision ? `decision:${decision.id}` : null,
      sourceDecisionId: decision?.id ?? null,
    });
    // 维护闸门集合，避免同批内的重复
    existingTitles.add(normTitle);
    result.extracted++;
    result.items.push({ ...item, reason: "extracted" });
  }

  return result;
}

/** 余弦相似度（1 = 完全相同），复用 lib/db/backend 的纯函数逻辑。 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 重新导出 source hash 供触发端点使用（保持对外接口单一入口）。 */
export { computeSourceHash };
