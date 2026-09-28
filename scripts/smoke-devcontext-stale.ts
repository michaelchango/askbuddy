/**
 * M5-D2 冒烟：DevContext section 级失效标记（P2-4 的 markDevContextStale / clearStale）。
 *
 * 为什么必须打真库：stale_sections / stale_reason 是 **JSONB** 列，写入走
 * lib/db/postgres.ts 的 JSONB_COLS 白名单分支（JSON.stringify 后按「未指定类型」下发）。
 * 白名单漏登记时，PG 会把 JS 数组当成 PG 数组解析 → 报错或存成字符串，而
 * mocked 单测（db 是 mock）永远发现不了——P1 的 updated_at 事件已经证明这条路必须实测。
 *
 * 全程可逆：跑完把 dev_contexts 的这三列恢复成运行前的快照。
 *
 * 用法：npx tsx scripts/smoke-devcontext-stale.ts
 */
import "./_env";
import { db } from "@/lib/db";
import { clearStale, markDevContextStale } from "@/lib/services/devcontext";
import { resolveAffectedSections } from "@/lib/services/devcontext-impact";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

interface StaleRow {
  requirement_id: string;
  maybe_stale?: number;
  stale_sections?: unknown;
  stale_reason?: unknown;
}

async function readRow(rid: string): Promise<StaleRow | undefined> {
  return db.get<StaleRow>("dev_contexts", rid, "requirement_id");
}

function sectionsOf(row: StaleRow | undefined): string[] {
  const v = row?.stale_sections;
  return Array.isArray(v) ? (v as string[]) : [];
}

function reasonOf(row: StaleRow | undefined): Record<string, unknown> {
  const v = row?.stale_reason;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

async function main(): Promise<void> {
  const rows = await db.findMany<StaleRow>("dev_contexts", { limit: 5 });
  if (rows.length === 0) {
    console.log("[smoke-dc-stale] 库里没有 DevContext，跳过（本冒烟需要 1 条现存 DC）");
    process.exit(0);
  }
  const rid = rows[0].requirement_id;
  console.log(`[smoke-dc-stale] requirement_id=${rid}`);

  const snapshot: StaleRow = {
    requirement_id: rid,
    maybe_stale: rows[0].maybe_stale ?? 0,
    stale_sections: rows[0].stale_sections ?? [],
    stale_reason: rows[0].stale_reason ?? {},
  };

  try {
    // ---------- A. 打标记：JSONB 写入路径 ----------
    const impact = resolveAffectedSections(["card.constraints"]);
    await markDevContextStale(rid, impact);
    const a = await readRow(rid);

    check(
      "stale_sections 读回是数组（JSONB 白名单生效，未被当成 PG 数组/字符串）",
      Array.isArray(a?.stale_sections),
      `type=${Array.isArray(a?.stale_sections) ? "array" : typeof a?.stale_sections}`
    );
    check("标记内容正确", sectionsOf(a).includes("business_rules") && sectionsOf(a).includes("test_cases"), JSON.stringify(sectionsOf(a)));
    check("maybe_stale = 1（SMALLINT 口径）", a?.maybe_stale === 1, `maybe_stale=${a?.maybe_stale}`);

    const reason = reasonOf(a);
    check(
      "stale_reason 读回是对象且记录了命中来源",
      Array.isArray(reason.business_rules) && (reason.business_rules as string[]).includes("card.constraints"),
      JSON.stringify(reason.business_rules)
    );

    // ---------- B. 二次标记 → 并集（不覆盖） ----------
    await markDevContextStale(rid, resolveAffectedSections(["knowledge.changed"]));
    const b = await readRow(rid);
    check(
      "重复标记是并集累积而非覆盖（先约束后知识，两批都还在）",
      sectionsOf(b).includes("business_rules") && sectionsOf(b).includes("glossary"),
      JSON.stringify(sectionsOf(b))
    );
    const reasonB = reasonOf(b);
    check(
      "stale_reason 多源合并（同一段保留全部 trigger）",
      Array.isArray(reasonB.business_rules) &&
        (reasonB.business_rules as string[]).length === 2,
      JSON.stringify(reasonB.business_rules)
    );

    // ---------- C. 部分清除 ----------
    await clearStale(rid, ["business_rules"]);
    const c = await readRow(rid);
    check("定向清标记：只清指定段", !sectionsOf(c).includes("business_rules"), JSON.stringify(sectionsOf(c)));
    check("其余段仍然过期", sectionsOf(c).includes("glossary"));
    check(
      "还有剩余过期段时 maybe_stale 必须仍为 1（否则 UI/MCP warning 会一起消失）",
      c?.maybe_stale === 1,
      `maybe_stale=${c?.maybe_stale}`
    );
    check("清掉的段同时从 reason 移除", reasonOf(c).business_rules === undefined);

    // ---------- D. 全清 ----------
    await clearStale(rid);
    const d = await readRow(rid);
    check("全清后 stale_sections 为空数组", Array.isArray(d?.stale_sections) && (d?.stale_sections as string[]).length === 0);
    check("全清后 maybe_stale = 0", d?.maybe_stale === 0, `maybe_stale=${d?.maybe_stale}`);

    // ---------- E. 无 DC 的需求：安静返回，不抛错 ----------
    await markDevContextStale("00000000-0000-0000-0000-000000000000", impact).then(
      () => check("没有 DevContext 的需求：静默返回不抛错", true),
      (e) => check("没有 DevContext 的需求：静默返回不抛错", false, String(e))
    );
  } finally {
    // ---------- 恢复现场 ----------
    await db.update("dev_contexts", rid, snapshot as unknown as Record<string, unknown>, "requirement_id");
    const back = await readRow(rid);
    check(
      "现场已恢复（三列回到运行前快照）",
      back?.maybe_stale === snapshot.maybe_stale &&
        JSON.stringify(back?.stale_sections ?? []) === JSON.stringify(snapshot.stale_sections ?? []),
      `maybe_stale=${back?.maybe_stale}`
    );
  }

  console.log(`\n[smoke-dc-stale] 通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[smoke-dc-stale] 异常：", e);
  process.exit(1);
});
