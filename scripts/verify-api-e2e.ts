/**
 * 阶段4 + 阶段7 HTTP 端到端验证（真实 dev server + 真实库）。
 *
 * 覆盖：
 *   阶段4 POST 新建 / GET 列表 / GET 详情 / PATCH 更新 / DELETE 软删 / POST search / POST backfill / POST extract
 *   阶段7 POST /api/mcp/knowledge/search（MCP 平台侧检索）
 *
 * 运行：VERIFY_BASE_URL=http://localhost:3001 npx tsx scripts/verify-api-e2e.ts
 */
import "./_env";
import { db } from "@/lib/db";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3001";
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

async function json(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { status: res.status, body };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 挑一个 owner 是 mock-user-001 的项目（getSession 恒返回该 uid）
  let projectId = "";
  for (const p of await db.findMany<any>("projects", { limit: 30 })) {
    if ((p.ownerId ?? p.owner_id) === "mock-user-001") { projectId = p.id; break; }
  }
  if (!projectId) { console.log("⚠ 没有 owner_id=mock-user-001 的项目，无法端到端验证"); process.exit(2); }
  console.log(`[e2e] BASE=${BASE} project=${projectId}`);

  const marker = `e2e_${Date.now()}`;
  const content = "端到端验证：列表页统一使用游标分页，禁止 offset 分页。";

  // ---------- 阶段4：新建 ----------
  const create = await json(`/api/projects/${projectId}/knowledge`, {
    method: "POST",
    body: JSON.stringify({ title: `E2E 知识 ${marker}`, content, category: "rule" }),
  });
  const entryId: string = create.body?.data?.id;
  check("POST 新建知识返回 id", create.status === 200 && !!entryId, `status=${create.status} id=${entryId}`);
  if (!entryId) { process.exit(1); }

  // embedding 异步生成 → 轮询等待
  let embLen: number | null = null;
  for (let i = 0; i < 12; i++) {
    const row = await db.get<any>("knowledge_entries", entryId);
    if (Array.isArray(row?.embedding) && row.embedding.length > 0) { embLen = row.embedding.length; break; }
    await sleep(1200);
  }
  check("新建后库中 embedding 已生成（fire-and-forget）", embLen === 1024, `dim=${embLen}`);
  if (embLen !== 1024) {
    console.warn(
      "  ↳ 说明：若混元 Embedding 服务未开通（FailedOperation.ServiceNotActivated），" +
        "此处必然失败——属外部依赖阻塞，不是接口逻辑缺陷。"
    );
  }

  // ---------- 阶段4：列表 / 详情 ----------
  const list = await json(`/api/projects/${projectId}/knowledge`);
  const listed = (list.body?.data ?? []).find((x: any) => x.id === entryId);
  check("GET 列表包含新条目", !!listed, `status=${list.status} 条数=${(list.body?.data ?? []).length}`);
  check("列表不外泄 embedding（=null）", listed?.embedding === null);

  const detail = await json(`/api/projects/${projectId}/knowledge/${entryId}`);
  check("GET 详情正常", detail.status === 200 && detail.body?.data?.id === entryId);

  // ---------- 阶段4：语义检索 ----------
  const search = await json(`/api/projects/${projectId}/knowledge/search`, {
    method: "POST",
    body: JSON.stringify({ query: content, topK: 8 }),
  });
  const hits = search.body?.data ?? [];
  const self = hits.find((h: any) => h.id === entryId);
  check("POST search 命中新条目", !!self, `status=${search.status} 命中=${hits.length} degraded=${search.body?.degraded}`);
  check("search 未降级（真实向量通道）", search.body?.degraded === false);
  if (search.body?.degraded !== false) {
    console.warn("  ↳ 说明：降级原因通常是 embedding 调用失败（服务未开通）→ 关键词兜底（score 恒为 0.3）。");
  }
  check("search 结果带 score", typeof self?.score === "number", `score=${self?.score}`);

  // ---------- 阶段4：PATCH ----------
  const patch = await json(`/api/projects/${projectId}/knowledge/${entryId}`, {
    method: "PATCH",
    body: JSON.stringify({ title: `E2E 知识(改) ${marker}` }),
  });
  check("PATCH 更新标题", patch.status === 200 && patch.body?.data?.title?.includes("(改)"),
    `status=${patch.status} title=${patch.body?.data?.title}`);

  // ---------- 阶段4：backfill ----------
  const backfill = await json(`/api/projects/${projectId}/knowledge/backfill`, { method: "POST" });
  check("POST backfill 正常返回", backfill.status === 200 && backfill.body?.ok === true,
    `status=${backfill.status} body=${JSON.stringify(backfill.body).slice(0, 120)}`);

  // ---------- 阶段4：extract（dryRun 预览，不写库） ----------
  const extract = await json(`/api/projects/${projectId}/knowledge/extract`, {
    method: "POST",
    body: JSON.stringify({ dryRun: true, limit: 3 }),
  });
  check("POST extract(dryRun) 正常返回", extract.status === 200 && extract.body?.ok === true,
    `status=${extract.status} extracted=${extract.body?.data?.extracted}`);

  // ---------- 阶段7：MCP 平台侧检索 ----------
  const mcp = await json(`/api/mcp/knowledge/search`, {
    method: "POST",
    body: JSON.stringify({ projectId, query: content, topK: 5 }),
  });
  const mcpHits = mcp.body?.data?.results ?? [];
  check("MCP POST /api/mcp/knowledge/search 返回结果", mcp.status === 200 && mcpHits.length > 0,
    `status=${mcp.status} 命中=${mcpHits.length} degraded=${mcp.body?.data?.degraded}`);
  check("MCP 结果不含 embedding", mcpHits.every((h: any) => h.embedding === undefined));
  const mcpGet = await json(`/api/mcp/knowledge/search?projectId=${projectId}&q=${encodeURIComponent(content.slice(0, 20))}`);
  check("MCP GET 兼容路径可用", mcpGet.status === 200 && (mcpGet.body?.data?.results ?? []).length > 0);

  // ---------- 阶段4：软删 ----------
  const del = await json(`/api/projects/${projectId}/knowledge/${entryId}`, { method: "DELETE" });
  check("DELETE 软删返回 ok", del.status === 200 && del.body?.ok === true);
  const rowAfter = await db.get<any>("knowledge_entries", entryId);
  check("软删后 status=deprecated", rowAfter?.status === "deprecated", `status=${rowAfter?.status}`);
  check("软删后 embedding 置 NULL", rowAfter?.embedding === null, `embedding=${rowAfter?.embedding === null ? "null" : typeof rowAfter?.embedding}`);
  const listAfter = await json(`/api/projects/${projectId}/knowledge`);
  check("软删后不出现在默认列表", !(listAfter.body?.data ?? []).some((x: any) => x.id === entryId));
  const listDep = await json(`/api/projects/${projectId}/knowledge?status=deprecated`);
  check("显式 status=deprecated 可查到", (listDep.body?.data ?? []).some((x: any) => x.id === entryId));

  // ---------- 清理 ----------
  await db.remove("knowledge_entries", entryId);
  console.log(`[e2e] 已清理测试条目 ${entryId}`);
  console.log(`\n[e2e] 失败项 = ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[e2e] 异常：", e); process.exit(1); });
