// 确定性复现脚本：验证「卡片抽取读库(SELECT requirements)瞬时失败」时，
// 整轮对话仍可下发 reply/done、前端错误横幅不会残留。
// 依赖后端 FORCE_SQL_FAIL=requirement 仅让 SELECT requirements 失败（见 lib/db/cloudbase.ts）。
const { chromium } = require("playwright");

const BASE = process.env.UI_BASE || "http://localhost:3000";
const log = (...a) => console.log("[RECOVER]", ...a);

function browserRoundDone() {
  const ta = document.querySelector("textarea");
  if (!ta) return false;
  let el = ta;
  while (el && !(el.className && el.className.includes("flex h-full flex-col bg-white"))) {
    el = el.parentElement;
  }
  if (!el) return false;
  const scroll = el.firstElementChild;
  const kids = scroll ? Array.from(scroll.children) : [];
  let count = 0;
  for (const m of kids) {
    const t = m.textContent || "";
    if (!t.includes("生成中") && !t.includes("发送第一条消息")) count++;
  }
  const btn = document.querySelector('button[title="发送"]');
  return count >= 2 && btn && !btn.disabled;
}

function browserLastAssistant() {
  const ta = document.querySelector("textarea");
  let el = ta;
  while (el && !(el.className && el.className.includes("flex h-full flex-col bg-white"))) {
    el = el.parentElement;
  }
  const scroll = el.firstElementChild;
  const kids = scroll ? Array.from(scroll.children) : [];
  const real = kids.filter((m) => {
    const t = m.textContent || "";
    return !t.includes("生成中") && !t.includes("发送第一条消息");
  });
  return real.length ? real[real.length - 1].textContent : "";
}

function browserHasStuckError() {
  const txt = document.body.innerText || "";
  return /EMAXCONNSESSION|exec-pgsql/.test(txt);
}

(async () => {
  let browser;
  let projectId, reqId;
  const pageErrors = [];
  let result = { allPass: false };

  try {
    const projRes = await fetch(`${BASE}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "UI验证-报错恢复-" + Date.now() }),
    });
    const projJson = await projRes.json();
    if (!projJson.ok) throw new Error("create project failed");
    projectId = projJson.data.id;

    const reqRes = await fetch(`${BASE}/api/requirements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, title: "UI验证-报错恢复" }),
    });
    const reqJson = await reqRes.json();
    if (!reqJson.ok) throw new Error("create requirement failed");
    reqId = reqJson.data.id;
    log("created project", projectId, "req", reqId);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([
      { name: "askbuddy_session", value: "dev-ui-test", domain: "localhost", path: "/" },
    ]);
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error" && !/hydrat|warning/i.test(m.text())) {
        pageErrors.push("console:" + m.text());
      }
    });

    const warmUrl = `${BASE}/dashboard/requirements/${reqId}`;
    try {
      await fetch(warmUrl, { headers: { Cookie: "askbuddy_session=dev-ui-test" }, cache: "no-store" });
    } catch {}
    await page.goto(warmUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    log("navigated");
    await page.getByText("背景", { exact: true }).first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(400);

    // 发一条消息（卡片抽取会触发 SELECT requirements → 被 FORCE 钩子强制失败）
    const textarea = page.locator("textarea");
    await textarea.click();
    await textarea.fill("我想做一个肉鸽（Roguelike）小游戏");
    await page.keyboard.press("Enter");

    // 等本轮结束（发送按钮重新可用）
    let done = false;
    for (let i = 0; i < 60; i++) {
      done = await page.evaluate(browserRoundDone);
      if (done) break;
      await page.waitForTimeout(1000);
    }
    log("round done:", done);
    await page.waitForTimeout(1200);

    const last = await page.evaluate(browserLastAssistant);
    const stuck = await page.evaluate(browserHasStuckError);

    const checks = [
      ["本轮正常结束(reply/done 已下发)", done],
      ["AI 回复气泡已出现(非断流)", !!last && last.trim().length > 5 && !last.includes("好的，已收到")],
      ["错误横幅未残留(无 EMAXCONNSESSION/exec-pgsql)", !stuck],
    ];
    log("=== CHECKS ===");
    let allPass = true;
    for (const [name, ok] of checks) {
      log(ok ? "PASS" : "FAIL", "-", name);
      if (!ok) allPass = false;
    }
    if (pageErrors.length) log("PAGE-ERRORS:", JSON.stringify(pageErrors.slice(0, 5)));

    result = { allPass, lastReply: last.slice(0, 120), stuckError: stuck, pageErrors: pageErrors.slice(0, 5) };
  } catch (e) {
    log("SCRIPT ERROR:", e.message);
    result = { allPass: false, scriptError: e.message };
  } finally {
    if (browser) await browser.close();
    // 清理测试数据
    try {
      if (reqId) await fetch(`${BASE}/api/requirements/${reqId}`, { method: "DELETE" });
      if (projectId) await fetch(`${BASE}/api/projects/${projectId}`, { method: "DELETE" });
    } catch {}
    console.log("RESULT_JSON " + JSON.stringify(result));
  }
})();
