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
