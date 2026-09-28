# M5 可执行开发计划（状态机 / 变更联动 / 测试基建）

> 依据：`开发计划/M5_状态机与变更联动与测试基建.md`（v1.0，2026-08-05）
> 校准基线：**master @ b107dc5**（2026-09-28，已合入 try-mode + M4 + cloudbase-deploy，已去 Vercel）
> 本文件 = 原 M5 计划的「可执行版」：任务条目不重复原文论证，只给**落地动作 + 与现状的差异校准 + 验证命令**。
> 执行原则沿用原文档：与源码事实冲突时，**以真实代码为准**，并在本文对应条目追记。

---

## 0. 与原 M5 文档的差异校准（开工前必读）

原文档写于 M2–M4 落地之前，以下事实已变化，任务条目已按此适配：

| # | 原文档假设 | 当前实况（已核对源码） | 对执行的影响 |
|---|---|---|---|
| C1 | `requirements.status` 半退化双写源，需「彻底解决状态双源」 | M1 重建时**已删除 status 列**（阶段标签纯派生，归档用 `archived_at`） | ✅ 双源风险天然消除。`lifecycle` 直接新列即可，无历史包袱；`attachDerivedStatus` 透传 lifecycle 时读列而非派生 |
| C2 | 测试基建**完全没有**（无 test script） | 已有 `tsx --test` 体系：5 个 spec、**40 用例全绿**（devcontext schema/validate/render、context builder、knowledge-trace） | D4 改为「**引入 Vitest 并迁移存量 5 文件**」，不是从 0 搭 |
| C3 | DDL 落 `db/migrations/0005_*.sql` | 本项目建表事实源是 **`db/schema.sql` + 幂等 `db-setup-cloudbase.ts`**（网关 B 通道）；drizzle 迁移仅 0000 一个基线 | DDL 写进 `db/schema.sql`（用 `ADD COLUMN IF NOT EXISTS` 等幂等形态）+ 同步 `db/drizzle/schema.ts`；**不要**新建独立迁移文件 |
| C4 | 布尔语义列用 BOOLEAN | 本库纪律：**布尔语义列用 SMALLINT**（`maybe_stale`、`awaiting_confirm` 均如此） | `markDevContextStale` 写 `maybe_stale=1/0`；新增列沿用 SMALLINT/JSONB 口径 |
| C5 | `suggestions.target_path` 是 `decision.accepted` trigger 的定位依据 | **`targetPath` 全仓零引用**（M3 建议卡已回退，产物直写库） | `decision.accepted` trigger **保留枚举位但无生产者**（直映空集，见原文档 (b) 表）；`checkGate` 的 `PENDING_SUGGESTION` 保留——有数据才生效，无数据不阻塞 |
| C6 | AI 任务 8 个、mock fixture 9 份 | 任务已是 **10 个**（新增 `knowledge_extract`、`prototype_edit`） | fixture 清单相应 +2；`AI_TASK_MODEL` 路由表语义不变 |
| C7 | 布局/路由代码行号（L96-138 等） | 行号已漂移 | 一律按**函数名/注释锚点**定位，不信行号 |
| C8 | `dev_contexts` 有 `version` 列 | 实列名为 **`current_version`** | `regenerateSections` 写 `current_version+1` |
| C9 | 部署在 Vercel | 已合入 CloudBase 云托管配置、已去 Vercel（`b107dc5`）；`next build` 已实测通过 | e2e 的 `webServer` 直接 `next dev`；CI 无 Vercel 环节 |

---

## 1. 范围（与原文档一致，5 项交付物）

