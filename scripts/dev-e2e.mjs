#!/usr/bin/env node
// e2e 专用 dev server 启动器（M5-D5）。
//
// 【为什么需要它】e2e 必须跑在「全 mock」环境（内存库 + 确定性 mock AI），
// 而 Windows 的 cmd 里写不出跨平台的 `VAR=x cmd` 前缀；引 cross-env 又要多一个依赖。
// 用 Node 显式设 env 再 spawn 是零依赖、跨平台、且**只有一份事实源**——
// playwright.config.ts 的 webServer 与人工调试都走这个脚本。
//
// ⚠️ 这里的 env 必须能盖过 .env.local：@next/env 只填空、不覆盖已存在的 process.env，
// 所以显式设进来的 USE_MOCK=true 会胜出（scripts/smoke 系列能连真库就是这个机制的反面）。
import { spawn } from "node:child_process";
import path from "node:path";

const PORT = process.env.E2E_PORT || "3100";

const env = {
  ...process.env,
  USE_MOCK: "true", // 内存库：不碰真实 CloudBase
  AI_MOCK: "true", // 确定性 mock AI：不烧 token、不抖动
  AI_MOCK_DELAY_MS: "0",
  AI_CALL_LOG: "0", // 关掉结构化日志，避免淹没 e2e 输出
  PORT,
};

// 直接起 Next 的 bin，不走 `npx`：
// Node 22+ 在 Windows 上 spawn 一个 `.cmd` 会因安全修复（CVE-2024-27980）抛 EINVAL，
// 除非加 shell:true（那又会把参数交给 cmd 解析，引号/空格全是坑）。
// 用 process.execPath + next 的 js 入口是零依赖且跨平台稳定的做法。
const nextBin = path.join("node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "dev", "-p", PORT], {
  stdio: "inherit",
  env,
});
child.on("exit", (code) => process.exit(code ?? 0));
