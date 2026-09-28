import path from "node:path";
import { defineConfig } from "vitest/config";

// M5-D4 单测基建（P0-1）。
// alias 必须与 tsconfig.json 的 paths 一致，否则全部 @/lib/* 导入解析失败。
// 覆盖率排除 lib/db/** 与 lib/cloudbase/**：这两层是 IO 适配器，单测不覆盖。
// 覆盖率阈值（全局 lines>=60%、devcontext-impact/requirement-lifecycle>=95%）
// 待 Phase 4 测试补齐后启用——现在开会直接红，先立骨架不立卡口。
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(process.cwd()),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup/unit.ts"],
    include: ["tests/unit/**/*.spec.ts", "tests/contract/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      include: ["lib/**"],
      exclude: ["lib/db/**", "lib/cloudbase/**", "**/*.test.ts", "**/*.spec.ts"],
      /**
       * 只对**纯函数**模块立卡口（M5-D4）。
       *
       * 全局 60% 阈值**刻意不启用**：当前全局 lines ≈ 36%，未覆盖的大头是
       * lib/ai/steps、lib/ai/context、lib/services —— 那些是 IO/编排层，
       * 需要的是 e2e（D5）而不是堆更多 mock 单测。给它们设阈值只会逼出
       * 「为了覆盖率而 mock 一堆 IO」的假测试。详见 docs/testing.md。
       */
      thresholds: {
        "lib/requirement-lifecycle.ts": { lines: 95, branches: 75 },
        "lib/services/devcontext-impact.ts": { lines: 95, branches: 80 },
      },
    },
  },
});
