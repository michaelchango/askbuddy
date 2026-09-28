/**
 * M4 阶段6 验证：RAG 注入与溯源。
 *
 * 覆盖：
 *   A. 召回：buildStepContext 携带 knowledge（真实向量检索命中）
 *   B. 注入：6 个 prompt 模块都渲染出【项目知识】段；DevContext 段带 [id=xxx]
 *   C. 预算：buildKnowledgeBlock 总长 ≤ 12000，单条 ≤ 2000
 *   D. 溯源：checkConsistency 放行真实 knowledge_id、对不存在 id 报 warn、deprecated 放行
 *
 * 运行：npx tsx scripts/verify-m4-stage6.ts
 */
import "./_env";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { buildStepContext } from "@/lib/ai/context/builder";
import { buildKnowledgeBlock, KNOWLEDGE_BUDGET, SINGLE_KNOWLEDGE_LIMIT } from "@/lib/ai/context/budget";
import { getPrompt } from "@/lib/ai/prompts";
import { checkConsistency } from "@/lib/services/devcontext-validate";
import { searchKnowledgeEntries, deleteKnowledge } from "@/lib/services/knowledge";
import { filterKnowledgeIds } from "@/lib/ai/steps/knowledge-trace";
import { EMBEDDING_DIMENSIONS } from "@/lib/ai/embedding";
import { embedForVerify } from "./_verify-lib";

let failures = 0;
const createdIds: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

async function insertKnowledge(projectId: string, title: string, content: string, category = "rule") {
  const id = `know_${randomUUID().slice(0, 8)}`;
  const got = await embedForVerify(content);
  let embedding = got.vec;
  if (embedding && embedding.length !== EMBEDDING_DIMENSIONS) embedding = null;
  await db.insert("knowledge_entries", {
    id, project_id: projectId, title, content,
    embedding: embedding ?? undefined,
    category, source_type: "manual", status: "active",
  });
  createdIds.push(id);
  return id;
}