- **D1 需求状态机**：六态生命周期 `created→dialoguing→designing→review→completed→archived`，与阶段级 `requirement_steps.state` / `awaiting_confirm` 分层共存，唯一写入口 + 审计表
- **D2 变更联动到 DevContext**：确定性影响映射表（非 LLM）+ 传递闭包 + 定向 section 重算 + `maybe_stale`/`stale_sections` 血缘标记 + UI 过期提示 + MCP `_meta.warning`
- **D3 多 provider AI 抽象层**：`cloudbase` / `openai-compatible` / `mock` 三实现 + 指数退避重试 + 确定性 Mock 引擎；`callAI`/`streamAI` 对外签名冻结
- **D4 Vitest 单测基建**：迁移存量 40 用例 + 新增 harness/impact/contract/provider 用例 + 覆盖率阈值
- **D5 Playwright e2e**：seed 通道 + 5 组场景 + CI 编排

**明确不做**（沿用原文档）：不动原型机制、不做 `ai_tasks`、不接真 Auth（但 `actor` 参数预留）、不做 LLM 版影响分析、不改 SSE 既有事件（只增字段）。

---

## 2. 执行分期与验证闸门

> 分支策略：从 master 拉 `feat/m5-lifecycle-cascade`，每个 Phase 结束跑一次全量验证；Phase 2 结束是一个可提前合入的稳定点（见 §6 裁剪选项）。

### Phase 0 · 准备（约 0.5 天）

| # | 动作 | 文件 | 验证 |
|---|---|---|---|
| P0-1 | 引入 Vitest：`vitest` / `@vitest/coverage-v8` devDeps；`vitest.config.ts`（alias `@`→根；node/jsdom 两 project；coverage 排除 `lib/db/**`、`lib/cloudbase/**`）；`tests/setup/unit.ts`（`USE_MOCK=true`、`AI_MOCK=true`、`AI_MOCK_DELAY_MS=0`、`beforeEach` 清 `globalThis.__askbuddy_memory`） | `vitest.config.ts`、`tests/setup/unit.ts`、`package.json` | `npx vitest run` 能跑通空目录 |
| P0-2 | **迁移存量 5 个 spec** 到 Vitest（`node:test` 的 `test()` → `it()`，`node:assert/strict` → 保留亦可经 `expect` 包装；其余机械改） | `lib/schemas/devcontext.test.ts` 等 5 文件 → `tests/unit/**` | `npm test` 换成 `vitest run`，**40 用例全绿**后方可继续 |
| P0-3 | `package.json` scripts：`test`→`vitest run`、`test:watch`、`test:cov`、`verify`=`tsc --noEmit && vitest run && next lint` | `package.json` | `npm run verify` 全绿 |

> ⚠️ P0-2 迁移期间**禁止**顺手改任何业务代码——迁移提交必须「纯搬家、零行为变化」（diff 审查时核对）。

### Phase 1 · 需求状态机（D1，约 2 天）

