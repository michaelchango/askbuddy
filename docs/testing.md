# 测试手册（M5-D4）

> 本文是操作手册，不是进度日志。「新增一个 trigger / section / 卡片字段要改哪些文件」
> 这类问题，照本文第 4 节逐条做即可，不需要再读一遍实现。

## 1. 分层与命令

| 层 | 目录 | 命令 | 特点 |
|---|---|---|---|
| 契约测试 | `tests/contract/**` | 随 `npm test` 一起跑 | **纯结构断言**，毫秒级，专拦「加了东西忘了同步」 |
| 单元测试 | `tests/unit/**` | 随 `npm test` 一起跑 | mock 掉 db / AI，零外部依赖 |
| 真库冒烟 | `scripts/smoke-*.ts` | `npx tsx scripts/smoke-xxx.ts`（需先 `npm run dev`） | **打真库 / 真 HTTP / 真 AI**，不在 CI 跑 |
| e2e | `tests/e2e/**` | 未建（见第 7 节） | Playwright，计划延后 |

```bash
npm test                      # 全量单测 + 契约测试（vitest run）
npm run test:watch            # 监听模式
npm run test:cov              # 带覆盖率与阈值卡口
npm run verify                # typecheck + test + lint（提交前必跑）
npm run test:parity           # db 下推对拍（独立的 tsx --test 体系）
```

**真库冒烟脚本清单**（都要先起 dev server，且都可重复执行）：

| 脚本 | 验证什么 |
|---|---|
| `scripts/smoke-lifecycle-api.ts` | 生命周期 API：400/409 语义区分、force 越闸、审计逐行、归档/解档、级联清理 |
| `scripts/smoke-devcontext-stale.ts` | stale 标记的 **JSONB 写入路径**、并集累积、定向清除、现场恢复 |
| `scripts/smoke-devcontext-refresh.ts` | 定向重算端到端：**A1「未受影响段逐字节不变」** + 结构化 changelog |
| `scripts/smoke-ai-provider.ts` | 真实 CloudBase 链路（provider 编排改造后的回归） |
| `scripts/poc/embedding-probe.ts` | R3 红线：embedding 维度 == 1024 |

> 这些脚本存在的理由：**mock 单测永远抓不到「字段契约漂移 / JSONB 反序列化 / 真实 API 契约」
> 这一类问题**。M5 期间它们抓到了 5 个真实缺陷（`updated_at` 键名、JSONB 白名单漏列、
> BIGINT 误登记、混元参数契约、400/409 颠倒），全部是单测绿着的情况下存在的。

## 2. 覆盖率策略

只对**纯函数**模块立卡口（`vitest.config.ts` 的 `coverage.thresholds`）：

| 文件 | lines | 理由 |
|---|---|---|
| `lib/requirement-lifecycle.ts` | ≥95% | 零依赖状态机，没有借口 |
| `lib/services/devcontext-impact.ts` | ≥95% | 零依赖影响映射，漏一处就是漏重算 |

**全局 60% 阈值刻意不启用**：当前全局 lines ≈ 36%，未覆盖的大头是
`lib/ai/steps`、`lib/ai/context`、`lib/services` —— 它们是 IO / 编排层，
需要的是 e2e 而不是更多 mock 单测。给它们设阈值只会逼出「为了覆盖率而 mock 一堆 IO」
的假测试，那比没有覆盖率更糟。

## 3. 确定性纪律（mock 三铁律）

`lib/ai/mock/**` 与 `lib/ai/providers/mock.ts` 内：

1. **禁用** `Math.random()` / `Date.now()` / `new Date()` / `crypto.randomUUID()`；
   需要「随机」时用 `lib/ai/mock/hash.ts` 的 FNV-1a；
2. 同一 `(taskType, messages)` 输入 → **逐字节相同**的输出；
3. 时间戳一律用 `MOCK_TIMESTAMP`（固定值）。

三条都由 `tests/unit/ai-provider.spec.ts` 守护（含**源码静态扫描**，扫描前先剥注释，
所以注释里写「禁用 Math.random()」不会被误判）。任何一处随机都会造成 flaky test，
而 flaky 的 CI 等于没有 CI。

场景注入：`AI_MOCK_SCENARIO=xxx` 环境变量，或用户消息里的 `[[scenario:xxx]]` 标记。
已支持：`change-request` / `no-change` / `over-window`（变更分析）、
`schema-invalid` / `low-completeness`（DevContext）、`card-multiple`（卡片合并）。

## 4. 操作手册：改了这些，必须同批改那些

> 这一节是本文的核心。每条都对应一个**会静默出错**的失败模式。

### 4.1 新增一个 `ImpactTrigger`

1. `lib/services/devcontext-impact.ts`
   - 加进 `ImpactTrigger` union；
   - 加进 `ALL_TRIGGERS`；
   - 在 `DIRECT_IMPACT` 加一行（**只写直接命中**，派生影响交给 `SECTION_CLOSURE`；空集也要显式写 `[]` 并注理由）。
2. 跑 `npm test` → `tests/contract/impact-map.spec.ts` 的「Trigger 全覆盖」会立刻校验键集合恒等。
3. 在 `tests/unit/devcontext-impact.spec.ts` 补一组金样本（含期望的 section 集合与顺序）。
4. 若该 trigger 由新上游产生：在 `lib/services/change-analyzer.ts` 的 `outputsToTriggers` 里补映射（+ 单测）。
5. 若由卡片字段产生：确保字段在 `lib/services/card.ts` 的 `CARD_FIELDS` 里 —— 契约测试会反射校验
   「每个 CARD_FIELDS 字段都有 `card.<field>` trigger」。

**漏了会怎样**：漏重算 → AI Coding Agent 拿到一份过期的机器规格，静默写出错代码。

