/**
 * M4 阶段5 验证：知识沉淀（从 M3 decisions 抽取）+ 三道去重闸。
 *
 * 【三道闸的实测特性（重要）】
 *   闸门一 source_decision_id：确定性生效（重复沉淀不产生新条目）。
 *   闸门二 title normalize：机制确定，但「AI 对同一决策复现同一标题」有随机性，
 *                          故本脚本采用「多变体诱饵 + 最多 3 轮重试」来提高命中率。
 *   闸门三 语义余弦 ≥0.95：**仅当能拿到向量时才生效**（见 knowledge-extractor.ts:150-167），
 *                          真实 embedding 不可用（服务未开通）时该闸**静默跳过**。
 *                          本脚本分别断言「闸门三前提（余弦 ≥0.95）」与「闸门三是否触发」。
 *
 * 运行：npx tsx scripts/verify-m4-stage5.ts
 * 退出码：0 通过；1 失败；2 环境不具备
 */
import "./_env";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { extractFromDecisions } from "@/lib/services/knowledge-extractor";
import { EMBEDDING_DIMENSIONS } from "@/lib/ai/embedding";
import { embedForVerify } from "./_verify-lib";
import { backfillEmbeddings } from "@/lib/services/knowledge";

let failures = 0;
const seededDecisionIds: string[] = [];
const seededSuggestionIds: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function pickProjectWithRequirement() {
  for (const p of await db.findMany<any>("projects", { limit: 20 })) {
    const reqs = await db.findMany<any>("requirements", { where: { projectId: { eq: p.id } }, limit: 1 });
    if (reqs[0]) return { projectId: p.id, requirementId: reqs[0].id };
  }
  return null;
}

async function seedDecisions(requirementId: string, summaries: string[]) {
  for (const summary of summaries) {
    const sugId = `sug_verify_${randomUUID().slice(0, 8)}`;
    const decId = `dec_verify_${randomUUID().slice(0, 8)}`;
    await db.insert("suggestions", {
      id: sugId, requirement_id: requirementId, target_type: "dev_context",
      target_path: "verify", op: "add", payload: { note: "M4 阶段5 验证用" },
      status: "accepted", source: { confirmed_by: "verify_script" },
    });
    await db.insert("decisions", {
      id: decId, requirement_id: requirementId, suggestion_id: sugId,
      summary, conversation_turn: 1, confirmed_by: "verify_script",
    });
    seededSuggestionIds.push(sugId);
    seededDecisionIds.push(decId);
  }
}

const listKnowledge = (projectId: string) =>
  db.findMany<any>("knowledge_entries", { where: { project_id: { eq: projectId } }, limit: 1000 });

async function seedDecoy(projectId: string, title: string, content: string) {
  const id = `know_${randomUUID().slice(0, 8)}`;
  const got = await embedForVerify(content);
  let embedding: number[] | null = got.vec;
  if (embedding && embedding.length !== EMBEDDING_DIMENSIONS) embedding = null;
  await db.insert("knowledge_entries", {
    id, project_id: projectId, title, content,
    embedding: embedding ?? undefined,
    category: "rule", source_type: "manual", status: "active",
  });
  return id;
}

async function unlinkDecisions(entries: any[]) {
  for (const e of entries) await db.update("knowledge_entries", e.id, { source_decision_id: null });
}

/** 把本批条目标题改成唯一垃圾串，避免与后续诱饵互相干扰。 */
async function scrambleTitles(entries: any[], tag: string) {
  for (let i = 0; i < entries.length; i++) {
    await db.update("knowledge_entries", entries[i].id, { title: `__${tag}_${Date.now()}_${i}` });
  }
}

