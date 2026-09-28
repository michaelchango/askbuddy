/**
 * M5-D2 端到端冒烟：定向重算（P2-4 regenerateSections + P2-5 refresh API）。
 *
 * 这是 D2 的**核心验收 A1** 的实测：只重算指定的 section，其余段**逐字节不变**。
 * 单测无法覆盖它——「逐字节不变」只有在真库 + 真模型链路上才有意义。
 *
 * ⚠️ 本冒烟会**真实调用一次 DevContext Agent**（约 60~120s）并给目标需求新增一个
 * DevContext 版本。旧版本仍完整保留在 dev_context_versions 里（可回滚）。
 *
 * 用法：npm run dev 后 `npx tsx scripts/smoke-devcontext-refresh.ts`
 *      可用 VERIFY_REQUIREMENT_ID 指定需求（缺省自动挑一条已生成 DevContext 的）。
 */
import "./_env";
import { db } from "@/lib/db";
import { getDevContext, markDevContextStale } from "@/lib/services/devcontext";
import { resolveAffectedSections } from "@/lib/services/devcontext-impact";
import { SECTION_KEYS } from "@/lib/schemas/devcontext";

const BASE = process.env.VERIFY_BASE_URL || "http://localhost:3000";
/** 只重算这一段的闭包（故意选级联最广的那条：约束 → 验收 → 测试用例）。 */
const TARGET = ["card.constraints"] as const;

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

