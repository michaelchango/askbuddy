// 状态双源回潮守卫（M5 验收 B6）。
//
// 标准原文：「全仓 grep 无任何处直接 `update requirements.lifecycle`
//（除 `requirement-status.ts`）」——并要求「加一条 lint/grep 检查进 CI」。
//
// 为什么值得单独一条测试：生命周期有两个可能的事实源（`requirements.lifecycle`
// 列 vs 步骤表派生）。一旦有人在别处顺手写一次列值，双源就会静默分叉，
// 而**两条源都不报错**、UI 也照常渲染——属于最难发现的一类回归。
// 这条测试是那个「grep 检查」，随 `npm test` 在 CI 上跑。

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** 唯一允许写 `requirements.lifecycle` 的文件（人工迁移脚本另计）。 */
const ALLOWED = ["lib/services/requirement-status.ts"];
/** 一次性迁移脚本：只在部署时跑，不属于运行时写路径。 */
const MIGRATION_ALLOWED = ["scripts/backfill-lifecycle.ts"];

const SCAN_ROOTS = ["lib", "app", "components", "mcp", "scripts"];

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test("★ B6：只有 requirement-status.ts 写 requirements.lifecycle（单一写入口）", () => {
  const root = process.cwd();
  const files = SCAN_ROOTS.flatMap((d) =>
    fs.existsSync(path.join(root, d)) ? collectSourceFiles(path.join(root, d)) : []
  );
  assert.ok(files.length > 50, `扫描到的源文件过少（${files.length}），路径可能写错了`);

  // 窗口式匹配：`update("requirements"` 起 400 字符内出现 `lifecycle:` 即视为
  // 「在 patch 里写了生命周期」。窗口而非严格 AST，是刻意的取舍——
  // 这是个 grep 级守卫（标准原文就是这么要求的），严格解析的收益不抵复杂度。
  const WRITE_LIFECYCLE = /update(?:Where)?\(\s*"requirements"[\s\S]{0,400}?lifecycle\s*:/g;

  const offenders: string[] = [];
  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    if (ALLOWED.includes(rel) || MIGRATION_ALLOWED.includes(rel)) continue;
    if (WRITE_LIFECYCLE.test(fs.readFileSync(file, "utf8"))) offenders.push(rel);
    WRITE_LIFECYCLE.lastIndex = 0; // 复用带 /g 的正则必须重置
  }

  assert.deepEqual(
    offenders,
    [],
    `以下文件绕过唯一写入口直接写了 requirements.lifecycle：${offenders.join("、")}\n` +
      `请改用 transitionLifecycle()（它同时写审计表）；确属人工迁移请加入 MIGRATION_ALLOWED 并说明理由。`
  );
});

test("B6 反向控制：唯一写入口自己必须**真的**写 lifecycle（否则上面的守卫是空转）", () => {
  // 没有这条反向断言，「所有人都不写」也能让上一条通过——
  // 而生命周期就再也不会更新了。守卫必须两侧都钉。
  const src = fs.readFileSync(
    path.resolve(process.cwd(), "lib/services/requirement-status.ts"),
    "utf8"
  );
  assert.match(src, /lifecycle:\s*to/, "requirement-status.ts 应当把目标态写进 lifecycle 列");
});
