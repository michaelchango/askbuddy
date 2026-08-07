// 针对 CloudBase 连接池耗尽（EMAXCONNSESSION）的回归测试：
// 1) execPgSql 必须在收到 EMAXCONNSESSION（HTTP 400）时重试并最终成功；
// 2) 每条网关请求必须带 Connection: close（避免空闲 keep-alive 连接占满 10 会话池）；
// 3) 业务类错误（如 SQL 语法错）不得重试，应立即抛出；
// 4) 持续 EMAXCONNSESSION 时应在 MAX_ATTEMPTS 次后抛出。
//
// 用全局 fetch 的 mock 注入，不依赖真实 CloudBase 网关。
import { test } from "node:test";
import assert from "node:assert";

// 必须在 import 目标模块前设置，模块在加载时就会读取这两个 env 构造 BASE / API_KEY。
process.env.CLOUDBASE_ENV_ID = "test-env";
process.env.CLOUDBASE_SECRET = "test-key";

type Call = { url: string; headers: Record<string, string>; body: string };

function makeMockFetch(behaviors: Array<(call: Call) => Response>) {
  const calls: Call[] = [];
  let i = 0;
  const fn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
    }
    const call: Call = { url: String(url), headers, body: String(init?.body ?? "") };
    calls.push(call);
    const behavior = behaviors[Math.min(i, behaviors.length - 1)];
    i++;
    return behavior(call);
  };
  return { fn, calls };
}

const EMAX = () =>
  new Response(
    JSON.stringify({
      code: "DATABASE_XX000",
      message:
        "(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 10",
    }),
    { status: 400, headers: { "content-type": "application/json" } }
  );
const OK = (rows: unknown[] = []) =>
  new Response(JSON.stringify(rows), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const SYNTAX = () =>
  new Response(JSON.stringify({ code: "DATABASE_EXEC_ERROR", message: "syntax error at or near x" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });

test("EMAXCONNSESSION（HTTP 400）会被重试并最终成功", async () => {
  const orig = globalThis.fetch;
  const { fn, calls } = makeMockFetch([EMAX, EMAX, OK]);
  globalThis.fetch = fn as unknown as typeof fetch;
  try {
    const { __internals } = await import("../lib/db/cloudbase.ts");
    const res = await __internals.execPgSql("SELECT 1");
    assert.deepStrictEqual(res, []);
    assert.strictEqual(calls.length, 3, "应重试 2 次后第 3 次成功");
    for (const c of calls) {
      assert.strictEqual(c.headers["connection"], "close", "请求必须带 Connection: close");
    }
  } finally {
    globalThis.fetch = orig;
  }
});

test("持久 EMAXCONNSESSION 会在 MAX_ATTEMPTS 次后抛出", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (() => EMAX()) as unknown as typeof fetch;
  try {
    const { __internals } = await import("../lib/db/cloudbase.ts");
    await assert.rejects(() => __internals.execPgSql("SELECT 1"), /EMAXCONNSESSION/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("业务类错误（SQL 语法错）不重试，立即抛出", async () => {
  const orig = globalThis.fetch;
  const { fn, calls } = makeMockFetch([SYNTAX]);
  globalThis.fetch = fn as unknown as typeof fetch;
  try {
    const { __internals } = await import("../lib/db/cloudbase.ts");
    await assert.rejects(() => __internals.execPgSql("SELECT bad"), /syntax error/);
    assert.strictEqual(calls.length, 1, "业务错误不应重试");
  } finally {
    globalThis.fetch = orig;
  }
});
