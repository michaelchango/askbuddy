# 更新日志 / Changelog

本文件记录每次版本（M 阶段）的更新说明，远端 GitHub 与本地保持同步。

## M0 — 命名统一 AskBuddy 化 + 技术债清理 (2026-08-05)

- **全站命名收敛**：`prdflow` / `PRDTube` / `prd_session` → `askbuddy` / `AskBuddy` / `askbuddy_session`
- **DOM 事件前缀常量化**：集中到 `lib/events.ts` 的 `EVT` 常量，三组件统一引用，防 dispatch/listen 字面量漂移静默失效
- **Cookie 常量下沉**：新建 `lib/auth/constants.ts`（无 next/headers 依赖）供 Edge Runtime 的 `middleware.ts` 与 `lib/auth/session.ts` 共用，避免两侧 Cookie 名不一致导致登录反复打回
- **MCP 环境变量双读**：`ASKBUDDY_*` ?? `PRDFLOW_*`，过渡期兼容存量用户本地 `mcp.json` 配置
- **三不改项（存量数据安全）**：
  - `CLOUDBASE_ENV_ID` 保持不变（永不改）
  - PAT 盐默认 `askbuddy-pat-v1`，`.env.local` 钉 `PAT_SALT=prdflow-pat-v1` 保历史 Token 可鉴权
  - 原型 script id 发 `askbuddy-structure`，`parse` 侧新旧双读旧 `prd-flow-structure`
- **清理 6 项技术债**：删 `settings/tokens` 重定向 shim、`storage.ts` COS 死分支、`markdown.tsx` 中转层内联、清 21 行调试日志（保留 `console.error`）
- **修复改名前即存在的 build blocker**：`parse.ts` 严格模式 spread 推断错误、`projects/page.tsx` 引用未定义的 `setMenuOpen`（删除成功会崩溃）
- **修复损坏的 mermaid 安装**：原 `npm install` 被网络中断截断，用 `npm pack` 重拉完整 tarball 补齐 ESM 入口与类型
- **新增文件**：`.gitattributes`（统一行尾）、`lib/auth/constants.ts`、`lib/events.ts`
- **验收**：`tsc --noEmit` 通过；`next build` 干净通过（14/14 静态页，Middleware 26.5kB）；命名扫描仅剩白名单兼容项
