/**
 * M5 回填脚本：对存量需求按 deriveLifecycle 派生并落 lifecycle 列（source='derived'）。
 *
 * 幂等：lifecycle 已与派生结果一致的需求直接跳过，可安全重复执行。
 * 人工态（review/completed/archived）不在存量中自动写入——除 archived（由
 * archived_at 推导，归档是既成事实），其余人工决策必须由用户在 UI 触发。
 *
 * 用法：npx tsx scripts/backfill-lifecycle.ts
 */
import "./_env";
import { db } from "@/lib/db";
import { deriveLifecycle, type RequirementLifecycle } from "@/lib/requirement-lifecycle";
import { getSteps } from "@/lib/services/steps";
import { invalidateRequirementsCache } from "@/lib/services/requirements";

async function main(): Promise<void> {
  const requirements = await db.findMany<{
    id: string;
    lifecycle?: string;
    archived_at?: string | null;
  }>("requirements", { limit: 5000 });
  console.log(`[backfill-lifecycle] 存量需求 ${requirements.length} 条`);

  let written = 0;
  let skipped = 0;
  for (const req of requirements) {
    const steps = await getSteps(req.id);
    const hasConv =
      (await db.countMany("conversations", {
        requirement_id: { eq: req.id },
      })) > 0;
    const derived = deriveLifecycle({
      archivedAt: req.archived_at ?? null,
      hasConversation: hasConv,
      steps,
    });

    if (req.lifecycle === derived) {
      skipped++;
      continue;
    }

    await db.update("requirements", req.id, {
      lifecycle: derived,
      lifecycle_updated_at: new Date().toISOString(),
    });
    await db.insert("requirement_status_history", {
      id: crypto.randomUUID(),
      requirement_id: req.id,
      from_state: req.lifecycle ?? null,
      to_state: derived,
      actor: "system",
      reason: "M5 存量回填",
      source: "derived",
      created_at: new Date().toISOString(),
    });
    written++;
  }

  invalidateRequirementsCache();
  console.log(`[backfill-lifecycle] 完成：写入 ${written} 条 / 一致跳过 ${skipped} 条`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[backfill-lifecycle] 失败：", e);
  process.exit(1);
});
