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
  const rows = await db.list<ConversationRow>("conversations", (r) =>
    r.requirement_id === requirementId
  );
  return rows.sort((a, b) => a.id - b.id);
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
