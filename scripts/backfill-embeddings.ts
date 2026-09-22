/**
 * M4 回填脚本：为 knowledge_entries 中 status=active 且 embedding 为 NULL 的条目
 * 批量计算 embedding（fire-and-forget 的兜底）。创建知识时 embedding 是异步写的，
 * 若进程在写入前退出/失败，用本脚本一次性补全。
 *
 * 用法：
 *   npx tsx scripts/backfill-embeddings.ts             # 全部项目
 *   npx tsx scripts/backfill-embeddings.ts <projectId> # 单个项目
 *
 * 前置：.env.local 设置 DB_BACKEND=cloudbase（或 postgres）+ TOKENHUB_API_KEY。
 */
// 【必须第一个 import】先装载 .env.local，再求值 embedding 模块。
// 若写成「先 import knowledge 再 loadEnvConfig」，ESM 的 import 提升会让
// lib/ai/embedding 的模块级密钥常量恒为 undefined → 静默走确定性 mock →
// 回填脚本会把 1024 维伪向量写进 knowledge_entries（数据污染）。
import "./_env";
import { db } from "@/lib/db";
import { backfillEmbeddings } from "@/lib/services/knowledge";

async function main(): Promise<void> {
  const projectId = process.argv[2];

  if (projectId) {
    const done = await backfillEmbeddings(projectId);
    console.log(`[backfill] 项目 ${projectId} 回填完成：${done} 条`);
    return;
  }

  // 全部项目：先列项目 id，再逐个回填。
  const projects = await db.findMany<{ id: string }>("projects", {});
  let total = 0;
  for (const p of projects) {
    const done = await backfillEmbeddings(p.id);
    if (done > 0) console.log(`[backfill] 项目 ${p.id}：${done} 条`);
    total += done;
  }
  console.log(`[backfill] 全部完成：${total} 条`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