| # | 任务 | 文件 | 要点（差异已适配） |
|---|---|---|---|
| P1-1 | 生命周期纯函数模块 | `lib/requirement-lifecycle.ts` **新建** | 六态 + 邻接表（`completed→designing` 放开且必带 reason）+ `canTransition/assertTransition/availableTransitions/isEditable/isTerminal` + `deriveLifecycle`（只产出自动态；判定顺序：archivedAt → 全 not_started 且无对话 → dialoguing 未 done → designing）。**零依赖**（不 import db/services），客户端可导入 |
| P1-2 | 生命周期服务（唯一写入口） | `lib/services/requirement-status.ts` **新建** | `getLifecycle / transitionLifecycle / syncLifecycleFromSteps / checkGate`。写 `requirements.lifecycle` + 审计表；人工态不被隐式同步覆盖；变更打回走显式 `transitionLifecycle(source:'change_cascade')`；`checkGate` 闸门表按原文档（STEP_NOT_DONE / STALE_STEP / AWAITING_CONFIRM / PENDING_SUGGESTION / DEVCONTEXT_STALE / DEVCONTEXT_DRAFT(warn)）。注意布尔读法：`awaiting_confirm`/`maybe_stale` 是 **SMALLINT（0/1）** |
| P1-3 | 步骤服务挂同步钩子 | `lib/services/steps.ts` 改造 | 仅在 `setStepState`（L105）与 `setAwaitingConfirm`（L225）函数体**末尾**追加动态 `import("./requirement-status")` 的 `syncLifecycleFromSteps`，try/catch 静默；`isFrontierStep`/`initSteps`/`completeStepAndAdvance` 一律不动 |
| P1-4 | 数据模型 | `db/schema.sql`、`db/drizzle/schema.ts` | ① `requirements` 加 `lifecycle TEXT NOT NULL DEFAULT 'created'`、`lifecycle_updated_at TIMESTAMPTZ`、索引 `(project_id, lifecycle)`——**用 `ADD COLUMN IF NOT EXISTS`**（db-setup 幂等）② 新表 `requirement_status_history`（id/requirement_id/from_state/to_state/actor/reason/source/created_at + 索引）③ `dev_contexts` 加 `stale_sections JSONB NOT NULL DEFAULT '[]'`、`stale_reason JSONB`（`maybe_stale` 已存在，SMALLINT，不重复加）。三处同步：schema.sql / drizzle / `lib/db/field-map.ts`（TABLES 无需动——requirements 已登记；但 FIELD_MAP 要补 `lifecycle`、`lifecycle_updated_at`、`archived_at` 如缺）|
| P1-5 | 回填脚本 | `scripts/backfill-lifecycle.ts` 新建 | 对存量需求跑 `deriveLifecycle` 写入（`source='derived'`）；幂等可重跑 |
| P1-6 | 生命周期 API | `app/api/requirements/[id]/lifecycle/route.ts` 新建 | GET（当前态+available+各路 blockers 一次拿全）/ POST（checkGate→block 409→assertTransition 400→transition；`to='archived'` 同写 `archived_at`；`to='restore'` 从审计表倒查归档前态） |
| P1-7 | 阶段派生层适配 | `lib/stage.ts` 改造 | `deriveRequirementStatus` 逻辑不动；`attachDerivedStatus`（L30）同一遍扫描里透传 `lifecycle`（**读列**，不派生）；模块头补分工注释 |
| P1-8 | UI | `components/requirements/lifecycle-badge.tsx`、`lifecycle-actions.tsx` 新建；`components/layout/requirement-shell.tsx`、需求列表页改造 | 6 态徽标；按钮被 blockers 挡住时**置灰+tooltip**（不隐藏）；生命周期变更派发既有 `askbuddy:steps-updated` 事件，不新增事件类型；列表筛选默认排除 archived |

**Phase 1 闸门**：`npm run verify` 全绿 + 新增 `requirement-lifecycle.spec.ts`（36 组迁移矩阵全枚举、`deriveLifecycle` 判定顺序与「永不产出人工态」、`checkGate` 逐条、同步不覆盖人工态）+ 手动冒烟：走一遍四步流程确认零回归（B5）。

### Phase 2 · 变更联动到 DevContext（D2，约 3 天）

