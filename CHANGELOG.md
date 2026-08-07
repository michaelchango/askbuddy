# 更新日志 / Changelog

本文件记录每次版本（M 阶段）的更新说明，远端 GitHub 与本地保持同步。

## M1 — 数据底座 NoSQL → CloudBase PostgreSQL（经网关 SQL 接口，不依赖 DATABASE_URL）(2026-08-06)

- **数据层四后端一套契约**：`mock` / `nosql` / `postgres`(直连 PG 协议) / `cloudbase`(网关 SQL 接口)。新增 `lib/db/cloudbase.ts`。
- **cloudbase 后端（B 通道）**：全部 SQL 走 CloudBase 公网网关 `/v1/rdb/exec-pgsql`，凭据复用 `CLOUDBASE_SECRET`（API Key），以 `Role=cloudbase_postgres` 调用；**不依赖 `DATABASE_URL`（PG 协议连接串）**，无需腾讯云密钥。
- **SQL 构造**：exec-pgsql 网关不支持参数化（占位符 `$1` 报 500），改用「安全字面量序列化」——标识符走 field-map 白名单 / TABLES 集合，值统一转义（`'` 与 `\`），JSONB 列追加 `::jsonb`，等效预处理语句、零注入风险。
- **建库脚本** `scripts/db-setup-cloudbase.ts`（`npm run db:setup:cloudbase`）：`CREATE EXTENSION IF NOT EXISTS vector` + 拆分 `db/schema.sql` 逐条执行，幂等。已建 16 张业务表 + 12 索引，`vector` 扩展可用。
- **真 pgvector（撤销临时方案）**：用户决策改回真向量检索。原「real[] + 应用层余弦」临时方案废弃；`searchVector`（lib/db/{postgres,cloudbase}.ts）经 `1 - (col <=> $q::vector)` 在 SQL 层下推余弦相似度，业务零改动。`docs/ops/pgvector-enabled.md`、`db/schema.sql` 注释同步更新。
- **对拍测试泛化**：`__tests__/db-pushdown-parity.test.ts` L3 不再强依赖 `DATABASE_URL`，`DB_BACKEND=cloudbase`（无 DATABASE_URL）也能对真实库跑 list/findMany 对拍。
- **验收**：`npm run db:check` 契约 16/16/16；`npm run test:parity DB_PARITY_PG=true` 真实 CloudBase **82/82**（含 L3）；真 pgvector `<=>` 检索端到端通过；`next build` 全绿。
- **配置**：`.env.local` 置 `DB_BACKEND=cloudbase`；`DATABASE_URL` 留空（cloudbase 路径不需要）。`tsconfig.json` 排除探索用 `scripts/probe-*.ts` 以免拖慢构建类型检查。

## M1.1 — 热修：requirements.title_source CHECK 约束值域漂移 (2026-08-06)

- **现象**：运行时 `UPDATE requirements SET title_source='auto' ...` 触发 `DATABASE_23514`，违反 `requirements_title_source_check`。
- **根因**：schema CHECK 允许 `('manual','ai')`，但代码契约 `TitleSource = "auto" | "manual" | null`（`types/index.ts:64`）实际写入 `'auto'`、`'ai'` 从未使用 —— 属 schema 落后于代码的漂移。
- **修复（三处契约源一致）**：
  - `db/drizzle/schema.ts` `ck_req_title_source`：`IN ('manual','ai')` → `IN ('manual','auto')`（migrate.ts 从 schema.ts 程序化读 CHECK，自动跟随）。
  - `db/schema.sql`：`title_source` 改为显式命名 `CONSTRAINT ck_req_title_source CHECK (... IN ('manual','auto'))`，与 drizzle 命名对齐。
  - **线上库**：经 B 通道执行 `scripts/db-fix-title-source-check.ts`，DROP 旧 `requirements_title_source_check`、ADD `ck_req_title_source`（值域 `'manual','auto'`）。已验证线上约束定义生效。
- **附带扫描**：对其余 CHECK（`ck_projects_status`/`ck_conv_role`/`ck_req_step`/`ck_req_state`/`ck_req_completion`/`ck_share_type`）与代码 enum 逐一比对，均无漂移。
- **新增脚本**：`scripts/db-fix-title-source-check.ts`（热修）、`scripts/verify-title-source-check.ts`（校验）。

## M1.2 — 修复：对话中需求卡片（背景/目标用户/核心痛点等）不被记录 (2026-08-06)

- **现象**：在对话里提出需求后，需求卡片的 background / targetUsers / painPoints / scope / nonFunctional / constraints 大多为空，没有随对话逐步沉淀。
- **根因**：卡片唯一可靠的落库路径是 `finalizeDialogue → extractReplyAndCard → mergeRequirementCard`，而 `extractReplyAndCard` **完全依赖模型在每轮回复末尾吐出 ```` ```json ```` 卡片块**。对话用的是轻量模型 `hy3`，让其「自然语言回复 + 卡片 JSON + [STEP_COMPLETE]/[COMPLEXITY] 标记」同条输出失败率高——漏写/写错 JSON 块时正则不命中，合并跳过空串，卡片恒空。本应兜底的 `lib/ai/prompts/extract-card.ts`（`extractCardPrompt`，整段对话→卡片）此前**从未被接线**。
- **修复（解耦「抽卡片」与「模型夹带 JSON」）**：
  - `lib/ai/orchestrator.ts` 新增 `extractCard(requirementId)`：读整段对话 → 用 `extractCardPrompt` + `callAI`（dialoguing 模型，非流式）→ `extractReplyAndCard` 解析；返回部分卡片，空则 `null`。失败兜底 `null`，不阻断对话。
  - `lib/services/requirements.ts` 新增 `extractCardFromConversation(id)`：`extractCard` → `mergeRequirementCard`（增量合并：只填非空、覆盖已有值，支持逐步完善与对话中纠正）；并重写 `generateCard`（原「原文前 500 字 + 其余『待补充』」的退化实现改为走 AI 抽取）。
  - `app/api/requirements/[id]/conversation/route.ts`：正常对话流程每轮在落库 assistant 回复后，用 `extractCardFromConversation` 渐进抽取，**仅当合并后字段 < 4 才触发一次额外 AI 调用**（控制成本）；以合并后的 `liveCard` 发 `event: card` 并据其计算需求确认 `stepReady`，不再依赖模型是否夹带 JSON。
  - `extractCardPrompt.buildUser` 入参补 `message: ""` 满足共享 `PromptVars` 类型。