async function main() {
  // 目标：项目 + 需求
  let projectId = "", requirementId = "";
  for (const p of await db.findMany<any>("projects", { limit: 20 })) {
    const reqs = await db.findMany<any>("requirements", { where: { projectId: { eq: p.id } }, limit: 1 });
    if (reqs[0]) { projectId = p.id; requirementId = reqs[0].id; break; }
  }
  if (!projectId) { console.log("⚠ 无可用项目/需求"); process.exit(2); }
  console.log(`[stage6] 项目=${projectId} 需求=${requirementId}`);

  const KEY_CONTENT = "列表页必须使用游标分页（cursor-based），禁止 offset 分页；游标由后端返回，前端不得自行计算页码。";
  const idA = await insertKnowledge(projectId, "列表页游标分页规范", KEY_CONTENT, "rule");
  const idB = await insertKnowledge(projectId, "软删除统一约束", "所有用户数据禁止物理删除，统一用 status 标记。", "constraint");
  console.log(`[stage6] 注入测试知识：${idA} / ${idB}`);

  // ---------- A. 召回 ----------
  const direct = await searchKnowledgeEntries({ projectId, query: KEY_CONTENT, topK: 6 });
  const hit = direct.results.find((r) => r.id === idA);
  check("A1 检索命中测试知识（任一通道）", !!hit, hit ? `score=${(hit.score as number).toFixed(4)} degraded=${direct.degraded}` : "未命中");
  check("A2 语义通道可用（未降级为关键词兜底）", direct.degraded === false,
    direct.degraded ? "← embedding 不可用，已降级（召回质量依赖字符串匹配）" : "");

  // 注：message 取知识原文，使「关键词兜底」也能命中，从而在 embedding 不可用时
  //     仍能验证「召回 → 组装 prompt → 渲染知识段」这条链路本身是通的。
  const ctx = await buildStepContext(requirementId, "devcontext", { message: KEY_CONTENT });
  const ctxIds = (ctx.knowledge ?? []).map((k) => k.id);
  check("A3 buildStepContext 召回到知识", ctxIds.length > 0, `条数=${ctxIds.length} ids=${ctxIds.join(",")}`);
  check("A4 召回包含本项目测试知识", ctxIds.includes(idA) || ctxIds.includes(idB));
  check("A5 召回结果带 score", (ctx.knowledge ?? []).every((k) => typeof k.score === "number"));

  // ---------- B. 注入渲染 ----------
  const promptTasks = ["dialoguing", "research_analysis", "solution_writing", "prd_writing", "prototype_gen", "devcontext"] as const;
  for (const t of promptTasks) {
    let user = "";
    try {
      const p = getPrompt(t as never);
      user = p.buildUser({
        message: "测试指令",
        card: ctx.card ?? {},
        history: [],
        upstream: {},
        knowledge: ctx.knowledge,
        requirementId,
        taskType: t,
      } as never);
    } catch (e) {
      check(`B ${t} 渲染知识段`, false, `抛错：${(e as Error).message}`);
      continue;
    }
    const has = user.includes("【项目知识");
    check(`B ${t} 渲染知识段`, has, has ? "" : "未找到【项目知识】");
  }

  // DevContext 专属：知识段含 [id=xxx] 供溯源
  const dvUser = getPrompt("devcontext" as never).buildUser({
    message: "测试", card: {}, history: [], upstream: {}, knowledge: ctx.knowledge, requirementId, taskType: "devcontext",
  } as never);
  check("B-devcontext 知识段含 [id=xxx] 标注", dvUser.includes("[id="));

  // ---------- C. 预算裁剪 ----------
  const big = Array.from({ length: 20 }, (_, i) => ({
    title: `预算测试条目 ${i}`,
    content: "内".repeat(3000),
    category: "业务规则",
  }));
  const { block } = buildKnowledgeBlock(big);
  check(
    "C1 知识段总长 ≤ 12000 字符预算",
    block.length <= KNOWLEDGE_BUDGET,
    `block=${block.length} budget=${KNOWLEDGE_BUDGET}`
  );
  const single = buildKnowledgeBlock([{ title: "单条", content: "内".repeat(5000), category: "业务规则" }], 20000);
  check(
    `C2 单条内容截断 ≤ ${SINGLE_KNOWLEDGE_LIMIT}`,
    single.block.length <= SINGLE_KNOWLEDGE_LIMIT + 100,
    `单条渲染长度=${single.block.length}`
  );

  // ---------- D. 溯源校验 ----------
  const baseBody: any = {
    objective: { problem_statement: "p", goal: "g" },
    business_rules: [
      { id: "BR-001", statement: "列表页用游标分页", formal: { when: "翻页", then: "使用游标" },
        _source: { context_ids: [], decision_id: null, knowledge_ids: [idA], conversation_turn: null, confirmed_by: "ai_auto", confirmed_at: null } },
    ],
    acceptance_criteria: [
      { id: "AC-001", given: "g", when: "w", then: "t", maps_to: ["BR-001"],
        _source: { context_ids: [], decision_id: null, knowledge_ids: [], conversation_turn: null, confirmed_by: "ai_auto", confirmed_at: null } },
    ],
  };
  const resolverBase = { contextExists: async () => true, maxConversationTurn: async () => 0 };
  // 对齐生产注入（lib/ai/steps/devcontext.ts:220）：真实查库判定 knowledge_id 是否存在。
  const prodResolvers = {
    ...resolverBase,
    knowledgeExists: async (id: string) => {
      const row = await db.get("knowledge_entries", id).catch(() => null);
      return Boolean(row);
    },
  };

  const issuesReal = await checkConsistency(baseBody, requirementId, prodResolvers);
  check(
    "D1 真实 knowledge_id 放行（无 source_validity 告警）",
    !issuesReal.some((i) => i.rule === "source_validity" && i.message.includes(idA)),
    `issues=${issuesReal.length}`
  );

  const fakeId = `know_halluc_${randomUUID().slice(0, 6)}`;
  const bodyFake = JSON.parse(JSON.stringify(baseBody));
  bodyFake.business_rules[0]._source.knowledge_ids = [fakeId];
  const issuesFake = await checkConsistency(bodyFake, requirementId, prodResolvers);
  check(
    "D2 不存在的 knowledge_id 报 warn",
    issuesFake.some((i) => i.rule === "source_validity" && i.message.includes(fakeId)),
    `issues=${JSON.stringify(issuesFake.filter((i) => i.rule === "source_validity").map((i) => i.message))}`
  );

  // deprecated 条目应放行
  const idDep = await insertKnowledge(projectId, "待软删约束", "即将废弃的约束内容。", "constraint");
  await deleteKnowledge(projectId, idDep);
  const bodyDep = JSON.parse(JSON.stringify(baseBody));
  bodyDep.business_rules[0]._source.knowledge_ids = [idDep];
  const issuesDep = await checkConsistency(bodyDep, requirementId, prodResolvers);
  check(
    "D3 deprecated（软删）条目仍可溯源放行",
    !issuesDep.some((i) => i.rule === "source_validity" && i.message.includes(idDep)),
    `issues=${issuesDep.length}`
  );

  // ---------- E. 幻觉 id 白名单过滤（用真实注入集合） ----------
  // 单测见 lib/ai/steps/knowledge-trace.test.ts；这里验证与真实召回结果的集成。
  const injected = ctx.knowledge ?? [];
  const bodyHalluc: any = JSON.parse(JSON.stringify(baseBody));
  bodyHalluc.business_rules[0]._source.knowledge_ids = [idA, fakeId];
  bodyHalluc.acceptance_criteria[0]._source.knowledge_ids = [fakeId];
  const filteredBody: any = filterKnowledgeIds(bodyHalluc, injected);
  check(
    "E1 过滤后只保留本次注入的知识 id",
    JSON.stringify(filteredBody.business_rules[0]._source.knowledge_ids) === JSON.stringify([idA]),
    `实际=${JSON.stringify(filteredBody.business_rules[0]._source.knowledge_ids)} 注入集=${JSON.stringify(injected.map((k) => k.id))}`
  );
  check(
    "E2 模型编造的 knowledge_id 被完全剔除",
    filteredBody.acceptance_criteria[0]._source.knowledge_ids.length === 0,
    `实际=${JSON.stringify(filteredBody.acceptance_criteria[0]._source.knowledge_ids)}`
  );
  check("E3 过滤不改动入参（原 body 仍含编造 id）",
    bodyHalluc.acceptance_criteria[0]._source.knowledge_ids.includes(fakeId));

  await cleanup();
  console.log(`\n[stage6] 失败项 = ${failures}`);
  process.exit(failures === 0 ? 0 : 1);}

async function cleanup() {
  let n = 0;
  for (const id of createdIds) {
    try { await db.remove("knowledge_entries", id); n++; } catch { /* ignore */ }
  }
  console.log(`[stage6] 清理测试知识 ${n}/${createdIds.length} 条`);
}

main().catch(async (e) => {
  console.error("[stage6] 异常：", e);
  await cleanup();
  process.exit(1);
});
