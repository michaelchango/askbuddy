// M3 · 变更全部完成后的总结消息落库端点。
//
// 目的：把「变更完成总结」从 `app/api/requirements/[id]/conversation/route.ts`
// 里的 SSE 流内（紧跟在 change_update 事件后但早于 4 个并发的重生成）
// 转移到此处 + 由前端在 EVT.CHANGE_COMPLETE 触发时调用，确保 DB 写入时机 =
// 所有重生成都完成之后，从而让基于 id ASC 排序的对话回显保持正确顺序。
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { addMessage } from "@/lib/services/conversations";

// 依赖顺序：与 conversation/route.ts、requirement-shell.tsx 保持一致。
const OUTPUT_DEP_ORDER = ["card", "research_analysis", "design", "prototype", "prd"];
const OUTPUT_LABELS: Record<string, string> = {
  card: "需求卡片",
  research_analysis: "调研报告",
  design: "方案文档",
  prototype: "交互原型",
  prd: "需求文档",
};

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const affectedOutputs: unknown = body?.affectedOutputs;
  if (!Array.isArray(affectedOutputs) || affectedOutputs.length === 0) {
    // 没有受影响产物时无需再写一条「变更已处理完成」总结，直接 no-op 即可。
    return NextResponse.json({ ok: true, data: { content: null } });
  }
  const sorted = [...affectedOutputs]
    .filter((x): x is string => typeof x === "string")
    .sort((a, b) => OUTPUT_DEP_ORDER.indexOf(a) - OUTPUT_DEP_ORDER.indexOf(b));
  const list = sorted.map((o) => OUTPUT_LABELS[o] ?? o).join("、");
  const content = `✅ 变更已处理完成，涉及 ${list}。如需进一步调整请继续描述。`;
  // 仅追加，由 DB 自增 id 决定回显顺序——保证它在所有「X已更新」之后落库。
  await addMessage(params.id, "assistant", content).catch(() => {});
  return NextResponse.json({ ok: true, data: { content } });
}