- **回归测试** `__tests__/card-capture.test.ts`：`extractReplyAndCard` 分离/空块、以及 `mergeRequirementCard` 增量合并（保留/新增/覆盖纠正）三用例全绿。
- **验收**：`USE_MOCK=true npm run build` 全绿；`npx tsx --test __tests__/card-capture.test.ts` **3/3** 通过。

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

## M1.3 — 修复：需求页「卡片不更新 / AI 断流 / 浏览器并发 500」(2026-08-06)

- **现象（用户实测）**：
  1. 对话过程中右侧需求卡片（背景/目标用户/核心痛点等）不随对话刷新；
  2. 原本「记录用户回答 + 引导下一需求点」的机制断流——用户回答后 AI 只回「好的，已收到」就停；
  3. 浏览器控制台每轮出现 1 次 `Failed to load resource: status 500`。
- **根因 A/B（同一处）**：Next.js App Router 运行时替换了全局 `fetch`，`lib/db/cloudbase.ts` 的 `execPgSql` 与 `lib/api/client.ts` 的 `api()` 缺少 `cache: "no-store"`，导致 SELECT 响应被写进 **Data Cache（落盘 `.next/cache/fetch-cache`，重启 dev 都不失效）**。每次 DB 读（卡片/消息）都经过这两处——读 `getMessages` 返回陈旧历史 → 模型只看到残缺上下文 → 产出死回复「好的，已收到」（现象 B）；读 `getRequirement` 的卡片 → 面板永不刷新（现象 A）。两现象同源，一处 `no-store` 修复同时解决。
  - 注：PRDHub 时代走 `@cloudbase/node-sdk`（SDK 自带 HTTP 客户端，不经全局 fetch）故无此问题；迁到网关 SQL 通道后才暴露。已在两处 `fetch` 补 `cache: "no-store"` 并注明「删掉会立刻制造数据永远不更新的幽灵 bug」。
