// 场景 01：四步工作流 + 生命周期流转 + 审计（M5-D5）。
//
// 本场景盯的是**状态机行为**，不是像素：
//   ① 新建需求 = 待开始；
//   ② 推进步骤会让生命周期**按规则**跟着走（而不是整页乱跳）；
//   ③ 本步未确认前下游阶段**绝不自动开始** —— 这是 PRDHub 的核心行为，
//      历史上最容易因为「顺手自动推进」而回归，必须钉死；
//   ④ 每次迁移都在 requirement_status_history 留下审计行。
//
// 交互细节（敲输入框、点确认条）刻意用 HTTP 代替：验收目标是状态流转，
// 敲字只会引入受控组件/防抖/禁用态的 flaky，换不来更强的断言。
// 真正的按钮点击覆盖在场景 04。

import { expect, test } from "@playwright/test";
import {
  expectLifecycle,
  gotoRequirement,
  introspect,
  parseSse,
  seed,
  sendMessage,
} from "./fixtures/seed";

test.describe("场景 01 · 四步工作流与生命周期", () => {
  test("新建 → 访谈 → 设计中 → 待复核 → 已交付，且阶段不自动推进", async ({ page, request }) => {
    // ---------- 1. 建项目（seed）→ 建需求 → 徽标 = 待开始 ----------
    const { projectId } = await seed(request, "empty");
    const created = await request.post("/api/requirements", {
      data: { projectId, title: "e2e 全流程需求" },
      timeout: 60_000,
    });
    expect(created.ok()).toBeTruthy();
    const rid = ((await created.json()) as { data: { id: string } }).data.id;

    await gotoRequirement(page, rid);
    await expectLifecycle(page, "待开始");

    // ---------- 2. 首条消息 → 需求访谈（且下游不自动开始） ----------
    await sendMessage(request, rid, "做一个灵感速记工具，面向注重效率的职场用户");

    const s1 = await introspect(request, rid);
    expect(s1.steps.find((s) => s.step === "dialoguing")?.state).toBe("in_progress");
    // ★ 核心行为断言：本步未确认，后续三步必须仍是 not_started
    const downstream = s1.steps.filter((s) => s.step !== "dialoguing");
    expect(downstream.every((s) => s.state === "not_started")).toBe(true);
    expect(s1.requirement.lifecycle).toBe("dialoguing");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expectLifecycle(page, "需求访谈");

    // ---------- 3. 确认当前阶段（UI 的确认按钮走的就是这个 PATCH） ----------
    const patched = await request.patch(`/api/requirements/${rid}/steps`, {
      data: { step: "dialoguing", state: "done", awaitingConfirm: false },
      timeout: 60_000,
    });
    expect(patched.ok()).toBeTruthy();

    const s2 = await introspect(request, rid);
    expect(s2.steps.find((s) => s.step === "dialoguing")?.state).toBe("done");
    // 派生同步：dialoguing done → designing（但不自动进 review/completed）
    expect(s2.requirement.lifecycle).toBe("designing");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expectLifecycle(page, "设计中");

    // ---------- 4. 真实生成一轮（证明生成链路与工作台集成） ----------
    const ra = await request.post(`/api/requirements/${rid}/research-analysis`, {
      timeout: 180_000,
    });
    expect(ra.ok(), `调研分析生成失败：${ra.status()}`).toBeTruthy();
    const raEvents = parseSse(await ra.text());
    expect(raEvents.some((e) => e.event === "error")).toBe(false);
    const s3 = await introspect(request, rid);
    expect(["done", "in_progress"]).toContain(
      s3.steps.find((s) => s.step === "research_analysis")?.state
    );

    // ---------- 5. 走完剩余步骤（等价于用户在每步确认后继续） ----------
    for (const step of ["research_analysis", "design", "prd_writing"]) {
      await request.patch(`/api/requirements/${rid}/steps`, {
        data: { step, state: "done", awaitingConfirm: false },
        timeout: 60_000,
      });
    }

    // ---------- 6. 人工闸门：提交复核 → 通过并交付 ----------
    const toReview = await request.post(`/api/requirements/${rid}/lifecycle`, {
      data: { to: "review", force: true },
      timeout: 60_000,
    });
    expect(toReview.ok(), `提交复核失败：${toReview.status()}`).toBeTruthy();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectLifecycle(page, "待复核");

    const toCompleted = await request.post(`/api/requirements/${rid}/lifecycle`, {
      data: { to: "completed", force: true },
      timeout: 60_000,
    });
    expect(toCompleted.ok(), `交付失败：${toCompleted.status()}`).toBeTruthy();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectLifecycle(page, "已交付");

    // ---------- 7. 审计：每次迁移都有行，且人工/派生来源可区分 ----------
    const final = await introspect(request, rid);
    expect(final.audit.length).toBeGreaterThanOrEqual(4);
    expect(final.audit.some((a) => a.to === "review" && a.source === "manual")).toBe(true);
    expect(final.audit.some((a) => a.to === "completed" && a.source === "manual")).toBe(true);
    expect(final.audit.some((a) => a.source === "derived")).toBe(true);
    expect(final.requirement.lifecycle).toBe("completed");
  });
});
