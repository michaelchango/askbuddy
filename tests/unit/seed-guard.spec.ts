// e2e seed 端点的守卫单测（M5 验收 D7）。
//
// `/api/test/seed` 是**能往数据库随便写**的未鉴权端点。它在生产环境里只要可达一次，
// 就是一次数据事故。标准原文要求「在 USE_MOCK!=true 或生产环境返回 404」，
// 并要求用**单测直接调 route handler** 来钉死——不能只靠 e2e（e2e 跑的是 mock 环境，
// 天然覆盖不到"生产环境会怎样"这一侧）。
//
// 本文件里有一条常被忽略但很关键的**反向控制**：断言「合法环境下不会 404」。
// 少了它，一个永远返回 404 的实现也能让所有正向断言通过。

import { afterEach, test, vi } from "vitest";
import assert from "node:assert/strict";

// seed 路由会连带引入整条服务链路（含 CloudBase SDK 的入口模块）。
// 让它在被调用时直接抛错：万一守卫失效，这里会先炸，而不是静默连上真库。
vi.mock("@/lib/cloudbase/app", () => ({
  getCloudAI: () => {
    throw new Error("seed 守卫用例不应触碰 CloudBase SDK");
  },
}));

import { DELETE, GET, POST } from "@/app/api/test/seed/route";

const ORIGINAL_ENV = { ...process.env };

function setEnv(patch: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function restoreEnv() {
  for (const k of ["NODE_ENV", "USE_MOCK"]) {
    const v = ORIGINAL_ENV[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** 最小请求替身：守卫在读 body 之前就会拦下，所以这里够用。 */
function fakeReq(body: unknown = {}, url = "http://127.0.0.1:3100/api/test/seed") {
  return {
    json: async () => body,
    nextUrl: new URL(url),
  } as unknown as Parameters<typeof POST>[0];
}

afterEach(restoreEnv);

test("★ D7：生产环境一律 404（三个方法都拦）", async () => {
  setEnv({ USE_MOCK: "true", NODE_ENV: "production" });

  const post = await POST(fakeReq({ preset: "full-flow" }));
  const get = await GET(fakeReq());
  const del = await DELETE();

  for (const [name, res] of [["POST", post], ["GET", get], ["DELETE", del]] as const) {
    assert.equal(res.status, 404, `${name} 在生产环境必须 404`);
    const body = (await res.json()) as { ok: boolean; error: string };
    // 404 而不是 403：不暴露这个端点的存在
    assert.equal(body.error, "not_found");
  }
});

test("★ D7：USE_MOCK 未开启时一律 404（双重守卫的另一半）", async () => {
  setEnv({ NODE_ENV: "test", USE_MOCK: "false" });
  assert.equal((await POST(fakeReq({ preset: "empty" }))).status, 404);

  setEnv({ NODE_ENV: "test", USE_MOCK: undefined });
  assert.equal((await DELETE()).status, 404, "未设置 USE_MOCK 同样不放行");
});

test("★ D7 反向控制：合法环境（mock + 非生产）不得 404——否则上面的断言是空转", async () => {
  setEnv({ USE_MOCK: "true", NODE_ENV: "test" });
  // 不带 requirementId 的 GET：守卫放行后由业务分支返回 400
  const res = await GET(fakeReq());
  assert.equal(res.status, 400, "合法环境下应当走到业务校验（400），而不是被守卫拦成 404");
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "requirementId required");
});

test("D7：DELETE 在合法环境下可用（清空内存表）", async () => {
  setEnv({ USE_MOCK: "true", NODE_ENV: "test" });
  const res = await DELETE();
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { ok: boolean }).ok, true);
});
