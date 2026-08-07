// M1.3.9 回归测试：原型 / 变更总结重复的去重防御
// 用 delta（派发前后气泡差值）而非绝对值，避免被初始 DB 数据污染。
const { chromium } = require("playwright");
const BASE = process.env.UI_BASE || "http://localhost:3095";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "askbuddy_session", value: "mock", domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  const r = await page.request.get(BASE + "/api/requirements");
  const rj = await r.json();
  const rid = rj.data[0].id;
  console.log("使用需求:", rid);

  await page.goto(BASE + "/dashboard/requirements/" + rid, {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  await page.waitForTimeout(3000);

  function findExact(text) {
    return Array.from(document.querySelectorAll('[class*="whitespace-pre-wrap"]'))
      .filter((b) => (b.textContent || "").trim() === text).length;
  }

  const out = await page.evaluate(async ({ rid }) => {
    function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

    // 用 Date.now() + 随机后缀确保每次跑都唯一，不会被初始 DB 污染
    const tag = "_dedup_test_" + Date.now() + "_";
    const PROTO_NORMAL = "✅ 原型已生成测试 " + tag + "normal";
    const PROTO_EDIT = "✅ 原型已更新测试 " + tag + "edit";
    const CHANGE_SUMMARY = "✅ 变更已全部完成！已更新：方案设计、需求卡片。你可以在左侧边栏查看最新内容。";
    const NEW1 = "🧪 unique " + tag + "new1";

    const results = [];

    function snapshot(text) { return Array.from(document.querySelectorAll('[class*="whitespace-pre-wrap"]'))
      .filter((b) => (b.textContent || "").trim() === text).length; }

    // ①原型 normal x2 → delta 期望 1（首次追加，第二次去重）
    const a0 = snapshot(PROTO_NORMAL);
    window.dispatchEvent(new CustomEvent("askbuddy:gen-message", { detail: { content: PROTO_NORMAL, requirementId: rid } }));
    window.dispatchEvent(new CustomEvent("askbuddy:gen-message", { detail: { content: PROTO_NORMAL, requirementId: rid } }));
    await wait(400);
    const a1 = snapshot(PROTO_NORMAL);
    results.push({ test: "①原型normal x2 → delta", delta: a1 - a0, expect: 1 });

    // ②原型 edit x2 → delta 期望 1
    const b0 = snapshot(PROTO_EDIT);
    window.dispatchEvent(new CustomEvent("askbuddy:gen-message", { detail: { content: PROTO_EDIT, requirementId: rid } }));
    window.dispatchEvent(new CustomEvent("askbuddy:gen-message", { detail: { content: PROTO_EDIT, requirementId: rid } }));
    await wait(400);
    const b1 = snapshot(PROTO_EDIT);
    results.push({ test: "②原型edit x2 → delta", delta: b1 - b0, expect: 1 });

    // ③全新文案 x1 → delta 期望 1
    const c0 = snapshot(NEW1);
    window.dispatchEvent(new CustomEvent("askbuddy:gen-message", { detail: { content: NEW1, requirementId: rid } }));
    await wait(400);
    const c1 = snapshot(NEW1);
    results.push({ test: "③全新文案 x1 → delta", delta: c1 - c0, expect: 1 });

    // ④其他 rid → delta 期望 0
    const d0 = snapshot("🧪 should_not_appear " + tag);
    window.dispatchEvent(new CustomEvent("askbuddy:gen-message", { detail: { content: "🧪 should_not_appear " + tag, requirementId: "other-rid" } }));
    await wait(400);
    const d1 = snapshot("🧪 should_not_appear " + tag);
    results.push({ test: "④其他rid应被忽略 → delta", delta: d1 - d0, expect: 0 });

    // ⑤CHANGE_COMPLETE x2 → delta 期望 1
    const e0 = snapshot(CHANGE_SUMMARY);
    window.dispatchEvent(new CustomEvent("askbuddy:change-complete", { detail: { requirementId: rid, affectedOutputs: ["design", "card"] } }));
    window.dispatchEvent(new CustomEvent("askbuddy:change-complete", { detail: { requirementId: rid, affectedOutputs: ["design", "card"] } }));
    await wait(400);
    const e1 = snapshot(CHANGE_SUMMARY);
    results.push({ test: "⑤CHANGE_COMPLETE x2 → delta", delta: e1 - e0, expect: 1 });

    // ⑥模拟后端 addMessage + gen_message 双路径（同内容）：先派发一次 GEN_MESSAGE 模拟 addMessage 落库导致 SWR 带回
    //    紧接着立即又派发一次同样的 gen_message 模拟 event 触发的追加 → 去重后应只 1 条
    const F = "🧪 dual_path " + tag + "f";
    const f0 = snapshot(F);
    window.dispatchEvent(new CustomEvent("askbuddy:gen-message", { detail: { content: F, requirementId: rid } }));
    window.dispatchEvent(new CustomEvent("askbuddy:gen-message", { detail: { content: F, requirementId: rid } }));
    await wait(400);
    const f1 = snapshot(F);
    results.push({ test: "⑥双路径同内容 x2 → delta", delta: f1 - f0, expect: 1 });

    return results;
  }, { rid });

  console.log("\n=== 测试结果 ===");
  let pass = 0, fail = 0;
  out.forEach((r) => {
    const ok = r.delta === r.expect;
    console.log((ok ? "✓ " : "✗ ") + r.test + ": delta=" + r.delta + " (期望=" + r.expect + ")");
    ok ? pass++ : fail++;
  });
  console.log("\n" + pass + " 通过 / " + fail + " 失败");

  if (errors.length) {
    console.log("\n!!! 页面错误:");
    errors.forEach((e) => console.log("  " + e));
  }

  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})();