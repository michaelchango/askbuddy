// 单测全局 setup（M5 P0-1）：确定性 + 用例隔离。
//
// 【为什么在这里设 env】
// lib/cloudbase 的 USE_MOCK、tokens 的 PAT_SALT 都是模块级常量——import 时求值。
// setupFiles 先于所有测试模块的 import 执行，保证这些常量拿到测试态取值。
process.env.USE_MOCK = "true";
process.env.AI_MOCK = "true";
process.env.AI_MOCK_DELAY_MS = "0";
process.env.PAT_SALT = "prdflow-pat-v1"; // 存量 PAT 盐：显式钉住（总览 T7）

import { beforeEach } from "vitest";

/**
 * 用例隔离：清空 mock 后端内存表。
 *
 * 【为什么是「原地清空」而不是 delete globalThis】
 * lib/db/mock.ts 在 import 时就把 globalThis.__askbuddy_memory 的对象引用
 * 捕获进模块闭包——delete globalThis 之后 mock 后端仍然持有旧引用，等于没清。
 * 必须把每张表的数组原地清空，引用不变、行数归零。
 */
beforeEach(() => {
  const g = globalThis as Record<string, unknown>;
  const memory = g.__askbuddy_memory as Record<string, unknown[]> | undefined;
  if (!memory) return;
  for (const key of Object.keys(memory)) {
    memory[key] = [];
  }
});
