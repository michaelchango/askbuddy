// 需求生命周期【服务层】单测（M5-D1 / P1-2）。
//
// 与 requirement-lifecycle.spec.ts 的分工：那边测纯函数规则（不碰 IO），
// 这边测唯一写入口 + 七类闸门——必须 mock 掉 db 与 steps 两个 IO 边界，
// 否则单测会去连真库（违反 tests/setup 的「全 mock、无凭据」纪律）。
//
// 本文件钉死的三件事：
//   1. checkGate 七类闸门逐条触发（含 severity 分级：只有 DRAFT 是 warn）；
//   2. 隐式同步【永不覆盖】人工态（review/completed/archived）——HITL 主权；
//   3. 写路径产物正确：审计行 + source 语义 + completed→designing 强制 reason。

import { beforeEach, test, vi } from "vitest";
import assert from "node:assert/strict";

const { dbMock, getStepsMock } = vi.hoisted(() => ({
  dbMock: {
    get: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    countMany: vi.fn(),
    findMany: vi.fn(),
  },
  getStepsMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/services/steps", () => ({ getSteps: getStepsMock }));
// 避免经动态 import 拉进 requirements → orchestrator → client 的重依赖图。
vi.mock("@/lib/services/requirements", () => ({
  invalidateRequirementsCache: vi.fn(),
}));

import {
  checkGate,
  getLifecycle,
  restoreFromArchive,
  syncLifecycleFromSteps,
  transitionLifecycle,
} from "@/lib/services/requirement-status";
import {
  LifecycleReasonRequiredError,
  LifecycleTransitionError,
} from "@/lib/requirement-lifecycle";
import { FIELD_MAP } from "@/lib/db/field-map";

type StepStub = { step: string; state: string; awaitingConfirm: boolean };

/** 构造步骤桩：默认 done / 无闸门（即「可交付」的健康组合）。 */
function stepsOf(
  overrides: Array<Partial<StepStub> & { step: string }> = []
): StepStub[] {
  return overrides.map((o) => ({
    step: o.step,
    state: o.state ?? "done",
    awaitingConfirm: o.awaitingConfirm ?? false,
  }));
}

/** 健康组合：四步全 done，即 checkGate 应当完全放行。 */
const HEALTHY_STEPS = stepsOf([
  { step: "dialoguing" },
  { step: "research_analysis" },
  { step: "design" },
  { step: "prd_writing" },
]);

interface SetupOpts {
  requirement?: Record<string, unknown> | undefined;
  conversationCount?: number;
  suggestionCount?: number;
  devContext?: Record<string, unknown> | undefined;
  steps?: StepStub[];
}

function setup(opts: SetupOpts = {}) {
  dbMock.get.mockImplementation(async (table: string) => {
    if (table === "requirements") return opts.requirement;
    if (table === "dev_contexts") return opts.devContext;
    return undefined;
  });
  dbMock.countMany.mockImplementation(async (table: string) => {
    if (table === "conversations") return opts.conversationCount ?? 0;
    if (table === "suggestions") return opts.suggestionCount ?? 0;
    return 0;
  });
  dbMock.update.mockResolvedValue(undefined);
  dbMock.insert.mockImplementation(async (_t: string, row: unknown) => row);
  getStepsMock.mockResolvedValue(opts.steps ?? HEALTHY_STEPS);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------- checkGate

test("checkGate：非人工闸门目标态（created/dialoguing/designing/archived）恒无阻塞且不查库", async () => {
  setup({ steps: stepsOf([{ step: "dialoguing", state: "not_started" }]) });
  for (const to of ["created", "dialoguing", "designing", "archived"] as const) {
    assert.deepEqual(await checkGate("req-1", to), [], `${to} 不应有闸门`);
  }
  assert.equal(getStepsMock.mock.calls.length, 0, "自动态不应触发查库");
});

test("checkGate：健康组合（四步 done、无确认锁、无建议、DevContext 完好）→ 放行", async () => {
  setup({ devContext: { maybe_stale: 0, stale_sections: [], status: "final" } });
  assert.deepEqual(await checkGate("req-1", "review"), []);
  assert.deepEqual(await checkGate("req-1", "completed"), []);
});

test("checkGate：STEP_NOT_DONE —— 未完成步骤列出名字且为 block", async () => {
  setup({
    steps: stepsOf([
      { step: "dialoguing" },
      { step: "research_analysis", state: "in_progress" },
      { step: "design", state: "not_started" },
    ]),
  });
  const blockers = await checkGate("req-1", "review");
  const b = blockers.find((x) => x.code === "STEP_NOT_DONE");
  assert.ok(b, "应报 STEP_NOT_DONE");
  assert.equal(b.severity, "block");
  assert.match(b.message, /research_analysis/);
  assert.match(b.message, /design/);
});

test("checkGate：STALE_STEP —— pending_update 步骤单列一条（带 hint）", async () => {
  setup({
    steps: stepsOf([
      { step: "dialoguing" },
      { step: "prd_writing", state: "pending_update" },
    ]),
  });
  const blockers = await checkGate("req-1", "review");
  const stale = blockers.find((x) => x.code === "STALE_STEP");
  assert.ok(stale, "应报 STALE_STEP");
  assert.equal(stale.severity, "block");
  assert.ok(stale.hint, "阻塞项应给出可执行提示");
  // pending_update 同时会命中 STEP_NOT_DONE（它不是 done）——两条独立闸门，非重复
  assert.ok(blockers.some((x) => x.code === "STEP_NOT_DONE"));
});

test("checkGate：AWAITING_CONFIRM —— 等待确认的步骤构成独立阻塞", async () => {
  setup({
    steps: stepsOf([
      { step: "dialoguing", awaitingConfirm: true },
      { step: "research_analysis" },
    ]),
  });
  const blockers = await checkGate("req-1", "review");
  const b = blockers.find((x) => x.code === "AWAITING_CONFIRM");
  assert.ok(b, "应报 AWAITING_CONFIRM");
  assert.equal(b.severity, "block");
});

test("checkGate：PENDING_SUGGESTION —— 仅 completed 校验，review 不校验", async () => {
  setup({
    suggestionCount: 2,
    devContext: { maybe_stale: 0, stale_sections: [], status: "final" },
  });
  const review = await checkGate("req-1", "review");
  assert.ok(!review.some((x) => x.code === "PENDING_SUGGESTION"), "review 不校验建议卡");

  const done = await checkGate("req-1", "completed");
  const b = done.find((x) => x.code === "PENDING_SUGGESTION");
  assert.ok(b, "应报 PENDING_SUGGESTION");
  assert.equal(b.severity, "block");
  assert.match(b.message, /2 条/);
});

test("checkGate：DEVCONTEXT_STALE —— maybe_stale=1（SMALLINT 读法）与 stale_sections 双判据", async () => {
  setup({ devContext: { maybe_stale: 1, stale_sections: [], status: "final" } });
  const byFlag = await checkGate("req-1", "completed");
  assert.ok(byFlag.some((x) => x.code === "DEVCONTEXT_STALE"), "maybe_stale=1 应报过期");

  vi.clearAllMocks();
  setup({
    devContext: {
      maybe_stale: 0,
      stale_sections: ["business_rules", "api_contract"],
      status: "final",
    },
  });
  const bySections = await checkGate("req-1", "completed");
  const b = bySections.find((x) => x.code === "DEVCONTEXT_STALE");
  assert.ok(b, "stale_sections 非空应报过期");
  assert.match(b.message, /2 段/);
  assert.equal(b.severity, "block");
});

test("checkGate：DEVCONTEXT_DRAFT 是 warn（劝阻而非禁止，可 force 越过）", async () => {
  setup({ devContext: { maybe_stale: 0, stale_sections: [], status: "draft" } });
  const blockers = await checkGate("req-1", "completed");
  const draft = blockers.find((x) => x.code === "DEVCONTEXT_DRAFT");
  assert.ok(draft, "应报 DEVCONTEXT_DRAFT");
  assert.equal(draft.severity, "warn", "草稿态只提示不拦截");
  assert.ok(
    blockers.every((b) => b.code === "DEVCONTEXT_DRAFT"),
    "健康组合下不应出现其他阻塞"
  );
});

// ------------------------------------------------------ syncLifecycleFromSteps

test("★ 隐式同步永不覆盖人工态（review / completed / archived）", async () => {
  for (const manual of ["review", "completed", "archived"] as const) {
    vi.clearAllMocks();
    setup({
      requirement: { id: "req-1", lifecycle: manual, archived_at: null },
      conversationCount: 1,
      steps: stepsOf([{ step: "dialoguing", state: "in_progress" }]),
    });
    await syncLifecycleFromSteps("req-1");
    assert.equal(
      dbMock.update.mock.calls.length,
      0,
      `${manual} 是人工决策，不应被派生结果覆盖`
    );
    assert.equal(dbMock.insert.mock.calls.length, 0, "未写库就不应产生审计噪音");
  }
});

test("隐式同步：派生结果与当前态一致 → 不写库（避免审计噪音）", async () => {
  setup({
    requirement: { id: "req-1", lifecycle: "created", archived_at: null },
    conversationCount: 0,
    steps: stepsOf([{ step: "dialoguing", state: "not_started" }]),
  });
  await syncLifecycleFromSteps("req-1");
  assert.equal(dbMock.update.mock.calls.length, 0);
  assert.equal(dbMock.insert.mock.calls.length, 0);
});

test("隐式同步：自动态间推进 → 落库 + 审计行（source=derived, actor=system）", async () => {
  setup({
    requirement: { id: "req-1", lifecycle: "created", archived_at: null },
    conversationCount: 1,
    steps: stepsOf([{ step: "dialoguing", state: "in_progress" }]),
  });
  await syncLifecycleFromSteps("req-1");

  assert.equal(dbMock.update.mock.calls.length, 1);
  const [table, id, patch] = dbMock.update.mock.calls[0];
  assert.equal(table, "requirements");
  assert.equal(id, "req-1");
  assert.equal((patch as Record<string, unknown>).lifecycle, "dialoguing");
  assert.ok((patch as Record<string, unknown>).lifecycle_updated_at, "应写时间戳");

  assert.equal(dbMock.insert.mock.calls.length, 1);
  const [auditTable, auditRow] = dbMock.insert.mock.calls[0];
  assert.equal(auditTable, "requirement_status_history");
  const row = auditRow as Record<string, unknown>;
  assert.equal(row.from_state, "created");
  assert.equal(row.to_state, "dialoguing");
  assert.equal(row.source, "derived");
  assert.equal(row.actor, "system");
});

test("隐式同步：内部异常被吞掉（不抛、不写库），绝不阻断步骤推进", async () => {
  // 「派生不可达」分支需要绕过人工态短路才构造得出，落地成本高于收益；
  // 这里钉死的是另一半更关键的契约：同步链路的任何异常都不得外溢。
  setup({ requirement: undefined });
  await assert.doesNotReject(() => syncLifecycleFromSteps("req-missing"));
  assert.equal(dbMock.update.mock.calls.length, 0, "异常路径不得写库");
});

// ------------------------------------------------------ transitionLifecycle

test("显式迁移：非法迁移抛 LifecycleTransitionError", async () => {
  setup({ requirement: { id: "req-1", lifecycle: "created", archived_at: null } });
  await assert.rejects(
    () => transitionLifecycle("req-1", "completed", { actor: "u1" }),
    (e: unknown) => e instanceof LifecycleTransitionError
  );
  assert.equal(dbMock.update.mock.calls.length, 0);
});

test("★ 显式迁移：completed → designing 无 reason 直接拒绝（审计可信的前提）", async () => {
  setup({ requirement: { id: "req-1", lifecycle: "completed", archived_at: null } });
  // 必须抛专用异常类（而非裸 Error）——API 层据此映射 400，否则会错报 500
  await assert.rejects(
    () => transitionLifecycle("req-1", "designing", { actor: "u1" }),
    (e: unknown) => e instanceof LifecycleReasonRequiredError
  );
  await assert.rejects(
    () => transitionLifecycle("req-1", "designing", { actor: "u1", reason: "   " }),
    (e: unknown) => e instanceof LifecycleReasonRequiredError,
    "空白 reason 等同缺失"
  );
  assert.equal(dbMock.update.mock.calls.length, 0);
});

test("显式迁移：completed → designing（带 reason）落库并留审计", async () => {
  setup({ requirement: { id: "req-1", lifecycle: "completed", archived_at: null } });
  const result = await transitionLifecycle("req-1", "designing", {
    actor: "mock-user-001",
    reason: "上游卡片 constraints 变更",
    source: "change_cascade",
  });
  assert.equal(result, "designing");

  const row = dbMock.insert.mock.calls[0][1] as Record<string, unknown>;
  assert.equal(row.from_state, "completed");
  assert.equal(row.to_state, "designing");
  assert.equal(row.source, "change_cascade");
  assert.equal(row.reason, "上游卡片 constraints 变更");
  assert.equal(row.actor, "mock-user-001");
});

test("显式迁移：归档同时写 archived_at", async () => {
  setup({ requirement: { id: "req-1", lifecycle: "designing", archived_at: null } });
  await transitionLifecycle("req-1", "archived", { actor: "u1" });
  const patch = dbMock.update.mock.calls[0][2] as Record<string, unknown>;
  assert.equal(patch.lifecycle, "archived");
  assert.ok(patch.archived_at, "归档必须写 archived_at（归档的事实源）");
});

// ---------------------------------------------------------------- getLifecycle

test("getLifecycle：列值已存在 → 直接读列，不派生（不查步骤）", async () => {
  setup({ requirement: { id: "req-1", lifecycle: "review", archived_at: null } });
  assert.equal(await getLifecycle("req-1"), "review");
  assert.equal(getStepsMock.mock.calls.length, 0);
});

test("getLifecycle：列值为空（存量未回填）→ 实时派生但不落库", async () => {
  setup({
    requirement: { id: "req-1", archived_at: null },
    conversationCount: 1,
    steps: stepsOf([{ step: "dialoguing", state: "in_progress" }]),
  });
  assert.equal(await getLifecycle("req-1"), "dialoguing");
  assert.equal(dbMock.update.mock.calls.length, 0, "读路径不得产生写");
});

test("getLifecycle：需求不存在 → 抛错（不静默返回默认态）", async () => {
  setup({ requirement: undefined });
  await assert.rejects(() => getLifecycle("req-missing"), /需求不存在/);
});

// ------------------------------------------------------------- restoreFromArchive

test("解档：无归档记录 → 拒绝（不可凭空解档）", async () => {
  setup({ requirement: { id: "req-1", lifecycle: "archived", archived_at: "2026-01-01" } });
  dbMock.findMany.mockResolvedValue([]);
  await assert.rejects(() => restoreFromArchive("req-1", "u1"), /没有归档记录/);
  assert.equal(dbMock.update.mock.calls.length, 0);
});

// -------------------------------------------------------- 字段契约（回归护栏）

test("★ 写入的键必须是 field-map 登记的代码键（requirements 是 camelCase 漂移表）", async () => {
  // 背景：requirements 的代码键是 updatedAt / createdAt（camel），而
  // requirement_status_history 是 snake_case。写错键时 lib/db/postgres.ts::toColumns
  // 会【抛错】——但 syncLifecycleFromSteps 吞异常，症状是「生命周期静默不推进」。
  // mocked db 不校验字段契约，所以这条断言是本文件里唯一能提前拦住的护栏
  //（端到端由 scripts/smoke-lifecycle-api.ts 兜底）。
  setup({ requirement: { id: "req-1", lifecycle: "designing", archived_at: null } });
  await transitionLifecycle("req-1", "archived", { actor: "u1" });

  const patch = dbMock.update.mock.calls[0][2] as Record<string, unknown>;
  const reqKeys = Object.keys(FIELD_MAP.requirements);
  for (const key of Object.keys(patch)) {
    assert.ok(
      reqKeys.includes(key),
      `requirements 未登记代码键 "${key}"（会被 toColumns 抛错）`
    );
  }

  const auditRow = dbMock.insert.mock.calls[0][1] as Record<string, unknown>;
  const histKeys = Object.keys(FIELD_MAP.requirement_status_history);
  for (const key of Object.keys(auditRow)) {
    assert.ok(
      histKeys.includes(key),
      `requirement_status_history 未登记代码键 "${key}"`
    );
  }
});

test("transitionLifecycle：透传 from 时不再读库（省一次跨网关往返）", async () => {
  setup({ requirement: { id: "req-1", lifecycle: "designing", archived_at: null } });
  await transitionLifecycle("req-1", "review", { actor: "u1", from: "designing" });
  assert.equal(dbMock.get.mock.calls.length, 0, "已有 from 就不该再 get 一次");
  assert.equal(dbMock.update.mock.calls.length, 1);
});

test("transitionLifecycle：透传的 from 与库中不一致时按透传值判定（调用方责任）", async () => {
  // 库中其实是 created，但调用方声称 designing —— 以透传值为准（API 层刚从库里读到，
  // 不存在长期不一致窗口；这里只是把契约写清楚，避免以后被当 bug 改）。
  setup({ requirement: { id: "req-1", lifecycle: "created", archived_at: null } });
  await transitionLifecycle("req-1", "review", { actor: "u1", from: "designing" });
  const patch = dbMock.update.mock.calls[0][2] as Record<string, unknown>;
  assert.equal(patch.lifecycle, "review");
});

test("解档：回到审计表里最近一次归档前的态，并清空 archived_at", async () => {
  setup({ requirement: { id: "req-1", lifecycle: "archived", archived_at: "2026-01-01" } });
  dbMock.findMany.mockResolvedValue([
    { id: "h1", from_state: "review", to_state: "archived", created_at: "2026-01-01" },
  ]);
  const back = await restoreFromArchive("req-1", "u1");
  assert.equal(back, "review");
  const patch = dbMock.update.mock.calls[0][2] as Record<string, unknown>;
  assert.equal(patch.lifecycle, "review");
  assert.equal(patch.archived_at, null, "解档必须清空 archived_at");
  const row = dbMock.insert.mock.calls[0][1] as Record<string, unknown>;
  assert.equal(row.from_state, "archived");
  assert.equal(row.to_state, "review");
});

test("解档：审计行 from_state 非法（脏数据）→ 兜底到 designing，不抛错", async () => {
  setup({ requirement: { id: "req-1", lifecycle: "archived", archived_at: "2026-01-01" } });
  dbMock.findMany.mockResolvedValue([
    { id: "h1", from_state: "archived", to_state: "archived", created_at: "2026-01-01" },
  ]);
  assert.equal(await restoreFromArchive("req-1", "u1"), "designing");
});
