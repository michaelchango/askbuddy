// 对话记录服务：仅追加，按时间顺序返回。
import { db } from "@/lib/db";
import type { OutputType } from "@/lib/services/outputs";

export interface ChatReference {
  type: OutputType;
  label: string;
  version: number;
}

export interface ConversationRow {
  id: number;
  requirement_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  meta: { references?: ChatReference[] } | null;
  created_at: string;
}

export async function listConversations(
  requirementId: string
): Promise<ConversationRow[]> {
  // 下推：原实现拉回全表（上限 1000 行）再内存过滤 + 排序。对话表是全库增长最快的，
  // 单需求几十轮对话就会让「取一个需求的对话」变成扫全库。
  // PG 侧走 idx_conv_req (requirement_id, id)，过滤与排序都由索引直接满足。
  return db.findMany<ConversationRow>("conversations", {
    where: { requirement_id: { eq: requirementId } },
    orderBy: [["id", "asc"]],
  });
}

export async function addMessage(
  requirementId: string,
  role: ConversationRow["role"],
  content: string,
  meta?: ConversationRow["meta"]
): Promise<ConversationRow> {
  const row: ConversationRow = {
    id: Date.now(),
    requirement_id: requirementId,
    role,
    content,
    meta: meta ?? null,
    created_at: new Date().toISOString(),
  };
  await db.insert("conversations", row);
  return row;
}

// M3 · 对话轮次序号。
// _source.conversation_turn 与「定位来源」跳转依赖此序号（来自 M0 conversations 表，
// listConversations 按 id 升序即对话轮次序）。
// - 不传 messageId：返回「当前对话轮次」（即现有消息总数），作为本次生成建议的溯源锚点。
// - 传 messageId：返回该消息在列表中的 1-based 序号（用于精确回溯某条消息）。
export async function getConversationTurn(
  requirementId: string,
  messageId?: number
): Promise<number | null> {
  if (messageId != null) {
    const all = await listConversations(requirementId);
    const idx = all.findIndex((c) => c.id === messageId);
    return idx >= 0 ? idx + 1 : null;
  }
  const all = await listConversations(requirementId);
  return all.length;
}
