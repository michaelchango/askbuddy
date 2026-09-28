// 步骤流程 harness 单测（M5-D4 / P4-3）。
//
// 盯住两类最容易悄悄回归的东西：
//   1. `setStepState` 的**条件写**语义（awaiting_confirm / generating / design_sub_phase
//      只在显式传入时覆盖）——写错会让「已开启的确认闸门被无关更新清掉」，
//      症状是确认按钮消失、流程卡住，且极难复现；
//   2. P1-3 挂的生命周期同步钩子必须仍在（漏了它，需求生命周期就再也不推进了，
//      而且因为钩子是 try/catch 静默的，不会有任何报错）。

import { beforeEach, test, vi } from "vitest";
import assert from "node:assert/strict";

const { dbMock, syncLifecycleMock } = vi.hoisted(() => ({
  dbMock: {
    findMany: vi.fn(),
    countMany: vi.fn(),
    updateWhere: vi.fn(),
    insert: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
  syncLifecycleMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: dbMock }));
// 生命周期同步钩子：验证「被调用」即可（其自身行为由 requirement-status.spec.ts 覆盖）
vi.mock("@/lib/services/requirement-status", () => ({
  syncLifecycleFromSteps: syncLifecycleMock,
}));
vi.mock("@/lib/services/requirements", () => ({
  getRequirement: vi.fn().mockResolvedValue({ current_version: 1 }),
  finalizeCardVersion: vi.fn(),
}));

import {
  completeStepAndAdvance,
  isFrontierStep,
  markStepDone,
  markStepInProgress,
  markStepPendingUpdate,
  setStepState,
} from "@/lib/services/steps";
import { STEP_KEYS, nextStepOf } from "@/lib/steps-meta";
import type { RequirementStep, StepState } from "@/types";

/** 用最少的字段构造步骤行（isFrontierStep 只读 step/state）。 */
function stepsOf(pairs: Array<[string, StepState]>): RequirementStep[] {
  return pairs.map(([step, state]) => ({ step, state }) as unknown as RequirementStep);
}

/** 判定某次 updateWhere 是否为对指定 step 的更新。 */
function patchOfStep(step: string): Record<string, unknown> | undefined {
  const hit = dbMock.updateWhere.mock.calls.find(
    (c) => (c[1] as Record<string, unknown>)?.step === step
  );
  return hit?.[2] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.countMany.mockResolvedValue(1); // 默认：步骤行已存在 → 走 updateWhere 分支
  dbMock.updateWhere.mockResolvedValue(undefined);
  dbMock.insert.mockImplementation(async (_t: string, row: unknown) => row);
});

// ───────────────────────────── 纯函数：isFrontierStep ─────────────────────────────

test("isFrontierStep：连续前缀 [done,done,in_progress,not_started] → frontier=design", () => {
  const steps = stepsOf([
    ["dialoguing", "done"],
    ["research_analysis", "done"],
    ["design", "in_progress"],
    ["prd_writing", "not_started"],
  ]);
  assert.equal(isFrontierStep(steps, "design"), true);
  // 上游不是 frontier（它下游还有非 not_started）
  assert.equal(isFrontierStep(steps, "research_analysis"), false);
  assert.equal(isFrontierStep(steps, "dialoguing"), false);
  // 末步恒为 frontier（没有下游）
  assert.equal(isFrontierStep(steps, "prd_writing"), true);
});

test("isFrontierStep：含 pending_update 的下游也算「已推进」", () => {
  const steps = stepsOf([
    ["dialoguing", "done"],
    ["research_analysis", "in_progress"],
    ["design", "pending_update"],
  ]);
  assert.equal(isFrontierStep(steps, "research_analysis"), false);
  assert.equal(isFrontierStep(steps, "design"), true);
});

test("isFrontierStep：没有下游行时按 not_started 处理（惰性初始化前）", () => {
  assert.equal(isFrontierStep([], "dialoguing"), true);
  assert.equal(isFrontierStep(stepsOf([["prd_writing", "done"]]), "prd_writing"), true);
});

test("nextStepOf：末步与非法 step 都返回 null", () => {
  assert.equal(nextStepOf("dialoguing"), "research_analysis");
  assert.equal(nextStepOf("research_analysis"), "design");
  assert.equal(nextStepOf("design"), "prd_writing");
  assert.equal(nextStepOf("prd_writing"), null);
  assert.equal(nextStepOf("nope" as never), null);
});

// ─────────────────────── setStepState 的条件写语义（回归护栏） ───────────────────────

