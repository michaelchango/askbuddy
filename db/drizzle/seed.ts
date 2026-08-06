/**
 * db:seed —— 往 PostgreSQL 写入最小冒烟数据（1 项目 + 1 需求 + 1 对话 + 4 步骤）。
 *
 * 【设计】可逆可重复
 *   - 幂等：每次写入前先 db.findMany 查重，已存在则跳过（可反复跑）。
 *   - 只经门面 db 写入，不直连 postgres —— 等于顺带冒烟 lib/db 整条链路。
 *   - 只服务 PG 后端：DB_BACKEND=postgres 才跑，否则提示。
 *   - 生产环境默认拒绝（NODE_ENV=production 需 DB_SEED_FORCE=1 才放行）。
 *
 * 【运行】DB_BACKEND=postgres npm run db:seed
 *        或在 .env.local 设好 DATABASE_URL + DB_BACKEND=postgres 后 npm run db:seed
 */
import { db } from "@/lib/db";
import { resolveDbBackend } from "@/lib/cloudbase";

const OWNER = "mock-user-001";

async function main(): Promise<void> {
  const backend = resolveDbBackend();
  if (backend !== "postgres") {
    console.error(`[db:seed] 当前后端=${backend}，种子数据只写入 PostgreSQL。`);
    console.error("  请用 `DB_BACKEND=postgres npm run db:seed` 运行。");
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production" && process.env.DB_SEED_FORCE !== "1") {
    console.error("[db:seed] 拒绝在生产环境写入种子数据（如需强制，设 DB_SEED_FORCE=1）。");
    process.exit(1);
  }
  if (process.env.DB_SEED_DISABLED === "1") {
    console.log("[db:seed] DB_SEED_DISABLED=1，跳过。");
    return;
  }

  const now = new Date().toISOString();

  // ---- 项目（幂等）----
  const existingProject = await db.findMany<{ id: string }>("projects", {
    where: { ownerId: { eq: OWNER }, name: { eq: "AskBuddy 演示项目" } },
    limit: 1,
  });
  let projectId: string;
  if (existingProject.length > 0) {
    projectId = existingProject[0].id;
    console.log("[db:seed] 演示项目已存在，复用。");
  } else {
    projectId = crypto.randomUUID();
    await db.insert("projects", {
      id: projectId,
      name: "AskBuddy 演示项目",
      description: "M1 迁移后的最小冒烟数据。",
      ownerId: OWNER,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    console.log("[db:seed] 已写入演示项目。");
  }

  // ---- 需求（幂等）----
  const existingReq = await db.findMany<{ id: string }>("requirements", {
    where: { projectId: { eq: projectId }, title: { eq: "示例需求：用户登录" } },
    limit: 1,
  });
  let reqId: string;
  if (existingReq.length > 0) {
    reqId = existingReq[0].id;
    console.log("[db:seed] 示例需求已存在，复用。");
  } else {
    reqId = crypto.randomUUID();
    await db.insert("requirements", {
      id: reqId,
      projectId,
      title: "示例需求：用户登录",
      titleSource: "manual",
      card: { role: "用户", goal: "登录系统", reason: "使用核心功能" },
      current_version: 0,
      createdAt: now,
      updatedAt: now,
    });
    console.log("[db:seed] 已写入示例需求。");
  }

  // ---- 对话（幂等：该需求下已有对话则跳过）----
  const existingConv = await db.findMany("conversations", {
    where: { requirement_id: { eq: reqId } },
    limit: 1,
  });
  if (existingConv.length === 0) {
    await db.insert("conversations", {
      id: Date.now(),
      requirement_id: reqId,
      role: "user",
      content: "帮我设计一个用户登录功能。",
      meta: null,
      created_at: now,
    });
    console.log("[db:seed] 已写入示例对话。");
  }

  // ---- 四步工作流初始步骤（幂等）----
  const steps = ["dialoguing", "research_analysis", "design", "prd_writing"];
  let added = 0;
  for (const step of steps) {
    const existing = await db.findMany("requirement_steps", {
      where: { requirement_id: { eq: reqId }, step: { eq: step } },
      limit: 1,
    });
    if (existing.length > 0) continue;
    await db.insert("requirement_steps", {
      id: crypto.randomUUID(),
      requirement_id: reqId,
      step,
      state: step === "dialoguing" ? "in_progress" : "not_started",
      awaiting_confirm: 0,
      created_at: now,
      updated_at: now,
    });
    added++;
  }
  if (added > 0) console.log(`[db:seed] 已写入 ${added} 个步骤状态。`);

  console.log(`[db:seed] ✓ 种子数据就绪（project=${projectId}, requirement=${reqId}）。`);
}

main().catch((e) => {
  console.error("[db:seed] ✗ 失败：", e);
  process.exit(1);
});