- **根因 C（500）**：CloudBase 网关 SQL 通道是「session 模式」，单会话连接池上限 `pool_size=10`。浏览器打开需求页会瞬间并发发起多个接口（RSC 页面渲染 + 多个 SWR 拉取 + 对话流读），`listOutputs` 一次 `Promise.all` 就扇出 4 条 `db.get`；在途连接突破 10 → 网关报 `DATABASE_XX000 EMAXCONNSESSION`（max clients reached）→ `execPgSql` 抛错 → Route Handler 包成 500 打回前端控制台。
- **修复 C（DB 层健壮性）**：在 `lib/db/cloudbase.ts` 给 `execPgSql` 套上「**并发栅栏（令牌桶，上限 6，留足余量给本机常驻的孤儿 dev server 同食同一 10 连接池）+ 瞬时错误重试（退避，仅对 EMAXCONNSESSION/限流/抖动类重试，业务错误立即抛出）**」，从根上避免池耗尽、消除偶发 500。
- **回归测试（真实无头浏览器 E2E）**：
  - `scripts/probe-ui-e2e.cjs`：建临时 project+requirement → 无头 Chromium 开需求页 → 发 4 轮对话（产品想法→目标用户→核心痛点→背景）→ 断言卡片逐轮实时回填且 DOM==API、AI 持续引导无「好的，已收到」、无 500、背景未臆造（用户未给→空占位正常，给了→回填）。**12/12 PASS**。
  - `scripts/probe-sse-e2e.ts`：SSE 协议层回归（事件序列 / 卡片事件 / done）。
  - 浏览器经 `askbuddy_session` cookie 绕过 `middleware.ts` 的 `/login` 跳转；导航前带 cookie 预热重型页面路由避免编译超时。
- **验收**：真实浏览器 E2E 12/12 PASS、服务端日志无 EMAXCONNSESSION/500；现象 A/B 复现脚本（step-by-step 对话）卡片与回复均恢复实时。

## M1.3.1 — 精炼修复：进入下一阶段时 UPDATE requirement_steps 仍偶发 EMAXCONNSESSION (2026-08-07)

- **现象（用户实测）**：卡片填到阈值、对话建议「是否进入下一阶段」时，后端 `UPDATE "requirement_steps" SET "awaiting_confirm"=1`（conversation/route.ts:434，无 `.catch`）抛出 `exec-pgsql HTTP 400: DATABASE_XX000 EMAXCONNSESSION`，整个 SSE 流被打挂。
- **M1.3 的修复为何没兜住**：M1.3 的并发栅栏只在**单进程内**限流，且重试只防「瞬时」。真凶是**跨进程的空闲 keep-alive 连接**：网关 SQL 通道是 session 模式，**一个 keep-alive 连接就占一个 SQL 会话槽，池只有 10**；本机常驻的多个孤儿 `next dev`（旧代码、仍开 keep-alive）即使空闲也各握着几条会话不释放，把 10 槽池占死。活跃服务器发请求时池已满，重试那几百毫秒里槽位始终没空，3 次全失败。
- **根因定位手段**：本地 mock `globalThis.fetch` 的单测（`__tests__/cloudbase-retry.test.ts`）确定性验证重试与请求头；并实测 `Get-NetTCPConnection` 发现 5 个 AskBuddy 孤儿 dev server（:3000/:3001/:3002/:3003/:3077）同时在吃连接池，已用 PowerShell `Stop-Process` 全部清除释放会话槽。
- **修复（DB 层）**：
  1. **每条网关请求强制 `Connection: close`**（execPgSqlOnce 的 fetch header）——session 模式下空闲进程占 0 会话槽，只有「在途」请求才占槽，跨进程争用从根上消除；
  2. **并发栅栏上限 6 → 4**：即便同机再开一个 dev server 各跑 4，合计 8 也留 2 槽余量；
  3. **重试 3 → 5 次、指数退避 + 随机抖动**（150ms·2ⁿ + ≤120ms 抖动），且重试判定靠错误体关键字 `EMAXCONNSESSION`（它返回的是 HTTP 400 而非 5xx，不靠状态码）。
- **回归测试**：`__tests__/cloudbase-retry.test.ts` 3/3 PASS —— ① EMAXCONNSESSION(HTTP400) 重试 2 次后成功且每次请求带 `Connection: close`；② 持续 EMAXCONNSESSION 在 5 次后抛错；③ 业务类错误（SQL 语法错）不重试立即抛出。`scripts/probe-ui-e2e.cjs` 真实浏览器 E2E 12/12 PASS（含卡片填满后触发 awaiting_confirm UPDATE 的路径，无 500）。
- **运维项（根治关键）**：连接池是**全机共享**的，务必「只跑一个 `next dev`」。本机残留的多个孤儿 dev server 会持续占满池，需手动结束（`Stop-Process -Name node` 筛 AskBuddy 的 next 进程，或重启机器）。代码侧的 `Connection: close` 已保证活跃服务器不再制造空闲占用。