test("★ setStepState：未显式传入时不覆盖 awaiting_confirm / generating", async () => {
  await setStepState("req-1", "design", "in_progress");
  const patch = patchOfStep("design")!;
  assert.ok(!("awaiting_confirm" in patch), "未传 awaitignConfirm 就不能写该列");
  assert.ok(!("generating" in patch), "未传 generating 就不能写该列");
  assert.ok(!("design_sub_phase" in patch), "未传 designSubPhase 就不能写该列");
  assert.equal(patch.state, "in_progress");
  assert.equal(patch.completed_at, null, "非 done 必须清空 completed_at");
});

test("setStepState：显式传入时才覆盖（含 designSubPhase 的显式清空语义）", async () => {
  await setStepState("req-1", "design", "in_progress", {
    awaitingConfirm: true,
    generating: false,
    designSubPhase: "prototype",
  });
  let patch = patchOfStep("design")!;
  assert.equal(patch.awaiting_confirm, 1);
  assert.equal(patch.generating, 0);
  assert.equal(patch.design_sub_phase, "prototype");

  vi.clearAllMocks();
  dbMock.countMany.mockResolvedValue(1);
  await setStepState("req-1", "design", "done", { designSubPhase: null });
  patch = patchOfStep("design")!;
  assert.equal(patch.design_sub_phase, null, "显式 null 必须真的写回 null（清空子阶段）");
  assert.ok(typeof patch.completed_at === "string", "done 必须写 completed_at");
});

test("setStepState：行不存在时兜底插入（不静默丢状态）", async () => {
  dbMock.countMany.mockResolvedValue(0);
  await setStepState("req-1", "prd_writing", "in_progress");
  assert.equal(dbMock.updateWhere.mock.calls.length, 0);
  assert.equal(dbMock.insert.mock.calls.length, 1);
  const row = dbMock.insert.mock.calls[0][1] as Record<string, unknown>;
  assert.equal(row.requirement_id, "req-1");
  assert.equal(row.step, "prd_writing");
  assert.ok(row.id, "必须生成步骤行 id");
});

// ───────────────────────────── 便捷封装与推进语义 ─────────────────────────────

test("markStepInProgress / markStepPendingUpdate 都会清确认闸门", async () => {
  await markStepInProgress("req-1", "design");
  assert.equal(patchOfStep("design")!.state, "in_progress");
  assert.equal(patchOfStep("design")!.awaiting_confirm, 0);

  vi.clearAllMocks();
  dbMock.countMany.mockResolvedValue(1);
  await markStepPendingUpdate("req-1", "prd_writing");
  assert.equal(patchOfStep("prd_writing")!.state, "pending_update");
  assert.equal(patchOfStep("prd_writing")!.awaiting_confirm, 0);
});

test("markStepDone：清确认闸门并写 outputVersion", async () => {
  await markStepDone("req-1", "research_analysis", 3);
  const patch = patchOfStep("research_analysis")!;
  assert.equal(patch.state, "done");
  assert.equal(patch.awaiting_confirm, 0);
  assert.equal(patch.output_version, 3);
});

test("★ completeStepAndAdvance：自身 done + 下一步 in_progress", async () => {
  await completeStepAndAdvance("req-1", "research_analysis");
  assert.equal(patchOfStep("research_analysis")!.state, "done");
  assert.equal(patchOfStep("design")!.state, "in_progress");
});

test("★ completeStepAndAdvance：末步不越界（不产生第 5 个步骤）", async () => {
  await completeStepAndAdvance("req-1", "prd_writing");
  const touched = dbMock.updateWhere.mock.calls.map(
    (c) => (c[1] as Record<string, unknown>).step
  );
  assert.deepEqual(touched, ["prd_writing"], "末步之后不该再推进任何步骤");
  assert.ok(!touched.includes("undefined"));
  assert.equal(STEP_KEYS.length, 4);
});

// ─────────────────────────── 生命周期同步钩子（P1-3 回归护栏） ───────────────────────────

test("★ setStepState 与 setAwaitingConfirm 之后必须调用生命周期同步钩子", async () => {
  await setStepState("req-1", "design", "done");
  assert.equal(syncLifecycleMock.mock.calls.length, 1, "步骤状态变化后必须同步生命周期");
  assert.equal(syncLifecycleMock.mock.calls[0][0], "req-1");

  vi.clearAllMocks();
  dbMock.countMany.mockResolvedValue(1);
  const { setAwaitingConfirm } = await import("@/lib/services/steps");
  await setAwaitingConfirm("req-1", "design", true);
  assert.equal(
    syncLifecycleMock.mock.calls.length,
    1,
    "确认闸门开合会改变 checkGate 结果，必须同步"
  );
});

test("同步钩子抛错时不得外溢（状态机是增强能力，绝不卡死四步流程）", async () => {
  // 用 Once：否则这个 rejection 会残留到后续用例（clearAllMocks 不清实现）
  syncLifecycleMock.mockRejectedValueOnce(new Error("lifecycle boom"));
  await assert.doesNotReject(() => setStepState("req-1", "design", "done"));
});