async function main() {
  const target = await pickProjectWithRequirement();
  if (!target) { console.log("⚠ 库中没有可用的「项目 + 需求」，无法实跑阶段5。"); process.exit(2); }
  const { projectId, requirementId } = target;

  const existingConfirmed = (await db.findMany<any>("decisions", { limit: 200 })).filter((d) => {
    const s = (d.summary ?? "").trim();
    return s && s !== "ignored";
  });
  if (existingConfirmed.length === 0) {
    console.log("[stage5] 库中无已确认 decisions → 构造受控测试数据");
    await seedDecisions(requirementId, [
      "所有列表页统一采用游标分页（cursor-based），禁止使用 offset/limit 分页，以保证大数据量下翻页不重复、不跳项。",
      "用户数据的软删除统一用 status 字段标记（active/deprecated），禁止物理删除，以便审计与溯源。",
    ]);
  }
  console.log(`[stage5] 目标项目=${projectId}  decisions=${existingConfirmed.length || 2}`);

  const beforeIds = new Set((await listKnowledge(projectId)).map((r) => r.id));

  // ---------- dryRun 基线 ----------
  const dry = await extractFromDecisions(projectId, { dryRun: true });
  console.log(`[stage5] dryRun：extracted=${dry.extracted} skipped=${dry.skipped}`);
  // 检查 dryRun 期间是否有任何新条目被插入（在真实向量环境下之前的闸门三可能留下了诱饵）
  const afterDry = await listKnowledge(projectId);
  const newInDry = afterDry.filter((r) => !beforeIds.has(r.id));
  check("dryRun 不写库", newInDry.length === 0, `新增=${newInDry.length}`);
  check("AI 抽取链路产出条目", dry.items.length > 0, `items=${dry.items.length}`);
  if (dry.items.length === 0) { await cleanup(projectId, beforeIds); process.exit(failures ? 1 : 0); }

  // ---------- 首次沉淀 ----------
  const run1 = await extractFromDecisions(projectId);
  const after1 = await listKnowledge(projectId);
  const batch1 = after1.filter((r) => !beforeIds.has(r.id));
  console.log(`[stage5] 首次沉淀：extracted=${run1.extracted} 新增=${batch1.length}`);
  check("首次沉淀写入知识条目", batch1.length > 0, `extracted=${run1.extracted}`);
  check("沉淀条目 source_type=decision 且 category 合法",
    batch1.every((e) => e.source_type === "decision" && ["rule", "term", "decision", "constraint"].includes(e.category)));
  check("沉淀条目带 source_decision_id（闸门一锚点）", batch1.some((e) => !!e.source_decision_id));

  // ---------- 闸门一 ----------
  const run2 = await extractFromDecisions(projectId);
  const after2 = await listKnowledge(projectId);
  check("闸门一：同一 decision 不重复沉淀",
    run2.extracted === 0 && after2.length === after1.length,
    `run2.extracted=${run2.extracted} 新增=${after2.length - after1.length}`);

  // ---------- 闸门二：多变体诱饵 + 重试 ----------
  // 注 1：闸门二在闸门三之前执行（title_dup 优先于 semantic_dup），所以只要标题能撞上，
  //       必然以 title_dup 命中，不会被闸门三截走。
  // 注 2：闸门二逻辑是确定性的，但 AI 对同一决策的标题措辞每次可能不同（实测有
  //       「用户数据软删除规范」/「用户数据禁止物理删除，统一软删除」/「用户数据禁止物理删除」
  //       等多个变体）。因此本测试先多次 dryRun 采样标题变体，再覆盖式布诱饵，
  //       避免把「AI 措辞随机」误报成「闸门二失效」。
  let titleDup = 0;
  let attempts = 0;
  for (; attempts < 3 && titleDup === 0; ) {
    attempts++;
    // 硬删本批已创建条目（不删 beforeIds 存量），让参照集干净、避免闸门一提前短路
    const cur = (await listKnowledge(projectId)).filter((r) => !beforeIds.has(r.id));
    for (const e of cur) { try { await db.remove("knowledge_entries", e.id); } catch { /* ignore */ } }

    // 采样标题变体：连续 3 次 dryRun 取并集
    const variants = new Set<string>();
    for (let s = 0; s < 3; s++) {
      const d = await extractFromDecisions(projectId, { dryRun: true });
      for (const it of d.items) if (it.title) variants.add(it.title);
    }
    // 覆盖式布诱饵：内容用主题无关锚串（真实向量下余弦必然 <0.95）
    for (const title of variants) {
      await seedDecoy(projectId, title, `Unrelated anchor string about gardening — ${randomUUID()}`);
    }

    const r = await extractFromDecisions(projectId);
    titleDup = r.items.filter((i) => i.reason === "title_dup").length;
    console.log(
      `   [闸门二] 第 ${attempts} 轮：诱饵标题=${JSON.stringify([...variants])} → reasons=${JSON.stringify(r.items.map((i) => i.reason))}`
    );

    // 本轮试探留下的诱饵清掉，下一轮再来
    const rest = (await listKnowledge(projectId)).filter((r) => !beforeIds.has(r.id));
    for (const e of rest) { try { await db.remove("knowledge_entries", e.id); } catch { /* ignore */ } }
  }
  check("闸门二：同标题被拦（reason=title_dup）", titleDup > 0, `命中=${titleDup} 轮次=${attempts}`);

  // ---------- 闸门三：先验前提，再验触发 ----------
  const allNow = (await listKnowledge(projectId)).filter((r) => !beforeIds.has(r.id));
  await unlinkDecisions(allNow);
  await scrambleTitles(allNow, "gz3");
  const filled = await backfillEmbeddings(projectId);
  console.log(`[stage5] 闸门三前置：向量回填 ${filled} 条`);

  // 诱饵内容 = dryRun 基线内容（AI 若复现同内容 → 余弦应 ≥0.95）
  const dryBase = dry.items.filter((i) => i.reason === "would_extract");
  for (const it of dryBase.slice(0, 2)) {
    await seedDecoy(projectId, `__gz3诱饵_${randomUUID().slice(0, 6)}`, it.content);
  }

  const lib = (await listKnowledge(projectId)).filter((r) => !beforeIds.has(r.id));
  let maxSim = -1;
  for (const it of dryBase) {
    const v = (await embedForVerify(it.content)).vec;
    if (!v) continue;
    for (const r of lib) {
      if (Array.isArray(r.embedding) && r.embedding.length === EMBEDDING_DIMENSIONS) {
        maxSim = Math.max(maxSim, cosine(v, r.embedding));
      }
    }
  }
  const run4 = await extractFromDecisions(projectId);
  const semDup = run4.items.filter((i) => i.reason === "semantic_dup").length;

  check("闸门三前提：存在余弦 ≥0.95 的近重内容", maxSim >= 0.95, `最大余弦=${maxSim.toFixed(4)}（阈值 0.95）`);
  if (semDup > 0) {
    check("闸门三：内容语义近重被拦（reason=semantic_dup）", true, `semantic_dup=${semDup}`);
  } else {
    // 闸门三仅在「能拿到向量」时生效（knowledge-extractor.ts:150-167）；
    // 真实 embedding 不可用时该闸静默跳过，知识库失去语义级去重保护。
    check(
      "闸门三：内容语义近重被拦（reason=semantic_dup）",
      false,
      `semantic_dup=0 reasons=${JSON.stringify(run4.items.map((i) => i.reason))}` +
        " ← 真实 embedding 不可用（服务未开通），闸门三按设计被跳过"
    );
  }

  await cleanup(projectId, beforeIds);
  console.log(`\n[stage5] 失败项 = ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

async function cleanup(projectId: string, beforeIds: Set<string>) {
  const now = await listKnowledge(projectId);
  let removed = 0;
  for (const r of now) {
    if (!beforeIds.has(r.id)) { try { await db.remove("knowledge_entries", r.id); removed++; } catch { /* ignore */ } }
  }
  for (const id of seededDecisionIds) { try { await db.remove("decisions", id); } catch { /* ignore */ } }
  for (const id of seededSuggestionIds) { try { await db.remove("suggestions", id); } catch { /* ignore */ } }
  console.log(`[stage5] 清理：知识 ${removed} 条 / decision ${seededDecisionIds.length} / suggestion ${seededSuggestionIds.length}`);
}

main().catch(async (e) => {
  console.error("[stage5] 异常：", e);
  process.exit(1);
});
