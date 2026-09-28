// Playwright e2e 配置（M5-D5 · P4-4）。
//
// 三条硬约束，每条都对应一个会让人 debug 半天的坑：
//   1. **必须 workers: 1**：所有 worker 共享同一个 dev server 的**同一份内存表**，
//      并行会互相污染，症状是「单跑绿、全跑红」；
//   2. **webServer 必须走 scripts/dev-e2e.mjs**：全 mock 环境（内存库 + 确定性 AI）
//      是唯一的事实源，不要在配置里另抄一份 env；
//   3. **仅 chromium**：合并版没有跨浏览器需求，多浏览器只会让 CI 慢 3 倍。
import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.E2E_PORT ?? "3100";
export const E2E_BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // 全流程场景要串起对话→调研→方案→原型→PRD→DevContext，给足时间
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI, // CI 里禁止 test.only（否则会静默跳过大量用例）
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: E2E_BASE_URL,
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node scripts/dev-e2e.mjs",
    url: E2E_BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
