/**
 * M5 Phase 1 冒烟：需求生命周期 API（P1-6）+ 步骤→生命周期同步钩子（P1-3）。
 *
 * 与单测的分工：单测 mock 掉 db，这里打真库 + 真 HTTP（dev server），
 * 验证「服务层写路径 → API 契约 → 审计表」三段是通的。
 *
 * 全程可逆：自己创建一条临时需求，跑完 DELETE 掉（审计行随 FK CASCADE 一并清理）。
 *
 * 用法：
 *   npm run dev                      # 另开终端
 *   npx tsx scripts/smoke-lifecycle-api.ts
 *   # 端口非 3000 时：$env:VERIFY_BASE_URL="http://localhost:3001"
 */
import "./_env";
import { db } from "@/lib/db";
import { setStepState } from "@/lib/services/steps";
import { STEP_KEYS } from "@/lib/steps-meta";
import type { StepName } from "@/types";

const BASE = process.env.VERIFY_BASE_URL || "http://localhost:3000";
const ACTOR = "mock-user-001";

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

interface ApiResult {
  status: number;
  body: {
    ok?: boolean;
    data?: Record<string, unknown>;
    error?: string;
    message?: string;
  } | null;
}

async function api(path: string, init?: RequestInit): Promise<ApiResult> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  let body: ApiResult["body"] = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON 响应（如 500 HTML）保持 null */
  }
  return { status: res.status, body };
}

