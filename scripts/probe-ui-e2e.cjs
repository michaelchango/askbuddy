const { chromium } = require("playwright");

const BASE = process.env.UI_BASE || "http://localhost:3000";

const log = (...a) => console.log("[UI]", ...a);

// 在浏览器内定位对话面板根（class 含 "flex h-full flex-col bg-white"），
// 其第一个子节点即消息滚动容器；过滤掉「生成中…」气泡与空状态提示后，
// 统计真实消息条数，并判定发送按钮是否重新可用（一轮对话结束）。
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

(async () => {
  let browser;
  let projectId, reqId;
  const shots = [];
  let result = { allPass: false };

  try {
    // 1) 建测试项目
    const projRes = await fetch(`${BASE}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "UI验证-肉鸽-" + Date.now() }),
    });
    const projJson = await projRes.json();
    if (!projJson.ok) throw new Error("create project failed: " + JSON.stringify(projJson));
    projectId = projJson.data.id;
    log("created project", projectId);

    // 2) 建测试需求
    const reqRes = await fetch(`${BASE}/api/requirements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, title: "UI验证-肉鸽" }),
    });
    const reqJson = await reqRes.json();
    if (!reqJson.ok) throw new Error("create requirement failed: " + JSON.stringify(reqJson));
    reqId = reqJson.data.id;
    log("created requirement", reqId);

    // 3) 开浏览器（middleware 要求 askbuddy_session cookie，否则跳 /login）
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([
      { name: "askbuddy_session", value: "dev-ui-test", domain: "localhost", path: "/" },
    ]);
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => {
      // 过滤掉 Next dev 的 hydration/warning 噪声，只记录真正的运行时异常
      if (m.type() === "error" && !/hydrat|warning/i.test(m.text())) {
        pageErrors.push("console:" + m.text());
      }
    });

    // 预热：先用带 cookie 的请求触发该重型页面路由的首次编译（middleware 需 cookie），
    // 避免浏览器导航时卡在编译等待。
    const warmUrl = `${BASE}/dashboard/requirements/${reqId}`;
    try {
      await fetch(warmUrl, {
        headers: { Cookie: "askbuddy_session=dev-ui-test" },
        cache: "no-store",
      });
      log("pre-warmed page route");
    } catch (e) {
      log("prewarm note:", e.message);
    }
    await page.goto(warmUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    log("navigated to requirement page");

    // 4) 等右侧卡片面板出现（"背景" 字段标签）
    await page.getByText("背景", { exact: true }).first().waitFor({ timeout: 20000 });
    log("card panel visible");
    await page.waitForTimeout(500);
    const shot1 = "/d/Workspace/AskBuddy/.ui-shots/01-initial.png";
    await page.screenshot({ path: shot1 });
    shots.push(shot1);

    // 读取单个卡片字段值（标签+值容器）
    async function fieldValue(label) {
      const labelEl = page.getByText(label, { exact: true }).first();
      const parent = labelEl.locator("xpath=..");
      const txt = (await parent.textContent()) || "";
      return txt.replace(label, "").trim();
    }
    async function apiCard() {
      const r = await fetch(`${BASE}/api/requirements/${reqId}/outputs/card`, {
        cache: "no-store",
      });
      const j = await r.json();
      return (j.data && j.data.card) || {};
    }

    const ta = page.getByPlaceholder("描述你的需求想法，Enter 发送 / Shift+Enter 换行");

    async function sendRound(msg) {
      await ta.fill(msg);
      await page.keyboard.press("Enter");
      await page.waitForFunction(browserRoundDone, null, { timeout: 60000 });
      await page.waitForTimeout(2000); // 等 card SSE 事件 + SWR 重新拉取落定
    }

    // ---- 第 1 轮：产品想法（scope 应被抽取；background 用户未给，AI 应追问而非臆造）----
    await sendRound("我想做一个肉鸽（Roguelike）小游戏");
    const bg1 = await fieldValue("背景");
    const bg1api = await apiCard();
    const last1 = await page.evaluate(browserLastAssistant);
    log("R1 assistant:", JSON.stringify(last1.slice(0, 90)));
    log("R1 背景(DOM):", JSON.stringify(bg1), "API:", JSON.stringify(bg1api.background));
    const shot2 = "/d/Workspace/AskBuddy/.ui-shots/02-round1.png";
    await page.screenshot({ path: shot2 });
    shots.push(shot2);

    // ---- 第 2 轮：目标用户 ----
    await sendRound("目标用户是喜欢挑战硬核操作、有二次元审美的核心玩家");
    const tu2 = await fieldValue("目标用户");
    const tu2api = await apiCard();
    const last2 = await page.evaluate(browserLastAssistant);
    log("R2 assistant:", JSON.stringify(last2.slice(0, 90)));
    log("R2 目标用户(DOM):", JSON.stringify(tu2), "API:", JSON.stringify(tu2api.targetUsers));
    const shot3 = "/d/Workspace/AskBuddy/.ui-shots/03-round2.png";
    await page.screenshot({ path: shot3 });
    shots.push(shot3);

    // ---- 第 3 轮：核心痛点 ----
    await sendRound("核心痛点是找不到难度适中、又不会太无聊的关卡节奏");
    const pp3 = await fieldValue("核心痛点");
    const pp3api = await apiCard();
    const last3 = await page.evaluate(browserLastAssistant);
    log("R3 assistant:", JSON.stringify(last3.slice(0, 90)));
    log("R3 核心痛点(DOM):", JSON.stringify(pp3), "API:", JSON.stringify(pp3api.painPoints));
    const shot4 = "/d/Workspace/AskBuddy/.ui-shots/04-round3.png";
    await page.screenshot({ path: shot4 });
    shots.push(shot4);

    // ---- 第 4 轮：背景/初衷（用户提供后 background 应被抽取并实时回填）----
    await sendRound("这是我参加 Game Jam 的练手项目，想验证下肉鸽的关卡节奏设计");
    const bg4 = await fieldValue("背景");
    const bg4api = await apiCard();
    const last4 = await page.evaluate(browserLastAssistant);
    log("R4 assistant:", JSON.stringify(last4.slice(0, 90)));
    log("R4 背景(DOM):", JSON.stringify(bg4), "API:", JSON.stringify(bg4api.background));
    const shot5 = "/d/Workspace/AskBuddy/.ui-shots/05-round4.png";
    await page.screenshot({ path: shot5 });
    shots.push(shot5);

    // ---- 断言 ----
    const noDead = (s) => !!s && !s.includes("好的，已收到");
    const filled = (s) => !!s && s.length > 2 && !s.includes("未填写");
    const checks = [
      // 现象A：卡片随对话逐步更新（已提供的字段才回填，未提供的保持空占位）
      ["R1 背景未臆造(用户未给→空占位正常)", bg1.includes("未填写")],
      ["R2 目标用户面板已填充 (现象A)", filled(tu2)],
      ["R2 目标用户 API 一致", filled(tu2api.targetUsers)],
      ["R3 核心痛点面板已填充 (现象A)", filled(pp3)],
      ["R3 核心痛点 API 一致", filled(pp3api.painPoints)],
      ["R4 背景面板已填充 (用户提供后)", filled(bg4)],
      ["R4 背景 API 一致", filled(bg4api.background)],
      // 现象B：AI 持续引导，不出现"好的，已收到"断流
      ["R1 AI 持续引导(非断流) (现象B)", noDead(last1)],
      ["R2 AI 持续引导(非断流) (现象B)", noDead(last2)],
      ["R3 AI 持续引导(非断流) (现象B)", noDead(last3)],
      ["R4 AI 持续引导(非断流) (现象B)", noDead(last4)],
      // 回归：浏览器并发拉取时不得再出现 500（CloudBase 连接池耗尽）
      ["无前端运行时报错", pageErrors.length === 0],
    ];
    log("=== CHECKS ===");
    let allPass = true;
    for (const [name, ok] of checks) {
      log(ok ? "PASS" : "FAIL", "-", name);
      if (!ok) allPass = false;
    }
    if (pageErrors.length) log("PAGE ERRORS:", JSON.stringify(pageErrors.slice(0, 5)));

    result = {
      allPass,
      checks,
      dom: { backgroundR1: bg1, targetUsers: tu2, painPoints: pp3, backgroundR4: bg4 },
      api: {
        backgroundR1: bg1api.background,
        targetUsers: tu2api.targetUsers,
        painPoints: pp3api.painPoints,
        backgroundR4: bg4api.background,
      },
      lastReplies: { r1: last1, r2: last2, r3: last3, r4: last4 },
      pageErrors: pageErrors.slice(0, 5),
      shots,
    };
  } catch (e) {
    log("ERROR", e.stack || e.message);
    result = { allPass: false, error: e.message, shots };
  } finally {
    if (browser) await browser.close();
    // 清理测试数据
    if (reqId) {
      try {
        await fetch(`${BASE}/api/requirements/${reqId}`, { method: "DELETE" });
        log("deleted requirement", reqId);
      } catch (e) {
        log("del req failed", e.message);
      }
    }
    if (projectId) {
      try {
        await fetch(`${BASE}/api/projects/${projectId}`, { method: "DELETE" });
        log("deleted project", projectId);
      } catch (e) {
        log("del proj failed", e.message);
      }
    }
    console.log("RESULT_JSON=" + JSON.stringify(result));
  }
})();
