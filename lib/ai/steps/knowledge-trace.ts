// DevContext 知识溯源过滤（M4 知识复利）——纯函数，零运行时依赖。
//
// 【为什么单独成文件】
//   这段逻辑原本私藏在 lib/ai/steps/devcontext.ts 里，而那个模块 import 了
//   db / callAI / CloudBase SDK 等重依赖，导致「幻觉 id 白名单过滤」这条最需要
//   被回归保护的不变量无法写单测。抽成纯函数后，测试只需 import 本文件。
//
// 【不变量】
//   1. 输出中任意层级的 _source.knowledge_ids ⊆ 本次实际注入的知识 id 集合；
//   2. 无注入知识时，所有 knowledge_ids 一律清空（模型不可能凭空引用）；
//   3. 除 knowledge_ids 外，其余字段（含 context_ids / decision_id / 业务字段）原样保留；
//   4. 不修改入参（返回全新对象图）。
import type { DevContextBody } from "@/lib/schemas/devcontext";

/**
 * 幻觉 id 白名单过滤：遍历 DevContext body 的所有 _source.knowledge_ids，
 * 只保留注入知识集合内的 id。模型编造的 id 直接丢弃。
 */
export function filterKnowledgeIds(
  body: DevContextBody,
  knowledge: Array<{ id: string }>
): DevContextBody {
  const allowed = new Set(knowledge.map((k) => k.id));
  if (allowed.size === 0) {
    // 无注入知识：清空所有 knowledge_ids（模型不可能凭空引用）。
    return sanitizeKnowledgeIds(body, () => []);
  }
  return sanitizeKnowledgeIds(body, (ids) => ids.filter((id) => allowed.has(id)));
}

/**
 * 递归遍历对象/数组，对任意层级出现的 knowledge_ids 数组应用 filter，
 * 其余字段原样复制。返回全新对象图（不改入参）。
 */
export function sanitizeKnowledgeIds(
  node: unknown,
  filter: (ids: string[]) => string[]
): DevContextBody {
  function walk(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === "knowledge_ids" && Array.isArray(val)) {
          out[k] = filter(val as string[]);
        } else {
          out[k] = walk(val);
        }
      }
      return out;
    }
    return v;
  }
  return walk(node) as DevContextBody;
}