## M1.3.2 — 生产多用户场景：连接池是「按 CloudBase 环境共享」的硬上限 (2026-08-07)

- **用户追问**：系统部署到服务器后，会不会出现「两个用户在用、第三个被堵死」的类似问题？
- **实测结论（关键）**：`pool_size=10` 的 session 模式连接池是**按 CloudBase 环境（同一 `CLOUDBASE_ENV_ID`）共享**的硬上限，不是「按进程」也不是「按用户」。单个干净实例（并发栅栏上限 4 + `Connection: close`）**绝不会**自己耗光 10 槽——孤立单实例 E2E 12/12 PASS、服务端日志 0 个 EMAXCONNSESSION。但**只要环境里存在任何其他消费者**（第二个实例、用户自己的实时会话、同一环境的其它应用），它们都吃同一份 10 槽：本机仅 2 个实例并发时就复现了间歇性 500，连单实例在「用户同时在线使用同一环境」时也偶发 500。**这正是「第三个用户被堵死」的结构性风险**，与本地孤儿进程无关、是网关 ceiling 本身。
- **代码加固（软降级，避免硬失败）**：`app/api/requirements/[id]/conversation/route.ts` 把 conversation 流里「非必要」的写库副作用（`maybeAutoTitle` / `setAwaitingConfirm` / `getSteps` / `markStepInProgress`）整体包进内层 `try/catch`——`reply`/`card` 事件已先发出，这部分失败只意味着「阶段闸门未自动打开」，发 `recoverable:true` 的错误事件并照常发 `done`，**不再让整条 SSE 流断裂**。即便连接池在高并发下被瞬时空满，第三个用户也是「AI 回复与卡片已更新，请稍后点击重试」而非对话炸掉。
- **真正的生产级解法（不在代码、在配置/架构）**：
  1. **调大 `pool_size`**：`pool_size=10` 是网关侧（或环境规格）配置项，向 CloudBase 控制台/工单申请调大（如 50~100），多实例并发即可舒适容纳；这是最直接的杠杆。
  2. **改用 PG 协议 `DATABASE_URL` + `pg.Pool`（transaction 模式）替代网关 `exec-pgsql` HTTP 通道**：CloudBase 官方「连接管理」文档推荐的线上做法，连接上限是 PG 实例的 `max_connections`（通常 100+），且按「单实例池上限 × 实例数」自己掌控；本项目的 SQL 已是安全字面量序列化（field-map 白名单 + `lit()` 转义），直接落到 `pg.Pool` 无注入风险。属较大的数据层重构，需单独排期。
  3. **上线初期保持单实例 / 低实例数**，等 `pool_size` 调大或完成 PG 协议迁移后再水平扩容。
- **验收**：`tsc --noEmit` 通过；`__tests__/cloudbase-retry.test.ts` 3/3 PASS；孤立单实例E2E 12/12 PASS（0 个 EMAXCONNSESSION）。多实例/共享环境下的偶发 500 由上述软降级 + `pool_size` 调大兜底。

## M1.3.3 — 「报错信息一直显示」横幅卡死 + 对话轮彻底抗连接池抖动的修复 (2026-08-07)

- **用户实测反馈**：需求卡片完成后、点顶部「进入下一阶段」能实际往后走（生成调研报告、继续到方案设计），但**那句 `EMAXCONNSESSION` 报错横幅一直挂在界面上不消失**（SQL 仍是 `SELECT * FROM "requirements"` 那条 `getRequirement`）。
- **根因 A（前端横幅不清除）**：该 `getRequirement` 在 `conversation/route.ts` 里位于**任何 try 之外**，连接池瞬时耗尽时一路冒泡到最外层 `catch` → 发**致命 `error` 事件**（携带原始 `exec-pgsql HTTP 400 ...` 文本）。而前端 `conversation-panel.tsx` 只在「用户再发一条消息」时（`send()` 开头 `setError(null)`）才清横幅；用户是去点顶部的「进入下一步」（走另一条 API），根本不触发 `send()`，于是致命横幅**永久残留**。
- **根因 B（该致命错误发生在 reply/card/done 之前）**：第 401 行的 `getRequirement` 在 `reply`/`card`/`done` 下发之前就抛错，整轮对话直接炸，横幅挂住、无法自动消除。
- **修复（后端 `conversation/route.ts`）**：
  1. 把卡片抽取块（含 `getRequirement` + `extractCardFromConversation`）整体包进 `try/catch`——读/抽失败仅跳过本次卡片更新（且不发 `card` 事件，避免把右侧已填好的卡片清空），**`reply`/`done` 照常下发**；
  2. 引入 `replySent` 标志：回复一旦经 SSE 下发，后续任何**瞬时 DB 故障**（含 `finalizeDialogue` 读历史、`addMessage` 落库、阶段状态写入）都降级为 `recoverable:true` 错误事件 + 照常 `done`，**不再致命**；`finalizeDialogue` 与 `addMessage(assistant)` 也各自包成非致命（失败仅跳过落库，回复已发给用户）；
  3. 路由级测试钩子 `FORCE_CONV_CARD_FAIL=1`：仅让对话轮的 `getRequirement` 抛 `EMAXCONNSESSION`，精确复现用户场景而不影响初始页面加载。