### 4.2 新增一个 DevContext `section`

1. `lib/schemas/devcontext.ts`：加进 `SECTION_KEYS`（顺序即「规范顺序」的中间段）、
   `SECTION_APPLICABILITY`、`SECTION_LABELS`，并写 Zod schema。
2. `lib/services/devcontext-impact.ts`：复查整张 `DIRECT_IMPACT`（哪些 trigger 会影响它），
   必要时补 `SECTION_CLOSURE`。
3. `lib/ai/prompts/devcontext.ts`：在 system prompt 的 section 清单里加一行（否则模型永远不生成它）。
4. `lib/ai/mock/fixtures/dev-context.ts`：在基础夹具里加该段 —— **否则定向重算该段时
   mock 会返回空，e2e 无法区分「重算了」与「没重算」**。
5. `tests/contract/impact-map.spec.ts` 的「反向覆盖」用例：若它是核心段，加进 `CORE` 列表。
6. 跑 `npm test`：`devcontext-schema.spec.ts` 与 `impact-map.spec.ts` 会校验键集合一致性。

### 4.3 新增一个卡片字段

1. `lib/services/card.ts` 的 `CARD_FIELDS`（**唯一声明处**）。
2. `lib/services/devcontext-impact.ts`：加 `card.<field>` trigger（见 4.1）。
3. `lib/ai/prompts/card-merge.ts`：更新「卡片包含且仅包含以下 N 个字段」的说明与示例。
4. 跑 `npm test`：契约测试会因「数量不一致」报红，直到 1+2 都补齐。

### 4.4 新增一个生命周期状态 / 迁移

1. `lib/requirement-lifecycle.ts`：`RequirementLifecycle` union、`LIFECYCLE_KEYS`、`LIFECYCLE_LABELS`、`LIFECYCLE_TRANSITIONS`。
2. `lib/services/requirement-status.ts`：`isLifecycle` 白名单、必要时 `MANUAL_STATES`（人工态永不自动进入）。
3. `app/api/requirements/[id]/lifecycle/route.ts`：POST 的目标态白名单。
4. `components/requirements/lifecycle-controls.tsx`：`BADGE_STYLES` + `ACTION_LABELS`。
5. 跑 `npm test`：`requirement-lifecycle.spec.ts` 的「迁移矩阵全枚举」会因邻接表键集合不一致报红。

### 4.5 新增一类交付闸门（`checkGate`）

1. `lib/services/requirement-status.ts` 的 `checkGate` 返回新 `code`；
2. **决定 severity**：`block` 会真拦、`warn` 只提示（可 force 越过）；
3. `tests/unit/requirement-status.spec.ts` 补一条用例（含 severity 断言）；
4. 若 `block`：确认 UI 的 tooltip 能显示 `message`（`lifecycle-controls.tsx` 已统一处理）。

## 5. 写测试时的两条硬规矩

1. **mock 掉 IO 边界**（`@/lib/db`、`@/lib/ai/client`），不要为了让测试跑起来去连真库。
   参考 `tests/unit/requirement-status.spec.ts` 的 `vi.hoisted` + `vi.mock` 写法。
2. **字段契约护栏**：往 db 写数据时，键名必须是 `lib/db/field-map.ts` 登记的代码键。
   `requirements` / `projects` 是 **camelCase 漂移表**（`updatedAt` 而不是 `updated_at`）。
   写错键会被后端抛「字段契约漂移」，而同步钩子会吞掉这个异常 → 表现为「静默不生效」。
   `tests/unit/requirement-status.spec.ts` 有一条断言可照抄。

## 6. MCP `_meta.maybe_stale`

`requirement_dev_context` 与 4 个 `dev_context_*` 分段工具的返回体统一带 `_meta`：

```jsonc
{
  "content": { /* … */ },
  "_meta": {
    "version": 7,
    "status": "confirmed",
    "completeness_score": 0.82,
    "maybe_stale": true,
    "stale_sections": ["business_rules", "acceptance_criteria"],
    "warning": "⚠️ 以下段落的上游产物已变更但尚未重算，据此编码前请先与产品确认：business_rules（业务规则）、acceptance_criteria（验收标准）。可用 POST /api/requirements/{id}/dev-context/refresh 触发定向重算。"
  }
}
```

几个刻意的决定：
- `maybe_stale` 同时看列值与 `stale_sections`（出现过「列被清、清单还在」的中间态，只看一列会漏报）；
- `warning` 用**自然语言**而非布尔字段：消费方是 AI Coding Agent，它对散文警告的遵从度
  显著高于对一个 `true` 的解读；
- warning 里带**可执行的下一步**（refresh 端点），否则 Agent 只能干瞪眼。

## 7. 尚未建成：Playwright e2e（D5）

计划中的 5 组场景（`tests/e2e/01..05`）与 seed 通道（`app/api/test/seed/route.ts`）
**尚未实现**，原因与前置条件：

- Playwright 及其浏览器**尚未安装**（会引入新依赖 + 下载浏览器）；
- 计划书 §6「裁剪选项」明确把 `P4-4~P4-6（e2e/CI）` 列为**可延后到上线后**的项；
- **A1 这条最硬的验收标准目前由真库冒烟覆盖**（`smoke-devcontext-refresh.ts` 的
  「未受影响段逐字节不变」），不是空白。

落地时的三个坑（已从计划书里确认，避免重踩）：
1. seed 必须走 **HTTP**：mock db 是 dev server 进程的内存表，Playwright 进程访问不到；
2. 必须 `workers: 1`：所有 worker 共享同一份内存表，并行会互相污染；
3. seed 端点必须**双重守卫**（`USE_MOCK==='true'` 且非 production），否则就是一个
   能往数据库随便写的未鉴权端点。