const getLifecycle = (id: string) => api(`/api/requirements/${id}/lifecycle`);
const postLifecycle = (id: string, payload: Record<string, unknown>) =>
  api(`/api/requirements/${id}/lifecycle`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

async function auditRows(requirementId: string) {
  return db.findMany<{
    from_state: string | null;
    to_state: string;
    actor: string;
    reason: string | null;
    source: string;
  }>("requirement_status_history", {
    where: { requirement_id: { eq: requirementId } },
    orderBy: [["created_at", "asc"]],
  });
}

async function main(): Promise<void> {
  console.log(`[smoke-lifecycle] BASE=${BASE}`);

  // ---------- 前置：找一条归属 mock-user-001 的项目 ----------
  const projects = await db.findMany<{ id: string; ownerId?: string; owner_id?: string }>(
    "projects",
    { limit: 50 }
  );
  const project = projects.find((p) => (p.ownerId ?? p.owner_id) === ACTOR);
  if (!project) throw new Error("找不到归属 mock-user-001 的项目，无法冒烟");
  console.log(`[smoke-lifecycle] projectId=${project.id}`);

  // ---------- 建临时需求 ----------
  const created = await api("/api/requirements", {
    method: "POST",
    body: JSON.stringify({ projectId: project.id, title: "[smoke] 生命周期自检" }),
  });
  check("POST /api/requirements 建临时需求（201）", created.status === 201, `status=${created.status}`);
  const reqId = created.body?.data?.id as string;
  if (!reqId) throw new Error("创建需求失败，冒烟中止");

  try {
    // ---------- 初始态：created ----------
    const init = await getLifecycle(reqId);
    check("GET lifecycle 200", init.status === 200);
    check("初始态 = created", init.body?.data?.lifecycle === "created", `lifecycle=${init.body?.data?.lifecycle}`);
    check(
      "available = [dialoguing, archived]（邻接表顺序）",
      JSON.stringify(init.body?.data?.available) === JSON.stringify(["dialoguing", "archived"]),
      JSON.stringify(init.body?.data?.available)
    );
    const initBlockers = init.body?.data?.blockers as Record<string, unknown> | undefined;
    check(
      "blockers 按 available 逐条返回（一次拿全，前端免 N 次请求）",
      !!initBlockers && Object.keys(initBlockers).length === 2,
      JSON.stringify(Object.keys(initBlockers ?? {}))
    );

    // ---------- 非法迁移 → 400（合法性先于闸门） ----------
    const illegal = await postLifecycle(reqId, { to: "completed" });
    check("非法迁移 created→completed 返回 400", illegal.status === 400, `status=${illegal.status}`);
    check(
      "错误码 = invalid_transition 且 message 含允许列表",
      illegal.body?.error === "invalid_transition" && /dialoguing/.test(illegal.body?.message ?? ""),
      illegal.body?.message ?? ""
    );
    const illegal2 = await postLifecycle(reqId, { to: "review" });
    check(
      "created→review 同样是 400（不被闸门误判成 409）",
      illegal2.status === 400 && illegal2.body?.error === "invalid_transition",
      `status=${illegal2.status} error=${illegal2.body?.error}`
    );

    // ---------- 步骤推进 → 生命周期自动同步（P1-3） ----------
    await setStepState(reqId, "dialoguing", "in_progress");
    const s1 = await getLifecycle(reqId);
    check(
      "步骤 in_progress → 自动同步为 dialoguing（P1-3 钩子）",
      s1.body?.data?.lifecycle === "dialoguing",
      `lifecycle=${s1.body?.data?.lifecycle}`
    );

    // 访谈定版（dialoguing done）→ 自动进 designing；此时其余步骤尚未完成
    await setStepState(reqId, "dialoguing", "done");
    const s2 = await getLifecycle(reqId);
    check(
      "访谈 done → 自动同步为 designing（不自动进 review/completed）",
      s2.body?.data?.lifecycle === "designing",
      `lifecycle=${s2.body?.data?.lifecycle}`
    );

    // ---------- 闸门拦截 → 409（路径合法但条件不满足，与 400 语义必须区分） ----------
    const blocked = await postLifecycle(reqId, { to: "review" });
    check("余下步骤未完成时提交复核被闸门拦下（409）", blocked.status === 409, `status=${blocked.status}`);
    check("错误码 = blocked（区别于 400 的 invalid_transition）", blocked.body?.error === "blocked", `error=${blocked.body?.error}`);
    const blockers = (blocked.body?.data?.blockers ?? []) as Array<{ code: string }>;
    check(
      "409 响应体带 blockers（STEP_NOT_DONE）",
      blockers.some((b) => b.code === "STEP_NOT_DONE"),
      JSON.stringify(blockers.map((b) => b.code))
    );

    // ---------- force 越过闸门（路由契约：「确要交付请使用强制交付」） ----------
    const forced = await postLifecycle(reqId, { to: "review", force: true });
    check(
      "force=true 越过 block 级闸门（200 → review）",
      forced.status === 200 && forced.body?.data?.lifecycle === "review",
      `status=${forced.status} lifecycle=${forced.body?.data?.lifecycle}`
    );

    // ---------- 人工态不被隐式同步覆盖（真库验证 P1-2 保守规则） ----------
    for (const step of STEP_KEYS) {
      if (step !== "dialoguing") await setStepState(reqId, step as StepName, "done");
    }
    const stillReview = await getLifecycle(reqId);
    check(
      "步骤全部 done 也不覆盖人工态 review（HITL 主权）",
      stillReview.body?.data?.lifecycle === "review",
      `lifecycle=${stillReview.body?.data?.lifecycle}`
    );

    // ---------- 通过并交付 ----------
    const toCompleted = await postLifecycle(reqId, { to: "completed" });
    check("通过并交付（200 → completed）", toCompleted.status === 200 && toCompleted.body?.data?.lifecycle === "completed", `status=${toCompleted.status}`);

    // ---------- 返工：强制 reason ----------
    const noReason = await postLifecycle(reqId, { to: "designing" });
    check(
      "completed→designing 缺 reason 返回 400（不是 500）",
      noReason.status === 400 && noReason.body?.error === "reason_required",
      `status=${noReason.status} error=${noReason.body?.error}`
    );

    const rework = await postLifecycle(reqId, {
      to: "designing",
      reason: "上游卡片 constraints 变更，返工",
    });
    check("带 reason 的返工成功（200 → designing）", rework.status === 200 && rework.body?.data?.lifecycle === "designing", `status=${rework.status}`);

    // ---------- 归档 → 解档 ----------
    const archived = await postLifecycle(reqId, { to: "archived" });
    check("归档成功（200 → archived）", archived.status === 200 && archived.body?.data?.lifecycle === "archived", `status=${archived.status}`);

    const archivedRow = await db.get<{ archived_at?: string | null; lifecycle?: string }>(
      "requirements",
      reqId
    );
    check("归档同时写入 archived_at", !!archivedRow?.archived_at, `archived_at=${archivedRow?.archived_at}`);

    const afterArchive = await getLifecycle(reqId);
    check(
      "archived 是形式终态：available 为空",
      JSON.stringify(afterArchive.body?.data?.available) === "[]",
      JSON.stringify(afterArchive.body?.data?.available)
    );

    const restored = await postLifecycle(reqId, { to: "restore" });
    check("解档成功（200，回到归档前的态）", restored.status === 200, `status=${restored.status}`);
    check(
      "解档回到 designing（审计表倒查的最后归档前态）",
      restored.body?.data?.lifecycle === "designing",
      `lifecycle=${restored.body?.data?.lifecycle}`
    );
    const afterRestore = await db.get<{ archived_at?: string | null }>("requirements", reqId);
    check("解档清空 archived_at", !afterRestore?.archived_at, `archived_at=${afterRestore?.archived_at ?? "null"}`);

    // ---------- 审计表 ----------
    const rows = await auditRows(reqId);
    console.log("  审计行：");
    for (const r of rows) {
      console.log(
        `    ${r.from_state ?? "null"} → ${r.to_state}  actor=${r.actor} source=${r.source} reason=${r.reason ?? "-"}`
      );
    }
    check("审计行数 = 7（5 条人工 + 2 条派生）", rows.length === 7, `count=${rows.length}`);
    check(
      "派生迁移标记为 source=derived / actor=system",
      rows.some((r) => r.source === "derived" && r.actor === "system")
    );
    check(
      "人工迁移记录操作者与原因",
      rows.some(
        (r) => r.source === "manual" && r.actor === ACTOR && /返工/.test(r.reason ?? "")
      )
    );
    check(
      "completed→designing 的 reason 已落库（审计可信）",
      rows.some((r) => r.from_state === "completed" && r.to_state === "designing" && !!r.reason)
    );
    check(
      "解档迁移 from_state=archived 被记录",
      rows.some((r) => r.from_state === "archived" && r.to_state === "designing")
    );

    // ---------- 归属校验（越权读） ----------
    const notFound = await getLifecycle("00000000-0000-0000-0000-000000000000");
    check("不存在的需求返回 404（不泄露存在性）", notFound.status === 404, `status=${notFound.status}`);
  } finally {
    // ---------- 清理 ----------
    const del = await api(`/api/requirements/${reqId}`, { method: "DELETE" });
    const left = await db.findMany("requirements", { where: { id: { eq: reqId } } });
    const leftAudit = await auditRows(reqId);
    check("清理：临时需求已删除", del.status === 200 && left.length === 0, `status=${del.status}`);
    check(
      "清理：审计行随 FK CASCADE 一并删除（无残留）",
      leftAudit.length === 0,
      `leftover=${leftAudit.length}`
    );
  }

  console.log(`\n[smoke-lifecycle] 通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[smoke-lifecycle] 异常：", e);
  process.exit(1);
});
