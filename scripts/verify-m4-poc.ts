/**
 * M4 阶段2-4 端到端冒烟验证（走 cloudbase 网关后端，复用项目 db 门面 + embedText）。
 *
 * 覆盖：
 *   阶段2：knowledge_entries 向量列写入 + 读回（vector(1024)）
 *   阶段3：真实混元 embedding 进入库（维度硬校验已修签名 bug 后应通过）
 *   阶段4：insert 新建 -> get 读回 -> searchVector 语义检索命中
 *
 * 运行：npx tsx scripts/verify-m4-poc.ts
 * 退出码：0 全通过；1 有失败
 */
import "./_env";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { embedForVerify } from "./_verify-lib";

const PROJECT_ID = (process.env.VERIFY_PROJECT_ID || "verify-proj-m4").trim();
const TEST_ID = `know_${randomUUID().slice(0, 8)}`;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

async function main() {
  console.log(`[verify-m4] 后端 = ${process.env.DB_BACKEND ?? "(默认)"}  project = ${PROJECT_ID}`);

  // ---- 阶段3：embedding ----
  const emb3 = await embedForVerify("同一项目下的业务规则应跨需求复用，避免重复定义。");
  const vec = emb3.vec;
  console.log(`[verify-m4] embedding 来源 = ${emb3.source}`);
  check("阶段3 embedding 返回非 null", !!vec, vec ? `dim=${vec.length}` : "返回 null");
  check("阶段3 维度 === 1024", !!vec && vec.length === 1024);
  check("阶段3 使用的是真实混元向量（非合成兜底）", emb3.source === "real");

  // ---- 阶段2+4：insert 一条知识（带真实向量）----
  const row = {
    id: TEST_ID,
    project_id: PROJECT_ID,
    title: "M4 验证规则",
    content: "同一项目下的业务规则应跨需求复用，避免重复定义。",
    embedding: vec ?? undefined,
    category: "rule",
    source_type: "manual",
    status: "active",
  };
  const inserted = await db.insert("knowledge_entries", row);
  check("阶段4 insert 成功返回 id", (inserted as any)?.id === TEST_ID);

  // ---- 阶段2：读回向量列，验证 vector(1024) 还原 ----
  const got = await db.get<any>("knowledge_entries", TEST_ID);
  const embBack = got?.embedding;
  const isArr =
    Array.isArray(embBack) ||
    (typeof embBack === "string" && embBack.startsWith("["));
  check("阶段2 读回 embedding 非空", !!embBack);
  check(
    "阶段2 向量还原为 1024 维数组",
    !!embBack && (Array.isArray(embBack) ? embBack.length : JSON.parse(embBack).length) === 1024
  );

  // ---- 阶段4：语义检索命中 ----
  const queryVec = (await embedForVerify("跨需求复用的规则怎么避免重复？")).vec;
  const hits = await db.searchVector<any>("knowledge_entries", {
    column: "embedding",
    query: queryVec as number[],
    where: { project_id: { eq: PROJECT_ID }, status: { eq: "active" } },
    topK: 5,
  });
  const hitSelf = hits.find((h) => h.id === TEST_ID);
  check("阶段4 语义检索命中刚插入条目", !!hitSelf, `命中数=${hits.length}`);
  check(
    "阶段4 检索结果按 score 降序",
    hits.every((h, i) => i === 0 || (hits[i - 1].score as number) >= (h.score as number))
  );
  if (hitSelf) {
    console.log(`   命中 score=${(hitSelf.score as number).toFixed(4)}`);
  }

  // ---- 清理 ----
  await db.remove("knowledge_entries", TEST_ID);
  const after = await db.get("knowledge_entries", TEST_ID);
  check("阶段4 软删/删除后查不到", !after);

  console.log(`\n[verify-m4] 失败项 = ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[verify-m4] 异常：", e);
  process.exit(1);
});
