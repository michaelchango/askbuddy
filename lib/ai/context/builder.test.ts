// AD-2 同源并列约束单测（M2-B3）：DevContext 上游不得混入 PRD。
//
// 被测对象 assertNoPrdUpstream 是零依赖纯函数（仅 import type），
// 因此本文件不需要 db / 任何上游加载逻辑。
//
// 运行：npx tsx --test lib/ai/context/builder.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { assertNoPrdUpstream } from "@/lib/ai/context/ad2";

test("devcontext 上游含『需求文档』→ 抛 AD-2 违例", () => {
  assert.throws(
    () => assertNoPrdUpstream({ "需求文档": "PRD markdown ..." }, "devcontext"),
    /AD-2 违例/
  );
});

test("devcontext 上游不含『需求文档』→ 不抛错", () => {
  assert.doesNotThrow(() => assertNoPrdUpstream({ "调研分析结论": "..." }, "devcontext"));
  assert.doesNotThrow(() => assertNoPrdUpstream({}, "devcontext"));
});

test("非 devcontext 任务（prd_writing）混入『需求文档』→ 放行", () => {
  // 只有 devcontext 受 AD-2 约束；PRD 自身当然可以基于上游文档生成。
  assert.doesNotThrow(() => assertNoPrdUpstream({ "需求文档": "..." }, "prd_writing"));
});

test("判据严格匹配 key 『需求文档』（拼写差异不应误判）", () => {
  // 仅当 key 恰为「需求文档」才触发；其余 key 不算 PRD 上游。
  assert.doesNotThrow(() => assertNoPrdUpstream({ "需求分析与结论": "..." }, "devcontext"));
});