| # | 任务 | 文件 | 要点 |
|---|---|---|---|
| P2-1 | 影响映射表（技术核心，纯函数） | `lib/services/devcontext-impact.ts` 新建 | `ImpactTrigger` 15 项封闭枚举 + `DIRECT_IMPACT`（`prd.markdown` **必须空集**，AD-2）+ `SECTION_CLOSURE`（镜像三层一致性规则）+ `ALWAYS_RECOMPUTE=['meta','references']` + `resolveAffectedSections`（直接命中→decision 特例→闭包不动点→fail-safe 全量→按 schema 顺序输出）。section 键集合从 **`lib/schemas/devcontext.ts` 的 SECTION_KEYS** 导入，禁止硬编码 |
| P2-2 | 卡片变更返回字段级 diff | `lib/services/card.ts` 改造 | `applyCardChange` 返回 `{ok, changedFields}`（在 CARD_FIELDS 白名单合并循环 L58 逐字段比对）；唯一调用点 conversation 路由 L232 适配 |
| P2-3 | change-analyzer 扩展 | `lib/services/change-analyzer.ts` 改造 | `ChangeAnalysis` 加可选 `triggers`；新增纯函数 `outputsToTriggers`（research→3、design→solution.doc+prototype.structure、prd→prd.markdown、card→[]）；**prompt 与候选窗口过滤一字不改** |
| P2-4 | 定向重算服务 | `lib/services/devcontext.ts`（或新建 `dev-context-regenerate.ts`） | `markDevContextStale`（只标记：`maybe_stale=1` + `stale_sections` + `stale_reason`，不调 LLM）/ `regenerateSections`（上游子集组装→只输出指定 section→逐 section 合并（未列 section 逐字节保留含 `_source`）→meta/references 纯代码重算→三层 Validator→失败升级一次否则降 draft→`current_version+1`+快照+结构化 changelog→clearStale）/ `clearStale` |
| P2-5 | 定向重算 API | `app/api/requirements/[id]/dev-context/refresh/route.ts` 新建 | POST `{sections?, mode?}`，SSE 复用既有事件（`gen_message`/`change_update`/`done`/`error`），进程内 Map 并发锁 409 |
| P2-6 | 变更编排接入 | `app/api/requirements/[id]/conversation/route.ts` 改造 | 在 **P3-1（L222-232，applyCardChange 之后）与 P3-2（L242，markStepPendingUpdate 之前）之间**插 P3-1.5：`triggers = changedFields→card.* + outputsToTriggers(affectedOutputs)` → `resolveAffectedSections` → `markDevContextStale`；`change_update` payload **只增** `devContext` 字段；P3-2 后追加生命周期打回（completed/review → designing，`source:'change_cascade'`） |
| P2-7 | UI section 级过期 | `components/requirements/dev-context-panel.tsx` 改造、`dev-context-stale-bar.tsx` 新建 | 「可能已过期（N 处）」徽标；stale section 橙点 + tooltip（`stale_reason` 翻译成中文）；「重算这 N 段 / 全部重算 / 标记为无需更新」三出口；完成后 changelog 摘要 |
| P2-8 | MCP 感知 stale | `mcp/server.ts`、`docs/mcp-guide.md` | `requirement_dev_context` 与 4 个 section 工具返回体加 `_meta`（version/status/completeness_score/maybe_stale/stale_sections/warning 自然语言） |

**Phase 2 闸门**：`npm run verify` + 契约测试（P3-1 的 impact-map.spec 6 条全绿）+ 10 组金样本回归表全对 + 手动冒烟「改卡片 constraints 字段 → 只有 business_rules 链路段被标过期」。

### Phase 3 · Provider 抽象（D3，约 1.5 天）

| # | 任务 | 文件 | 要点 |
|---|---|---|---|
| P3-1 | Provider 接口 | `lib/ai/provider.ts` 新建 | `ProviderId`（cloudbase/openai-compatible/mock）+ `AIProvider`（isConfigured/generate/stream）+ `resolveProvider` 四级选择（AI_MOCK/USE_MOCK → AI_PROVIDER → cloudbase → mock 兜底）；`GenerateOptions.signal` 预留 |
| P3-2 | CloudBase provider | `lib/ai/providers/cloudbase.ts` 新建 | **原样迁入** `client.ts` 的 `streamToText/realGenerate/realStream`（保留「流式聚合防 `<think>` 混入」注释）；`DEGRADE` 降级表**留在** client.ts 编排层 |
| P3-3 | 确定性 Mock provider | `lib/ai/providers/mock.ts`、`lib/ai/mock/fixtures/*.ts` | **确定性三铁律**（禁 Math.random/Date.now/randomUUID，同输入逐字节同输出，固定时间戳）；fixture 按任务拆分（现有 mockDialogueText/mockResearchAnalysis 迁入；**任务清单按当前 models.ts 实际 10 任务**，另加 change-analysis/card-merge/title）；`AI_MOCK_SCENARIO` 场景注入；DevContext fixture 支持 `generateDevContextSections(sections, base)`（内容随 changeNote 哈希变化，否则 e2e 无判别力） |
| P3-4 | OpenAI 兼容 provider | `lib/ai/providers/openai-compatible.ts` 新建 | 原生 fetch `/v1/chat/completions`，读 `AI_OPENAI_BASE_URL/KEY`，支持 SSE stream |
| P3-5 | 重试与错误分类 | `lib/ai/retry.ts` 新建 | `withRetry`（3 次 / 800ms 基数指数退避 / jitter 可关）；`classifyAIError`（timeout 504 / 429 / 4xx 400 / 其他 502） |
| P3-6 | client.ts 编排化（签名冻结） | `lib/ai/client.ts` 改造 | `callAI/streamAI` 签名与返回**一字不改**；内部 `resolveProvider→withRetry→DEGRADE 换模型→classifyAIError`；删内联 mock；新增结构化单行日志 `{event:'ai_call',...}` |