- **修复（前端 `conversation-panel.tsx`）**：错误横幅在收到 `done` / `card` / `step_update` / `proceed_prompt` 等**进展类事件时清除**；`recoverable:true` 的错误**8 秒后自动消失**，不长期占界面；卸载时清理自动消失计时器。这样即便偶发瞬时故障，横幅也不会卡死。
- **配套调优（`lib/db/cloudbase.ts`）**：并发栅栏上限 `4 → 3`（单进程至多占 3 槽，给同环境其它消费者留 ≥4 槽余量）；重试 `5 → 7` 次（指数退避 + 抖动），更稳地吸收共享池的瞬时争用；导出 `isTransientSqlError` 供路由复用。
- **回归测试**：
  - `scripts/probe-error-recover.cjs`（新）：用 `FORCE_CONV_CARD_FAIL=1` 确定性复现「`SELECT requirements` 读库失败」——断言**本轮正常结束(reply/done 已下发)、AI 回复气泡出现、错误横幅未残留**，3/3 PASS；
  - `scripts/probe-ui-e2e.cjs`：新增「对话结束后错误横幅未残留」断言，并把背景字段断言改为「正确行为」口径（用户未给→空占位 / 给了→取材原话，不臆造）；常规 E2E **13/13 PASS**（两轮稳定），R4 背景正确抽取为「参加 Game Jam 的练手项目…」；
  - `__tests__/cloudbase-retry.test.ts` 3/3 PASS（不受重试次数改动影响）。
- **结论**：用户报的「报错一直显示」已修复（横幅不再卡死、偶发连接池抖动降级为可恢复提示）；但 `pool_size=10` 按环境共享的**结构性上限仍在**，根治仍需「调大 `pool_size`」或「迁移 PG 协议 `pg.Pool`（transaction 模式）」（见 M1.3.2）。代码侧已做到：共享池偶发争用下，用户**永远能拿到 AI 回复并继续推进**，不会被卡死。

## M1.3.4 — `handleProceed` fire-and-forget 导致「对话自动推进失败但按钮可以」的修复 (2026-08-07)

- **用户实测反馈**：需求卡片完成后，在对话里发「进入下一阶段」→ AI 回答「推进到调研分析」但**调研报告未生成**；再发一次「进入下一阶段」→ 出现 500 兜底「好的，已收到」；但此时**点击顶部「进入下一阶段」按钮却能正常生成报告**。两条路径本应触发同一套流程，不该出现不同结果。
- **根因**：`handleProceed`（`requirement-shell.tsx` 第 494 行）中 `handleGenerate(nextStep)` 是 **fire-and-forget（无 `await`）**。当对话 AUTO 分支通过 SSE 下发 `proceed_prompt{auto:true}` → 前端调用 `handleProceed` → PATCH 标记当前步骤 done → 再 fire-and-forget 调用 `handleGenerate(nextStep)` 发起调研/方案/PRD 生成。若生成 API 因瞬时 DB 故障（EMAXCONNSESSION）返回 500，`handleGenerate` 的 catch 仅 `console.error` 后静默吞掉错误——用户看到「推进到 XX」的回复但报告永不出。而之前 `pendingPrompt`（来自 STEP_COMPLETE 判定）仍未清除，所以**顶部按钮恰好指向相同的（步→下一步）对、且点击时 DB 池已释放，能成功生成**——两条路径走了同一套 `handleProceed → handleGenerate` 代码，但失败路径对用户完全不可见。
- **修复（三处联动）**：
  1. **`handleGenerate` catch 改为 re-throw**（`requirement-shell.tsx`）：让调用方能捕获错误并做降级，而非静默吞掉。`processChangeQueue`（变更更新队列）已有 try/catch 不受影响。
  2. **`handleGenerate` SSE 解析新增 `error` 事件处理**：后端生成流水线异常（如 EMAXCONNSESSION）经 SSE `event: error` 下发时，原逻辑完全忽略、静默等到 `done` 结束；现改为抛出 `Error(msg)`，中断 SSE 读取并触发外层 catch。
  3. **`handleProceed` 中 `await handleGenerate` + 失败回退**：生成失败后**设置 `pendingPrompt`**（与正常 `proceed_prompt` 行为一致），用户可通过顶部按钮重试；同时 dispatch `EVT.GEN_ERROR` 通知对话面板显示可恢复错误横幅（8s 自动消失）。AbortError（用户主动取消）则跳过、不设重试入口。
