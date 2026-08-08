// M1.3.10 回归测试：变更场景下原型任务的 changeNote 必须非空（带调试）
const { chromium } = require("playwright");
const BASE = process.env.UI_BASE || "http://localhost:3095";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "askbuddy_session", value: "mock", domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  page.on("console", (m) => {
    const t = m.text();
    if (!t.includes("Download the React DevTools")) console.log("[browser]", t);
  });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  const r = await page.request.get(BASE + "/api/requirements");
  const rj = await r.json();
  const rid = rj.data[0].id;
  console.log("使用需求:", rid);

  await page.goto(BASE + "/dashboard/requirements/" + rid, {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  await page.waitForTimeout(4000);

  // 拦截 fetch 之前先调试：检查 prototype 是否存在 + 页面是否在正确需求
  const diag = await page.evaluate(async (rid) => {
    const r1 = await fetch("/api/requirements/" + rid);
    const reqData = await r1.json();
    const r2 = await fetch("/api/requirements/" + rid + "/outputs/design?subType=prototype");
    const protoData = await r2.json();
    const r3 = await fetch("/api/requirements/" + rid + "/steps");
    const stepsData = await r3.json();
    return {
      url: location.href,
      reqId: reqData?.data?.id,
      reqStatus: reqData?.data?.status,
      protoVersion: protoData?.data?.version ?? null,
      designStep: stepsData?.data?.find((s) => s.step === "design"),
      prdStep: stepsData?.data?.find((s) => s.step === "prd_writing"),
    };
  }, rid);
  console.log("\n页面诊断:", JSON.stringify(diag, null, 2));

  // 安装 fetch 拦截器
  await page.evaluate(() => {
    window.__prototypePosts = [];
    window.__allFetches = [];
    const origFetch = window.fetch.bind(window);
    window.fetch = async function (url, opts) {
      const urlStr = typeof url === "string" ? url : url.url;
      window.__allFetches.push({ url: urlStr, method: opts?.method, body: opts?.body?.slice(0, 200) });
      if (urlStr.includes("/prototype") && opts && opts.method === "POST") {
        try {
          const body = opts.body ? JSON.parse(opts.body) : {};
          window.__prototypePosts.push({ url: urlStr, body });
        } catch {}
      }
      return origFetch(url, opts);
    };
  });

  // 拦截 window.addEventListener 来确认 CHANGE_UPDATE 监听器已注册
  await page.evaluate(() => {
    window.__changeUpdateListeners = 0;
    const origAdd = window.addEventListener.bind(window);
    window.addEventListener = function (type, handler, opts) {
      if (type === "askbuddy:change-update") {
        window.__changeUpdateListeners++;
        console.log("[probe] CHANGE_UPDATE listener registered, count=" + window.__changeUpdateListeners);
      }
      return origAdd(type, handler, opts);
    };
  });

  const cases = [
    {
      label: "case A: changes 含 design 具体变更点",
      detail: {
        requirementId: rid,
        affectedOutputs: ["design"],
        changes: [{ output: "design", field: "架构", description: "改用微服务" }],
      },
      expectChangeNoteContains: "微服务",
    },
    {
      label: "case B: affectedOutputs 含 design 但 changes 为空（之前会漏的边界）",
      detail: {
        requirementId: rid,
        affectedOutputs: ["design", "prd"],
        changes: [],
      },
      expectChangeNoteContains: "design",
    },
  ];

  let pass = 0, fail = 0;

  for (const c of cases) {
    await page.evaluate(() => {
      window.__prototypePosts = [];
      window.__allFetches = [];
    });

    console.log(`\n--- ${c.label} ---`);
    console.log("派发 CHANGE_UPDATE，detail:", JSON.stringify(c.detail));

    await page.evaluate((detail) => {
      window.dispatchEvent(new CustomEvent("askbuddy:change-update", { detail }));
    }, c.detail);

    // 等久一点（生成可能要 5+ 秒）
    await page.waitForTimeout(8000);

    const posts = await page.evaluate(() => window.__prototypePosts);
    const allFetches = await page.evaluate(() => window.__allFetches);
    console.log("全部 fetch 次数:", allFetches.length);
    allFetches.forEach((f, i) => console.log(`  [${i}] ${f.method} ${f.url.slice(-60)}`));
    console.log("/prototype POST 次数:", posts.length);

    if (posts.length === 0) {
      console.log("✗ 未发出 /prototype POST");
      fail++;
      continue;
    }
    const last = posts[posts.length - 1];
    const cn = last.body.changeNote;
    console.log("changeNote:", JSON.stringify(cn));
    if (!cn || !cn.trim()) {
      console.log("✗ changeNote 为空！");
      fail++;
    } else if (c.expectChangeNoteContains && !cn.includes(c.expectChangeNoteContains)) {
      console.log(`✗ changeNote 不含 "${c.expectChangeNoteContains}"`);
      fail++;
    } else {
      console.log(`✓ changeNote 非空且含 "${c.expectChangeNoteContains}"`);
      pass++;
    }
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})();