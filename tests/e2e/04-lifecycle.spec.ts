// 场景 04：生命周期闸门与人工操作（M5-D5）。
//
// 与场景 01 的分工：01 走「程序化推进」，本场景走**真实按钮点击** ——
// 确认条、提交复核、打回、归档/解档、以及「被闸门挡住时按钮置灰 + tooltip」。

import { expect, test } from "@playwright/test";
import {
  expectLifecycle,
  gotoRequirement,
  introspect,
  lifecycleBadge,
  seed,
} from "./fixtures/seed";

test.describe("场景 04 · 生命周期闸门", () => {
  test("★ 存在未处理建议时，「通过并交付」置灰并给出原因（block 级闸门）", async ({
    page,
    request,
  }) => {
    const { requirementId } = await seed(request, "review-blocked");
    const rid = requirementId as string;

    await gotoRequirement(page, rid);
    await expectLifecycle(page, "待复核");

    const deliver = page.getByRole("button", { name: "通过并交付" });
    await expect(deliver).toBeVisible({ timeout: 30_000 });
    // 被 block 级闸门挡住 → 置灰（而不是隐藏：用户必须知道"为什么不能交付"）
    await expect(deliver).toBeDisabled();
    await expect(deliver).toHaveAttribute("title", /未处理的条目建议/);

    // 库内状态与 UI 一致（没有偷偷放行）
    const snap = await introspect(request, rid);
    expect(snap.requirement.lifecycle).toBe("review");
  });

  test("提交复核 → 打回修改 → 归档 → 重新打开（人工流转闭环）", async ({ page, request }) => {
    const { requirementId } = await seed(request, "draft-devcontext");
    const rid = requirementId as string;

    await gotoRequirement(page, rid);
    await expectLifecycle(page, "设计中");

    // ---------- 提交复核 ----------
    await page.getByRole("button", { name: "提交复核" }).click();
    await expect(lifecycleBadge(page)).toHaveText("待复核", { timeout: 30_000 });
    let snap = await introspect(request, rid);
    expect(snap.requirement.lifecycle).toBe("review");
    expect(snap.audit.some((a) => a.to === "review" && a.source === "manual")).toBe(true);

    // ---------- 打回修改（review → designing） ----------
    await page.getByRole("button", { name: "打回修改" }).click();
    await expect(lifecycleBadge(page)).toHaveText("设计中", { timeout: 30_000 });
    snap = await introspect(request, rid);
    expect(snap.requirement.lifecycle).toBe("designing");

    // ---------- 归档（有二次确认弹窗，必须接受） ----------
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "归档" }).click();
    await expect(lifecycleBadge(page)).toHaveText("已归档", { timeout: 30_000 });
    snap = await introspect(request, rid);
    expect(snap.requirement.lifecycle).toBe("archived");
    expect(snap.audit.some((a) => a.to === "archived")).toBe(true);

    // ---------- 解档：回到归档前的态（designing） ----------
    await page.getByRole("button", { name: "重新打开" }).click();
    await expect(lifecycleBadge(page)).toHaveText("设计中", { timeout: 30_000 });
    snap = await introspect(request, rid);
    expect(snap.requirement.lifecycle).toBe("designing");
    expect(snap.audit.some((a) => a.from === "archived" && a.to === "designing")).toBe(true);
  });

  test("DevContext 为 draft 时交付只给 warn（可越过，不硬拦）", async ({ page, request }) => {
    const { requirementId } = await seed(request, "draft-devcontext");
    const rid = requirementId as string;

    // 先把四步补齐并进入 review（seed 的 draft-devcontext 停在 designing）
    for (const step of ["dialoguing", "research_analysis", "design", "prd_writing"]) {
      await request.patch(`/api/requirements/${rid}/steps`, {
        data: { step, state: "done", awaitingConfirm: false },
        timeout: 60_000,
      });
    }
    const toReview = await request.post(`/api/requirements/${rid}/lifecycle`, {
      data: { to: "review", force: true },
      timeout: 60_000,
    });
    expect(toReview.ok()).toBeTruthy();

    await gotoRequirement(page, rid);
    await expectLifecycle(page, "待复核");

    // draft 只是 warn：按钮可用，但 tooltip 会提示风险（不硬拦，符合「不硬发」但要告知）
    const deliver = page.getByRole("button", { name: "通过并交付" });
    await expect(deliver).toBeEnabled();

    await deliver.click();
    await expect(lifecycleBadge(page)).toHaveText("已交付", { timeout: 30_000 });

    const snap = await introspect(request, rid);
    expect(snap.requirement.lifecycle).toBe("completed");
    expect(snap.devContext.status).toBe("draft");
  });
});