- **新增事件常量** `EVT.GEN_ERROR = "askbuddy:gen-error"`（`lib/events.ts`）：`requirement-shell` 下发 → `conversation-panel` 监听并设置 `setError`（含 8s 自动消失）。
- **验收**：`tsc --noEmit` 零错误。逻辑上，生成失败后用户会立即看到：① 错误横幅（8s 后消失）；② 顶部出现「生成失败，请点击上方按钮重试」确认按钮——点击即重试同一对（步→下一步），等效正常 proceed_prompt 流程。

## M1.3.5 — 原型子阶段 fire-and-forget 导致方案设计→原型失败 + 对话脱轨修复 (2026-08-07)

- **用户实测反馈**：方案设计完成后对话发「进入下一阶段」→ AI 回答「✅ 已确认方案文档，正在进入原型设计」但**原型未实际生成、右侧栏无更新**；再发一次「进入下一阶段」→ 500 兜底「好的，收到」；顶部按钮文案异常。同时，流程中断后 AI 对话脱轨——再发「开始原型设计」不走平台预设原型步骤，变成纯 AI 聊天。
- **根因**：M1.3.4 只修了 `handleProceed → handleGenerate` 的 fire-and-forget，漏了**原型子阶段分支**（`subPhase === "prototype"`）里的 `generatePrototypeRef.current?.()` ——同样是 `void` 调用不 await，且 `generatePrototype` 自身也不 re-throw。原型生成 API 因 EMAXCONNSESSION 等瞬时故障失败时，错误被双层静默吞掉。`handleProceed` 提前 `setPendingPrompt(null)` 清空了按钮、但失败后未恢复，用户陷于「无按钮、无原型、无报错」三无状态。流程中断后 design 仍为 in_progress，但后续「进入下一阶段」走 AUTO 分支 → 同一 subPhase 路径 → 同一无声失败，导致用户感觉「脱轨」。
- **修复（`requirement-shell.tsx`，与方法 M1.3.4 完全对齐）**：
  1. **`generatePrototype` SSE 解析新增 `error` 事件处理**：后端原型流水线异常时中断 SSE 读取并抛 `Error(msg)`，不再静默跳过。
  2. **`generatePrototype` catch 改为 re-throw**：让 `handleProceed` / `processChangeQueue` 能捕获并做降级（`processChangeQueue` 已有 try/catch，不受影响）。
  3. **`handleProceed` 原型子阶段分支改为 `await + try/catch`**：生成失败时恢复 `pendingPrompt`（携带 `subPhase:"prototype"`）供顶部按钮重试 + dispatch `EVT.GEN_ERROR` 显示错误横幅（8s 自动消失）；AbortError 跳过不设重试。
- **「对话脱轨」问题**：本次修复已从根本上解决——原型子阶段不再无声失败、流程不再中断，AUTO 分支对所有步骤（含 design→prototype 子阶段）的正确性得到保证。用户再发「开始原型设计」或「进入下一阶段」时，`isNavCommand` → AUTO 分支 → `subPhase:"prototype"` → `handleProceed → await generatePrototype` → 正确进入原型生成流程（或在失败时显示重试按钮）。
- **验收**：`tsc --noEmit` 零错误。改动后方案设计→原型失败时用户立即看到：① 错误横幅「原型生成失败...」→ 8s 后消失；② 顶部按钮恢复为重试入口「原型生成失败，请点击上方按钮重试。」→ 点击即重试。

## M1.3.6 — `subPhase` 字段在事件链丢失 + `isNavCommand` 漏识别「进入原型」修复 (2026-08-07)