**Phase 3 闸门**：`ai-provider.spec.ts`（选择顺序、mock 确定性 100 次、fixture 源码静态扫描无随机源、retry 行为、callAI/streamAI 签名回归、降级路径）+ 手动冒烟真实 CloudBase 链路一轮（R-M5-5）。

### Phase 4 · 测试基建收尾 + e2e + CI（D4/D5，约 2.5 天）

| # | 任务 | 文件 | 要点 |
|---|---|---|---|
| P4-1 | 契约测试（**最高优先级**） | `tests/contract/impact-map.spec.ts` | 6 条：Trigger 全覆盖（keys 深等于 ALL_TRIGGERS）、section 名对 SECTION_KEYS 合法、核心 section 反向覆盖、**PRD 隔离**（AD-2）、闭包无环收敛、卡片 6 字段从 `CARD_FIELDS` **反射导入**全覆盖 |
| P4-2 | 影响解析金样本 | `tests/unit/devcontext-impact.spec.ts` | 10 组 GOLDEN（含「仅 PRD 变更 → 只有 meta/references」★）；结果有序去重可深等；未知 trigger → FULL_RECOMPUTE |
| P4-3 | 其余单测 | `tests/unit/{change-analyzer,steps-harness,devcontext-validator,devcontext-renderer,ai-provider}.spec.ts` | 按原文档 M5-4.2/4.4/4.5/4.6 用例表 |
| P4-4 | e2e 基建 | `playwright.config.ts`、`app/api/test/seed/route.ts`、`tests/e2e/fixtures/*` | seed 端点**双重守卫**（`USE_MOCK==='true'` 且非 production，否则 404）；预设 empty/card-ready/full-flow/review-blocked；`workers:1`、仅 chromium、`AI_MOCK_DELAY_MS=0`、端口 3100 |
| P4-5 | e2e 5 场景 | `tests/e2e/01..05` | 01 全流程（含生命周期徽标流转）；**02 变更定向重算（核心验收 A1：v1/v2 逐 section 深比较，未受影响段含 `_source` 逐字节不变）**；03 导出五格式；04 生命周期闸门；05 MCP 冒烟（tools/list=13、solution 非空、prototype 默认无 HTML、search_knowledge、stale `_meta.warning`） |
| P4-6 | CI | `.github/workflows/ci.yml` | 串行：install→typecheck→lint→test:contract→test→build→e2e；CI 全 mock（不配任何真实凭据）；失败传 artifacts |
| P4-7 | 文档 | `docs/testing.md` 新建、`docs/mcp-guide.md`、`待办事项.md` | 「新增 trigger/section 必须同步改哪些文件」操作手册；`_meta.maybe_stale` 说明 |

**Phase 4 闸门 = M5 整体验收**：A1（定向重算逐字节断言）+ A2（CI 全绿无 skip/only）+ B1–B6 + C1–C8 + D1–D7（原验收表全文有效）。

---

## 3. 关键 DDL（P1-4，幂等，写入 `db/schema.sql`）