async function main(): Promise<void> {
  // ---------- 选一条已有 DevContext 的需求 ----------
  let rid = process.env.VERIFY_REQUIREMENT_ID ?? "";
  if (!rid) {
    const rows = await db.findMany<{ requirement_id: string }>("dev_contexts", { limit: 5 });
    if (rows.length === 0) {
      console.log("[smoke-dc-refresh] 库里没有 DevContext，跳过（需先生成一份）");
      process.exit(0);
    }
    rid = rows[0].requirement_id;
  }

  const before = await getDevContext(rid);
  if (!before) throw new Error(`需求 ${rid} 没有 DevContext`);
  const beforeContent = before.content as unknown as Record<string, unknown>;
  const beforeVersion = before.current_version;
  console.log(`[smoke-dc-refresh] requirement=${rid} 起始版本=v${beforeVersion}`);
  console.log(`[smoke-dc-refresh] BASE=${BASE}`);

  // ---------- 模拟变更级联：打 stale 标记 ----------
  const impact = resolveAffectedSections([...TARGET]);
  const targets = impact.sections.filter((s) => s !== "meta" && s !== "references");
  await markDevContextStale(rid, impact);
  const marked = await getDevContext(rid);
  check(
    "变更级联已标记过期段（模拟用户改了卡片约束）",
    (marked?.stale_sections ?? []).includes("business_rules"),
    JSON.stringify(marked?.stale_sections)
  );

  // ---------- 调 refresh API（SSE） ----------
  console.log(`  ⏳ 正在重算 ${targets.join("、")}（真实 AI 调用，约 60~120s）…`);
  const res = await fetch(`${BASE}/api/requirements/${rid}/dev-context/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "targeted",
      sections: targets,
      changeNote: "变更点：新增「用户数据保留期 90 天」约束（冒烟用）",
    }),
  });
  check("POST refresh 返回 SSE（200）", res.status === 200, `status=${res.status}`);

  const reader = res.body?.getReader();
  if (!reader) throw new Error("无响应体");
  const decoder = new TextDecoder();
  let buf = "";
  let changeUpdate: Record<string, unknown> | null = null;
  let errorMsg = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split("\n\n");
    buf = blocks.pop() ?? "";
    for (const block of blocks) {
      const ev = block.split("\n").find((l) => l.startsWith("event:"))?.slice(6).trim();
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
      if (!ev || !dataLine) continue;
      if (ev === "gen_message") {
        const p = JSON.parse(dataLine) as { content?: string };
        if (p.content) console.log(`     · ${p.content}`);
      } else if (ev === "change_update") {
        changeUpdate = JSON.parse(dataLine) as Record<string, unknown>;
      } else if (ev === "error") {
        errorMsg = (JSON.parse(dataLine) as { message?: string }).message ?? "unknown";
      }
    }
  }
  check("重算未报错（SSE 无 error 事件）", !errorMsg, errorMsg || "ok");
  check("收到 change_update 事件（复用既有事件契约）", !!changeUpdate, JSON.stringify(changeUpdate)?.slice(0, 160));
  if (errorMsg) {
    console.log(`\n[smoke-dc-refresh] 通过 ${pass} / 失败 ${fail}`);
    process.exit(1);
  }

  const dc = (changeUpdate?.devContext ?? {}) as {
    version?: number;
    changed?: string[];
    unchanged?: string[];
    escalated?: boolean;
  };
  check("change_update 带 version", typeof dc.version === "number" && dc.version === beforeVersion + 1, `v${dc.version}`);
  check(
    "change_update.changed 覆盖了目标段 + 两个元段",
    ["meta", "references", ...targets].every((s) => (dc.changed ?? []).includes(s)),
    JSON.stringify(dc.changed)
  );

  // ---------- A1：逐段比对 ----------
  const after = await getDevContext(rid);
  if (!after) throw new Error("重算后读不到 DevContext");
  const afterContent = after.content as unknown as Record<string, unknown>;

  check("版本号 +1 且已落库", after.current_version === beforeVersion + 1, `v${after.current_version}`);

  const recomputed = new Set<string>([...targets, "meta", "references"]);
  const preserved: string[] = [];
  const corrupted: string[] = [];
  for (const key of ["$schema", "schema_version", ...SECTION_KEYS]) {
    if (recomputed.has(key)) continue;
    const same =
      JSON.stringify(beforeContent[key] ?? null) === JSON.stringify(afterContent[key] ?? null);
    (same ? preserved : corrupted).push(key);
  }

  // changelog 只统计 section（不含 $schema / schema_version 两个协议字段），比较时必须同口径
  const preservedSectionOnly = preserved.filter((k) =>
    (SECTION_KEYS as readonly string[]).includes(k)
  );

  // ★ 核心验收：未列出的段逐字节保留（含其 _source）
  check(
    "★ A1：未受影响段落逐字节不变（含 _source）",
    corrupted.length === 0,
    corrupted.length
      ? `被改动：${corrupted.join("、")}`
      : `保留 ${preserved.length} 个键（其中 ${preservedSectionOnly.length} 个 section）`
  );

  // meta 必须由纯代码重算（版本号/时间戳/完整度），不是模型自由发挥
  const metaAfter = afterContent.meta as Record<string, unknown> | undefined;
  const metaBefore = beforeContent.meta as Record<string, unknown> | undefined;
  check(
    "meta 由纯代码重算（version +1、generated_at 更新）",
    metaAfter?.version === beforeVersion + 1 && metaAfter?.generated_at !== metaBefore?.generated_at,
    `version=${metaAfter?.version}`
  );
  check(
    "references 由纯代码重算（与上游版本对齐，不交给 LLM）",
    typeof (afterContent.references as Record<string, unknown>)?.prd_version !== "undefined"
  );

  // ---------- 标记收尾 ----------
  check(
    "已重算的段从过期清单移除",
    !(after.stale_sections ?? []).includes("business_rules"),
    JSON.stringify(after.stale_sections)
  );

  // ---------- 版本快照的结构化 changelog ----------
  const snap = await db.get<{ changelog?: unknown; version?: number }>(
    "dev_context_versions",
    `${rid}-v${after.current_version}`,
    "id"
  );
  const cl = (snap?.changelog ?? {}) as Record<string, unknown>;
  check(
    "版本快照写入了结构化 changelog（验收标准需要一个可断言的对象）",
    Array.isArray(cl.changed_sections) &&
      (cl.changed_sections as string[]).includes("business_rules") &&
      Array.isArray(cl.unchanged_sections) &&
      typeof cl.escalated === "boolean",
    JSON.stringify({ changed: (cl.changed_sections as string[])?.length, unchanged: (cl.unchanged_sections as string[])?.length })
  );
  check(
    "changelog.unchanged_sections 与实测保留段一致（同口径：只算 section）",
    JSON.stringify(cl.unchanged_sections) === JSON.stringify(preservedSectionOnly),
    `changelog=${(cl.unchanged_sections as string[])?.length} 实测=${preservedSectionOnly.length}`
  );

  console.log(`\n[smoke-dc-refresh] 通过 ${pass} / 失败 ${fail}`);
  console.log(`[smoke-dc-refresh] 目标需求 ${rid} 的 DevContext 已升到 v${after.current_version}（旧版本可在 dev_context_versions 回滚）`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[smoke-dc-refresh] 异常：", e);
  process.exit(1);
});