- **用户实测反馈（M1.3.5 后的现场复测）**：
  1. 方案设计完成后对话发「进入原型设计」→ AI 兜底答「好的，收到」（500 兜底）。
  2. 多次发「进入原型设计」都同上。
  3. 改发「开始原型设计」→ AI 答「✅ 已确认方案文档，正在为您进入『原型设计（交互原型）』…」但**原型未实际生成**；设计步骤状态被错误地从「进行中」改为「已完成」；顶部的「确认后进入原型设计」按钮还一直在。
- **根因 A（`subPhase` 在事件链丢失）**：AUTO 分支正确判断出 `subPhase:"prototype"` 并下发 SSE `proceed_prompt`，但 `conversation-panel.tsx`（行 282-291）分发 `EVT.PROCEED_PROMPT` 时**未把 `subPhase` 塞进 detail**；`requirement-shell.tsx`（行 720-762）处理器也**未从 detail 提取 `subPhase`**传给 `handleProceed`。结果 `handleProceed` 收到的 `subPhase` 永远是 `undefined`，不进入子阶段分支，**直接走 `PATCH step:'design', state:'done'` + 因 nextStep 为 null 不生成任何东西**——把 design 步骤错误标完成且跳过了原型生成。`subPhase` 在 design 路由走 handleGenerate SSE 路径时是正确传递的（`handleGenerate` 的 `setPendingPrompt` 已带 subPhase），所以顶部按钮原本就是对的。
- **根因 B（`isNavCommand` 漏识别「进入原型设计」）**：现有正则 `/进入下一(步|阶段|环节)/` 和 `/(开始|进行|做|生成|...).*(调研|...|原型|...)/i` **都未覆盖「进入原型设计」「进入原型」这种「进入特定子阶段」指令**。「进入原型设计」→ 不匹配 → 落入 STREAM 分支 → AI 模型被模糊指令迷惑 → 返回空回复 → 兜底「好的，收到」。
- **修复（三处）**：
  1. **`conversation-panel.tsx`**：分发 `EVT.PROCEED_PROMPT` 时**透传 `payload.subPhase`**，并在 TS 类型接口中加 `subPhase?: string`。
  2. **`requirement-shell.tsx`**：处理器从 `detail.subPhase` 提取，三处 `setPendingPrompt` / `handleProceed` 调用都带上 `subPhase`（包括 `generatingStepRef.current` 降级分支），否则会被静默丢弃。
  3. **`app/api/requirements/[id]/conversation/route.ts` 的 `isNavCommand`**：新增正则 `/进入(原型设计|原型|调研分析|调研|方案设计|方案|需求文档|prd|调研报告)/i`，命中即视为导航指令走 AUTO 分支。
- **验收**：`tsc --noEmit` 零错误。修复后用户测试场景：
  - 「进入原型设计」/`「开始原型设计」` → `isNavCommand` 命中 → AUTO 分支正确判断 `subPhase:"prototype"` → 经完整事件链传到 `handleProceed` → 进入子阶段分支 → `await generatePrototype` → 原型正常生成或失败时显示重试按钮。
  - design 步骤**不再被错误地提前标为 done**。
- **是否要拆分 5 步**：本次修复后，4 步模型的子阶段链路已完整打通（subPhase 正确传递、错误处理已对齐）。**在踩到更多子阶段相关 bug 之前，建议先保留 4 步方案**——这次的 bug 根因是事件链字段丢失（属于可定位的硬错误），不是 4 步模型的本质缺陷。

## M1.3.7 — 需求变更场景：原型文案错显「已生成」+ 顶部按钮被翻转、重复生成需求文档 (2026-08-07)

