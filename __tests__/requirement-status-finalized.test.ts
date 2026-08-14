/**
 * 需求卡片定版状态推导测试。
 *
 * 防什么：M3 之后「需求卡片」是「需求确认」阶段的完成态产物，已带版本号。
 * 但 deriveRequirementStatus 仅依据各步骤 state 是否 done 推导，当 dialoguing
 * 步骤达标后保留 state=in_progress（awaitingConfirm=true，等待用户点确认）时，
 * 列表/详情接口重查会把它回落成 "dialoguing"（进行中）。
 * 前端内存态在点击确认时通过 refreshSteps 持有 done，故不切出正确；
 * 切出重挂后改用列表派生，暴露脏 state，卡片被错显为「进行中」。
 *
 * 修复：deriveRequirementStatus 增加 cardFinalized 判据（见 isCardFinalized）。
 * 卡片已定版（currentVersion>=1 或 awaitingConfirm 曾打开且非 not_started）时，
 * dialoguing 视为已完成参与推导，整体阶段不再回落为 "dialoguing"，
 * 但后续阶段标签仍由各自步骤 state 正常驱动。
 *
 * 覆盖场景：
 * 1. 卡片定版（currentVersion>=1）+ dialoguing 残留 in_progress → 不应回落 dialoguing，应推进到后续阶段
 * 2. 卡片定版（awaitingConfirm=true 且 dialoguing 非 not_started）+ dialoguing in_progress → 不回落
 * 3. 卡片未定版（currentVersion=0 且 awaitingConfirm=false）+ dialoguing in_progress → 回落 dialoguing（修复前行为，必须保留）
 * 4. 全部 done → completed
 * 5. 后续阶段（research_analysis）in_progress，卡片已定版 → 推进到 researching，而非 dialoguing
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveRequirementStatus,
  isCardFinalized,
} from "@/lib/stage-meta";
import type { Requirement, RequirementStep } from "@/types";

function makeReq(over: Partial<Requirement> = {}): Requirement {
  return {
    id: "r1",
    projectId: "p1",
    title: "t",
    status: "dialoguing",
    card: {} as Requirement["card"],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function step(
  name: RequirementStep["step"],
  state: RequirementStep["state"],
  awaitingConfirm = false
): RequirementStep {
  return {
    id: 1,
    requirementId: "r1",
    step: name,
    state,
    awaitingConfirm,
    generating: false,
  } as RequirementStep;
}

test("isCardFinalized: 版本号>=1 即定版", () => {
  assert.equal(isCardFinalized(false, 1, "in_progress"), true);
  assert.equal(isCardFinalized(false, 0, "in_progress"), false);
});

test("isCardFinalized: awaitingConfirm 打开且非 not_started 即定版", () => {
  assert.equal(isCardFinalized(true, 0, "in_progress"), true);
  assert.equal(isCardFinalized(true, 0, "done"), true);
  // awaitingConfirm 打开但步骤为 not_started：尚未达标，未定版
  assert.equal(isCardFinalized(true, 0, "not_started"), false);
  // awaitingConfirm 未打开：未定版
  assert.equal(isCardFinalized(false, 0, "in_progress"), false);
});

test("卡片已定版 + dialoguing 残留 in_progress → 不回落 dialoguing（核心修复）", () => {
  const req = makeReq();
  const steps = [step("dialoguing", "in_progress", true)];
  // 模拟 attachDerivedStatus 传入 cardFinalized
  const status = deriveRequirementStatus(req, steps, { cardFinalized: true });
  assert.notEqual(status, "dialoguing");
  // dialoguing 视为完成，无后续步骤 → completed
  assert.equal(status, "completed");
});

test("卡片版本号定版 + dialoguing 残留 in_progress → 不回落 dialoguing", () => {
  const req = makeReq();
  const steps = [step("dialoguing", "in_progress", false)];
  const status = deriveRequirementStatus(req, steps, { cardFinalized: true });
  assert.notEqual(status, "dialoguing");
});

test("卡片未定版 + dialoguing in_progress → 回落 dialoguing（行为须保留）", () => {
  const req = makeReq();
  const steps = [step("dialoguing", "in_progress", false)];
  const status = deriveRequirementStatus(req, steps, { cardFinalized: false });
  assert.equal(status, "dialoguing");
});

test("全部 done → completed", () => {
  const req = makeReq();
  const steps = [
    step("dialoguing", "done"),
    step("research_analysis", "done"),
    step("design", "done"),
    step("prd_writing", "done"),
  ];
  const status = deriveRequirementStatus(req, steps, { cardFinalized: true });
  assert.equal(status, "completed");
});

test("后续阶段 in_progress，卡片已定版 → 推进到 researching 而非 dialoguing", () => {
  const req = makeReq();
  const steps = [
    step("dialoguing", "in_progress", true), // 残留 in_progress 但未定版闸门已开
    step("research_analysis", "in_progress", false),
  ];
  const status = deriveRequirementStatus(req, steps, { cardFinalized: true });
  assert.equal(status, "researching");
  assert.notEqual(status, "dialoguing");
});

test("归档优先于定版判据", () => {
  const req = makeReq({ archived_at: "2026-02-01T00:00:00Z" });
  const steps = [step("dialoguing", "in_progress", true)];
  const status = deriveRequirementStatus(req, steps, { cardFinalized: true });
  assert.equal(status, "archived");
});