```sql
-- requirements：生命周期（独立列；本表无 status 列，阶段标签纯派生，无双源问题）
ALTER TABLE requirements
  ADD COLUMN IF NOT EXISTS lifecycle TEXT NOT NULL DEFAULT 'created',
  ADD COLUMN IF NOT EXISTS lifecycle_updated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_requirements_lifecycle ON requirements (project_id, lifecycle);

-- 状态迁移审计（只增不改不删）
CREATE TABLE IF NOT EXISTS requirement_status_history (
  id             TEXT        NOT NULL PRIMARY KEY,
  requirement_id TEXT        NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  from_state     TEXT,
  to_state       TEXT        NOT NULL,
  actor          TEXT        NOT NULL,
  reason         TEXT,
  source         TEXT        NOT NULL CHECK (source IN ('manual','derived','change_cascade')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_req_status_history_rid
  ON requirement_status_history (requirement_id, created_at DESC);

-- dev_contexts：section 级失效标记（maybe_stale SMALLINT 已存在，复用）
ALTER TABLE dev_contexts
  ADD COLUMN IF NOT EXISTS stale_sections JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS stale_reason   JSONB;
```

同步 `db/drizzle/schema.ts`（requirements 两列 + 两张新表 + dev_contexts 两列），`lib/db/field-map.ts` 的 FIELD_MAP 补 `requirements.lifecycle / lifecycle_updated_at`，`lib/db/postgres.ts` 若有布尔/JSONB 白名单相应补。

---

## 4. 风险（在原文档 8 条基础上追加 2 条现状风险）

- **R-M5-9（新）存量测试迁移引入回归**：P0-2 搬家时改了断言 → 迁移提交必须「纯搬家零行为变化」，diff 逐一核对；迁移后 40 用例数量与断言条数必须与迁移前一致。
- **R-M5-10（新）网关对 `ALTER TABLE ... IF NOT EXISTS` 的兼容性**：先在测试环境手工执行一遍 DDL 确认网关 `exec-pgsql` 接受该语法；若不支持，改为 db-setup-cloudbase 的 try/catch 幂等模式（错误分类「duplicate column」跳过）。
- 原 R-M5-1～R-M5-8 全文有效，其中 **R-M5-1（映射表漏重算）仍是头号风险**，五层缓解照做。

---

## 5. 依赖与开工检查单

- [x] M0 命名统一（`__askbuddy_memory` / `askbuddy:*` 事件 / `ASKBUDDY_*` 双读）
- [x] M1 PG + 网关建表体系（db-setup-cloudbase 幂等）
- [x] M2 DevContext（SECTION_KEYS / 三层 Validator / 渲染器 / 13 工具 MCP）
- [x] M3 suggestions/decisions 表（注意：**建议卡已回退**，`target_path` 无生产者 → C5 校准）
- [x] M4 knowledge_entries + TokenHub embedding（实测 1024 维）
- [x] master 已合流三分支并去 Vercel（b107dc5），`next build` 通过

## 6. 裁剪选项（若想先封板上线再补 M5）

按价值密度排序的最小可用子集（约 3 天）：
1. **P1-1/P1-2/P1-4/P1-6**（状态机 + API，不含 UI 精修）——看板/筛选/交付闸门立刻可用；
2. **P2-1/P2-2/P2-3/P2-6**（映射表 + 编排接入）——stale 标记生效（UI 可先用 DevContext 面板现有字段展示）；
3. **P3 全组**——provider 抽象 + mock 确定性，为后续所有测试铺路；
4. **P4-1 契约测试**——映射表护栏先立起来。

可延后到上线后：P1-8 UI 精修、P2-7 stale 面板、P4-4~P4-6（e2e/CI）、覆盖率阈值。
代价：A1 验收暂时靠人工回归；上线后补齐时 e2e 场景 02 是第一优先。

---

*执行时如与真实代码冲突，以代码为准并回写本文对应条目（沿用原 M5 文档的修订纪律）。*