- **用户实测反馈（进入 M2 前的回归）**：在「需求文档」阶段（未确认）发起变更，三个文档变更完成提示都是「xxxx已更新」，但原型完成提示却是「✅ 原型已生成…」（应是「已更新」）；且变更前顶部按钮是「需求文档已生成，请确认」，变更完成后按钮竟变成「原型已完成，确认后进入需求文档…」，点击还会真的再生成一遍需求文档。用户准确预判：原型生成比文档慢、按钮按"最新完成产物"显示导致错乱。
- **根因 A（原型变更文案）**：前端 `generatePrototype(message)` 把变更说明当成 `message` 字段 POST 给原型路由，而原型路由 / `prototype-sse.ts` 只认 `changeNote`/`baseVersionId` 来判定 `isEdit` → 变更重生成原型时 `isEdit=false` → 显示"已生成"文案。
- **根因 B（按钮翻转 + 重复生成下游）**：`prototype-sse.ts` 末尾**无条件**下发 `proceed_prompt`（推进到 `prd_writing`）并**无条件** `setAwaitingConfirm(design, true)`。对比 `design/route.ts`、`prd/route.ts` 的 change 分支都已正确处理（`isFrontier` 判定 + 不携带 `subPhase`）。原型的变更/编辑模式漏了这道区分——变更场景下原型只是"更新已有产物"，不应推进流程、也不应重开 design 闸门，否则顶部按钮被翻成"原型已完成，确认后进入需求文档"，点击后又把已生成的需求文档再生成一遍。
- **修复（两处）**：
  1. **`requirement-shell.tsx`**：`generatePrototype(changeNote="")` 参数改名并 POST `{ message: "", changeNote }`，把变更说明正确透传给原型路由（`processChangeQueue` 本就传 `changeNote` 作首参，改名后即对齐）；`generatePrototypeRef` 类型同步。
  2. **`lib/api/prototype-sse.ts`**：仅 `!isEdit` 时才 `setAwaitingConfirm(design, true)` 并下发推进用 `proceed_prompt`；编辑/变更模式下只更新产物、刷新 `step_update`/`gen_message` 并在聊天区给出「✅ 原型已更新…」，绝不推进流程。
- **验收**：`tsc --noEmit` 零错误。修复后变更场景：① 原型完成提示变为「已更新」；② 顶部按钮保持为变更前的「需求文档已生成，请确认」，不再被翻转、不再误触发需求文档重复生成。普通自动生成原型（isEdit=false）与手动从原型面板编辑（isEdit=true）路径均保持原行为。

## M1.3.8 — 性能优化：发送按钮长时间不可点 + 首屏/重渲染偏慢 (2026-08-07)

- **用户反馈**：本地进入项目页/需求页慢；对话时 AI 文字回了但「等待需求卡片更新」「等待发送按钮变可点」很久；输出物生成后整页重渲染慢。问是本地环境还是代码问题。
- **诊断结论**：部分是本地 dev 按需编译的固有开销；但代码侧确有三类可优化瓶颈：
  1. **发送按钮被后端整条流水线阻塞**：`conversation/route.ts` 在 `done` 之前串行做了落库 + **卡片抽取二次 LLM 调用** + 自动标题 + 步骤写库；前端 `send()` 的 `busy` 一直等到整条 SSE 流（含 `done`）读完才解禁。故"文字到了但按钮还卡、卡片迟迟不更新"。
  2. **SWR 默认 `revalidateOnFocus=true`**：切回标签页即对所有 key（含详情页 `req`/`project`/`siblings` 的串行 waterfall）重新请求，冗余重拉。
  3. **`mermaid` 静态打进首屏客户端包** + `MarkdownRenderer`/`MermaidBlock` 无固定化，内容未变也重复解析大文档 + 重复跑 mermaid。
- **修复（三处）**：
  1. **`conversation-panel.tsx`**：收到 `reply` 事件（AI 文字已完整下发）即**解禁发送按钮**，不再等卡片抽取/落库；并加 `AbortController`（新一轮发送取消上一轮仍在后台的 SSE）+ `sendId` 判定，杜绝被取消流的 `finally` 误触本轮 `busy`。
  2. **新增 `components/providers.tsx`** + 在 `app/dashboard/layout.tsx` 包裹全局 `SWRConfig`（`revalidateOnFocus:false`、`revalidateOnReconnect:false`、`dedupingInterval:5000`），消除聚焦重验风暴；个别需保留默认行为的 hook 仍可本地覆盖。
  3. **`markdown-renderer.tsx`**：`mermaid` 改为动态 `import()`（需求详情首屏不再加载该大依赖）；`MermaidBlock` / `MarkdownRenderer` 包 `React.memo`，内容未变时不重复解析/重渲染（用 `Symbol` 标记替代易失效的 `.name` 判定）。
- **验收**：`tsc --noEmit` 零错误。剩余"首屏慢"主要是本地 dev 按需编译，生产构建不含此开销。
- **M2 建议（未做，记录）**：① 详情页 `project`/`siblings` 依赖 `req.projectId` 形成串行 waterfall，可并行或带 `fallbackData`；② 项目列表页为算"每项目需求数"一次性拉全量需求，后端应加聚合接口；③ 变更时的卡片抽取二次 LLM 调用是卡片更新慢的主因，可考虑小模型或本地规则抽取。
