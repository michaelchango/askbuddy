import { db } from "@/lib/db";
import { getRequirement } from "@/lib/services/requirements";
import { listConversations } from "@/lib/services/conversations";
import { getPrototypeHtml } from "@/lib/services/prototypes";
import type { ChatMessage } from "@/lib/ai/types";

export interface PrototypeContext {
  card?: Record<string, unknown>;
  history: ChatMessage[];
  upstream: Record<string, string>;
  existingHtml?: string;
}

function cardHasContent(card?: Record<string, unknown>): boolean {
  if (!card) return false;
  return Object.values(card).some(
    (v) => typeof v === "string" && v.trim().length > 0 && !String(v).startsWith("（")
  );
}

// 组装原型生成/修改所需的上下文：需求卡片 + 上游参考（调研分析 / 方案文档）+ 历史对话 + 当前 HTML（修改模式）。
export async function buildPrototypeContext(
  requirementId: string,
  _taskType: string,
  input: { baseVersionId?: number; message?: string; changeNote?: string }
): Promise<PrototypeContext> {
  const [req, convs] = await Promise.all([
    getRequirement(requirementId),
    listConversations(requirementId),
  ]);

  const card = (req?.card ?? {}) as Record<string, unknown> | undefined;
  const history: ChatMessage[] = (convs ?? [])
    .filter((c) => c.role !== "system")
    .map((c) => ({
      role: (c.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: c.content,
    }));

  const upstream: Record<string, string> = {};
  if (cardHasContent(card)) {
    upstream["需求卡片"] = JSON.stringify(card, null, 2);
  }

  const ra = await db.get<{
    report?: string;
    user_stories?: Array<Record<string, unknown>>;
    features?: Array<Record<string, unknown>>;
  }>("research_analysis", requirementId);
  if (ra) {
    const parts: string[] = [];
    if (ra.report) parts.push(ra.report);
    if (Array.isArray(ra.user_stories) && ra.user_stories.length) {
      parts.push(
        "用户故事：\n" +
          ra.user_stories
            .map(
              (s) =>
                `- 作为${s.role ?? "用户"}，我希望${s.goal ?? ""}${
                  s.reason ? `，以便${s.reason}` : ""
                }`
            )
            .join("\n")
      );
    }
    if (Array.isArray(ra.features) && ra.features.length) {
      parts.push(
        "功能清单：\n" +
          ra.features.map((f) => `- ${f.name ?? "功能"}：${f.desc ?? ""}`).join("\n")
      );
    }
    if (parts.length) upstream["调研分析结论"] = parts.join("\n\n");
  }

  const sol = await db.get<{ doc?: string }>("solutions", requirementId);
  if (sol?.doc) upstream["产品方案文档"] = sol.doc;

  let existingHtml: string | undefined;
  if (input.baseVersionId || input.changeNote) {
    existingHtml = await getPrototypeHtml(requirementId, input.baseVersionId);
  }

  return { card, history, upstream, existingHtml };
}
