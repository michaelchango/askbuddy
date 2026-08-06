/**
 * T8 下推对拍测试（M1-T8.4 / AC-37）
 *
 * 【这个测试在防什么】
 * T8 把 18 个 `db.list(table, jsCallback)` 逐点人工翻译成了 `db.findMany(table, dsl)`。
 * 人工翻译最容易错在边界上：`!r.archived_at` 到底算不算空串？`Set.has` 换成 `in`
 * 之后空集合怎么办？这些错误不会让代码崩，只会让列表里静悄悄地少几行或多几行 ——
 * 是最难在联调中被发现的一类缺陷。
 *
 * 因此对每个下推点，这里同时保留【原回调】与【新 DSL】两份实现，喂同一批样本数据，
 * 断言两者结果集完全相同。原回调是从 git 历史里逐字抄回来的，不是重新写的等价物。
 *
 * 【三层断言】
 *   L1 纯函数层：whereToPredicate(dsl) 与原回调在样本上逐行同判。不碰 I/O，最快。
 *   L2 门面层  ：db.list(原回调) 与 db.findMany(新 DSL) 经 mock 后端返回同一行集合。
 *   L3 PG 层   ：同 L2，但跑在真实 PostgreSQL 上（需要 DATABASE_URL，默认跳过）。
 *
 * 运行：npm run test:parity
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadEnvConfig } from "@next/env";
import {
  whereToPredicate,
  applyOrderBy,
  type FindManyOptions,
  type Row,
} from "@/lib/db/backend";

// 在对拍测试里加载 .env.local（CLOUDBASE_ENV_ID / CLOUDBASE_SECRET 等），
// 必须在动态 import("@/lib/db") 之前执行，否则 cloudbase 后端在模块顶层读不到凭据。
loadEnvConfig(process.cwd());

// ---------------------------------------------------------------------------
// 下推点清单：每一条都是「原回调 ⇄ 新 DSL」的一对
// ---------------------------------------------------------------------------

interface Case {
  /** 对应 M1-T8.3 清单编号 */
  id: string;
  /** 调用点位置，出问题时照着这个去找代码 */
  site: string;
  table: string;
  /** 从 git 历史逐字抄回的原 db.list 回调 */
  legacy: (r: Row) => boolean;
  /** T8 替换后的声明式条件 */
  dsl: FindManyOptions;
}

// 固定的样本参数，与下面 FIXTURES 里的数据对应
const P1 = "proj-1";
const P2 = "proj-2";
const R1 = "req-1";
const R2 = "req-2";
const OWNER = "mock-user-001";
const OWNED_IDS = [P1, P2];
const OWNED_SET = new Set(OWNED_IDS);
const REQ_IDS = [R1, R2];
const REQ_ID_SET = new Set(REQ_IDS);

const CASES: Case[] = [
  {
    id: "A1",
    site: "lib/services/requirements.ts listRequirements",
    table: "requirements",
    legacy: (r) => r.projectId === P1 && !r.archived_at,
    dsl: {
      where: { projectId: { eq: P1 }, archived_at: { isNull: true } },
      orderBy: [["updatedAt", "desc"]],
    },
  },
  {
    id: "A2",
    site: "lib/services/requirements.ts listRequirementsForOwner",
    table: "requirements",
    // 原实现闭包捕获了一个 Set —— 这正是「无法翻译成 SQL」的典型形态
    legacy: (r) => OWNED_SET.has(r.projectId as string) && !r.archived_at,
    dsl: {
      where: { projectId: { in: OWNED_IDS }, archived_at: { isNull: true } },
      orderBy: [["updatedAt", "desc"]],
    },
  },
  {
    id: "A3",
    site: "lib/services/projects.ts listProjects",
    table: "projects",
    legacy: (r) => r.ownerId === OWNER && !r.deleted_at,
    dsl: {
      where: { ownerId: { eq: OWNER }, deleted_at: { isNull: true } },
      orderBy: [["createdAt", "asc"]],
    },
  },
  {
    id: "A4",
    site: "lib/stage.ts attachDerivedStatus",
    table: "requirement_steps",
    legacy: (r) => REQ_ID_SET.has(r.requirement_id as string),
    dsl: { where: { requirement_id: { in: REQ_IDS } } },
  },
  {
    id: "A5",
    site: "lib/services/conversations.ts listConversations",
    table: "conversations",
    legacy: (r) => r.requirement_id === R1,
    dsl: { where: { requirement_id: { eq: R1 } }, orderBy: [["id", "asc"]] },
  },
  {
    id: "A6",
    site: "lib/services/requirements.ts generateCard",
    table: "conversations",
    // 原实现是 list(按需求过滤) 之后再 .filter(role === "user")，
    // 两步合成一个 where 是等价的，因为中间结果没有被别处使用
    legacy: (r) => r.requirement_id === R1 && r.role === "user",
    dsl: {
      where: { requirement_id: { eq: R1 }, role: { eq: "user" } },
      orderBy: [["id", "asc"]],
    },
  },
  {
    id: "A7",
    site: "lib/services/steps.ts getSteps",
    table: "requirement_steps",
    legacy: (r) => r.requirement_id === R1,
    dsl: { where: { requirement_id: { eq: R1 } } },
  },
  {
    id: "A8",
    site: "lib/services/steps.ts setStepState（改用 countMany）",
    table: "requirement_steps",
    legacy: (r) => r.requirement_id === R1 && r.step === "dialoguing",
    dsl: {
      where: { requirement_id: { eq: R1 }, step: { eq: "dialoguing" } },
    },
  },
  {
    id: "B1",
    site: "lib/services/outputs.ts getOutput/card",
    table: "card_versions",
    legacy: (r) => r.requirement_id === R1,
    dsl: {
      where: { requirement_id: { eq: R1 } },
      orderBy: [["version", "asc"]],
    },
  },
  {
    id: "B2",
    site: "lib/services/outputs.ts getOutput/research_analysis",
    table: "research_analysis_versions",
    legacy: (r) => r.requirement_id === R1,
    dsl: {
      where: { requirement_id: { eq: R1 } },
      orderBy: [["version", "asc"]],
    },
  },
  {
    id: "B3",
    site: "lib/services/outputs.ts getOutput/design·solution",
    table: "solution_versions",
    legacy: (r) => r.requirement_id === R1,
    dsl: {
      where: { requirement_id: { eq: R1 } },
      orderBy: [["version", "asc"]],
    },
  },
  {
    id: "B4",
    site: "lib/services/outputs.ts getOutput/prd",
    table: "prd_versions",
    legacy: (r) => r.requirement_id === R1,
    dsl: {
      where: { requirement_id: { eq: R1 } },
      orderBy: [["version", "asc"]],
    },
  },
  {
    id: "B5",
    site: "lib/services/prototypes.ts listVersions",
    table: "prototype_versions",
    legacy: (r) => r.requirement_id === R1,
    dsl: {
      where: { requirement_id: { eq: R1 } },
      orderBy: [["version", "asc"]],
    },
  },
  {
    id: "B6",
    site: "lib/services/prototypes.ts getShareToken",
    table: "share_tokens",
    legacy: (r) => r.requirement_id === R1 && r.type === "prototype",
    dsl: {
      where: { requirement_id: { eq: R1 }, type: { eq: "prototype" } },
      orderBy: [["created_at", "desc"]],
      limit: 1,
    },
  },
  {
    id: "C1",
    site: "lib/services/tokens.ts listTokens",
    table: "api_tokens",
    legacy: (r) => r.user_id === OWNER && !r.revoked_at,
    dsl: {
      where: { user_id: { eq: OWNER }, revoked_at: { isNull: true } },
      orderBy: [["created_at", "asc"]],
    },
  },
  {
    id: "C2",
    site: "app/api/requirements/[id]/prd/restore/route.ts",
    table: "prd_versions",
    legacy: (r) => r.requirement_id === R1 && r.version === 2,
    dsl: {
      where: { requirement_id: { eq: R1 }, version: { eq: 2 } },
      limit: 1,
    },
  },
  {
    id: "C3",
    site: "lib/services/projects.ts getProjectStats",
    table: "requirements",
    legacy: (r) => r.projectId === P1 && !r.archived_at,
    dsl: {
      where: { projectId: { eq: P1 }, archived_at: { isNull: true } },
      orderBy: [["updatedAt", "desc"]],
    },
  },
];

// ---------------------------------------------------------------------------
// 样本数据：刻意塞满边界值
// ---------------------------------------------------------------------------
//
// 「空值」在这套代码里有四种写法，全都要覆盖：
//   archived_at 缺字段     —— NoSQL 里没写过就是不存在
//   archived_at: undefined —— 显式赋 undefined
//   archived_at: null      —— PG 读回来的形态
//   archived_at: ""        —— 历史上被空串覆盖过的脏数据
// 原回调用 `!r.archived_at` 判断，这四种都为真；isNull 算子必须与之一致。

const FIXTURES: Record<string, Row[]> = {
  projects: [
    { id: P1, ownerId: OWNER, name: "A", createdAt: "2026-01-01T00:00:00Z" },
    { id: P2, ownerId: OWNER, name: "B", createdAt: "2026-01-02T00:00:00Z", deleted_at: null },
    { id: "proj-3", ownerId: OWNER, name: "C", createdAt: "2026-01-03T00:00:00Z", deleted_at: "" },
    { id: "proj-4", ownerId: OWNER, name: "D", createdAt: "2026-01-04T00:00:00Z", deleted_at: undefined },
    // 已归档：唯一应当被排除的
    { id: "proj-5", ownerId: OWNER, name: "E", createdAt: "2026-01-05T00:00:00Z", deleted_at: "2026-02-01T00:00:00Z" },
    // 他人项目：不应出现在任何 owner 查询里
    { id: "proj-6", ownerId: "someone-else", name: "F", createdAt: "2026-01-06T00:00:00Z" },
  ],

  requirements: [
    { id: R1, projectId: P1, title: "需求一", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-03-05T00:00:00Z" },
    { id: R2, projectId: P1, title: "需求二", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z", archived_at: null },
    { id: "req-3", projectId: P1, title: "需求三", createdAt: "2026-01-03T00:00:00Z", updatedAt: "2026-03-09T00:00:00Z", archived_at: "" },
    { id: "req-4", projectId: P2, title: "需求四", createdAt: "2026-01-04T00:00:00Z", updatedAt: "2026-03-02T00:00:00Z" },
    // 已归档：应被排除
    { id: "req-5", projectId: P1, title: "需求五", createdAt: "2026-01-05T00:00:00Z", updatedAt: "2026-03-07T00:00:00Z", archived_at: "2026-03-08T00:00:00Z" },
    // 不属于该 owner 的项目
    { id: "req-6", projectId: "proj-6", title: "需求六", createdAt: "2026-01-06T00:00:00Z", updatedAt: "2026-03-03T00:00:00Z" },
  ],

  conversations: [
    // id 刻意乱序插入，用来验证 orderBy 真的生效而不是碰巧等于插入序
    { id: 300, requirement_id: R1, role: "assistant", content: "回答二" },
    { id: 100, requirement_id: R1, role: "user", content: "问题一" },
    { id: 200, requirement_id: R1, role: "assistant", content: "回答一" },
    { id: 400, requirement_id: R1, role: "user", content: "问题二" },
    { id: 500, requirement_id: R2, role: "user", content: "别的需求" },
  ],

  requirement_steps: [
    { id: `${R1}-dialoguing`, requirement_id: R1, step: "dialoguing", state: "done" },
    { id: `${R1}-research`, requirement_id: R1, step: "research", state: "in_progress" },
    { id: `${R2}-dialoguing`, requirement_id: R2, step: "dialoguing", state: "not_started" },
    { id: "req-9-dialoguing", requirement_id: "req-9", step: "dialoguing", state: "not_started" },
  ],

  card_versions: [
    { id: 2, requirement_id: R1, version: 2, card: {}, created_at: "2026-02-02T00:00:00Z" },
    { id: 1, requirement_id: R1, version: 1, card: {}, created_at: "2026-02-01T00:00:00Z" },
    { id: 3, requirement_id: R2, version: 1, card: {}, created_at: "2026-02-03T00:00:00Z" },
  ],

  research_analysis_versions: [
    { id: 2, requirement_id: R1, version: 2, report: "r2", created_at: "2026-02-02T00:00:00Z" },
    { id: 1, requirement_id: R1, version: 1, report: "r1", created_at: "2026-02-01T00:00:00Z" },
    { id: 3, requirement_id: R2, version: 1, report: "x", created_at: "2026-02-03T00:00:00Z" },
  ],

  solution_versions: [
    { id: 2, requirement_id: R1, version: 2, doc: "d2", created_at: "2026-02-02T00:00:00Z" },
    { id: 1, requirement_id: R1, version: 1, doc: "d1", created_at: "2026-02-01T00:00:00Z" },
    { id: 3, requirement_id: R2, version: 1, doc: "x", created_at: "2026-02-03T00:00:00Z" },
  ],

  prd_versions: [
    { id: 3, requirement_id: R1, version: 3, markdown: "m3", created_at: "2026-02-03T00:00:00Z" },
    { id: 1, requirement_id: R1, version: 1, markdown: "m1", created_at: "2026-02-01T00:00:00Z" },
    { id: 2, requirement_id: R1, version: 2, markdown: "m2", created_at: "2026-02-02T00:00:00Z" },
    { id: 4, requirement_id: R2, version: 1, markdown: "x", created_at: "2026-02-04T00:00:00Z" },
  ],

  prototype_versions: [
    { id: `${R1}-v2`, requirement_id: R1, version: 2, structure: null, html_storage_key: "k2" },
    { id: `${R1}-v1`, requirement_id: R1, version: 1, structure: null, html_storage_key: "k1" },
    { id: `${R2}-v1`, requirement_id: R2, version: 1, structure: null, html_storage_key: "k3" },
  ],

  share_tokens: [
    { id: "tok-old", requirement_id: R1, type: "prototype", created_at: "2026-02-01T00:00:00Z" },
    { id: "tok-new", requirement_id: R1, type: "prototype", created_at: "2026-02-09T00:00:00Z" },
    // 类型不同：不应被 getShareToken 取到
    { id: "tok-other", requirement_id: R1, type: "prd", created_at: "2026-02-10T00:00:00Z" },
    { id: "tok-r2", requirement_id: R2, type: "prototype", created_at: "2026-02-05T00:00:00Z" },
  ],

  api_tokens: [
    { id: "t1", user_id: OWNER, name: "n1", token_hash: "h1", created_at: "2026-01-01T00:00:00Z" },
    { id: "t2", user_id: OWNER, name: "n2", token_hash: "h2", created_at: "2026-01-02T00:00:00Z", revoked_at: null },
    { id: "t3", user_id: OWNER, name: "n3", token_hash: "h3", created_at: "2026-01-03T00:00:00Z", revoked_at: "" },
    // 已吊销：应被排除
    { id: "t4", user_id: OWNER, name: "n4", token_hash: "h4", created_at: "2026-01-04T00:00:00Z", revoked_at: "2026-01-09T00:00:00Z" },
    { id: "t5", user_id: "other", name: "n5", token_hash: "h5", created_at: "2026-01-05T00:00:00Z" },
  ],
};

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 按主键排序后比较，屏蔽「集合相同但顺序不同」的干扰（顺序另有专门断言）。 */
function byId(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function idsOf(rows: Row[]): string[] {
  return rows.map((r) => String(r.id));
}

// ---------------------------------------------------------------------------
// L1 纯函数层：DSL 翻译是否与原回调逐行同判
// ---------------------------------------------------------------------------

test("L1 · DSL 翻译与原 db.list 回调逐行同判", async (t) => {
  for (const c of CASES) {
    await t.test(`${c.id} ${c.site}`, () => {
      const rows = FIXTURES[c.table];
      assert.ok(rows, `缺少 ${c.table} 的样本数据`);

      const pred = whereToPredicate(c.dsl.where);
      assert.ok(pred, `${c.id} 的 where 翻译成了 undefined（会退化成全表扫描）`);

      for (const row of rows) {
        assert.equal(
          pred!(row),
          c.legacy(row),
          `${c.id} 在 ${c.table}#${String(row.id)} 上判定不一致：` +
            `原回调=${c.legacy(row)}，新 DSL=${pred!(row)}`
        );
      }

      // 至少要选中一行，否则这条用例等于没测
      assert.ok(
        rows.some((r) => c.legacy(r)),
        `${c.id} 的样本数据里没有任何一行命中，用例无效`
      );
      // 也至少要排除一行，否则 where 写成恒真也能过
      assert.ok(
        rows.some((r) => !c.legacy(r)),
        `${c.id} 的样本数据里没有任何一行被排除，用例无区分度`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// L2 门面层：经 mock 后端，db.list 与 db.findMany 返回同一行集合
// ---------------------------------------------------------------------------

test("L2 · 经 mock 后端，list 与 findMany 行集合一致", async (t) => {
  process.env.USE_MOCK = "true";
  const { db } = await import("@/lib/db");
  const { __resetMemory } = await import("@/lib/db/mock");

  __resetMemory();
  for (const [table, rows] of Object.entries(FIXTURES)) {
    for (const row of rows) await db.insert(table, row);
  }

  for (const c of CASES) {
    await t.test(`${c.id} ${c.site}`, async () => {
      const legacyRows = await db.list<Row>(c.table, c.legacy);
      // limit 会真的截断结果，比较行集合时必须去掉，否则比的是两件事
      const { limit: _limit, ...noLimit } = c.dsl;
      const dslRows = await db.findMany<Row>(c.table, noLimit);

      assert.deepEqual(
        idsOf(byId(dslRows)),
        idsOf(byId(legacyRows)),
        `${c.id} 行集合不一致`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 排序：orderBy 必须真的改变顺序，而不是碰巧等于插入序
// ---------------------------------------------------------------------------

test("L2 · orderBy 语义（含 limit 截断）", async (t) => {
  process.env.USE_MOCK = "true";
  const { db } = await import("@/lib/db");

  await t.test("A5 对话按 id 升序（样本是乱序插入的）", async () => {
    const rows = await db.findMany<Row>("conversations", {
      where: { requirement_id: { eq: R1 } },
      orderBy: [["id", "asc"]],
    });
    assert.deepEqual(rows.map((r) => r.id), [100, 200, 300, 400]);
  });

  await t.test("B4 PRD 版本按 version 升序 —— 取最新版依赖这个顺序", async () => {
    const rows = await db.findMany<Row>("prd_versions", {
      where: { requirement_id: { eq: R1 } },
      orderBy: [["version", "asc"]],
    });
    assert.deepEqual(rows.map((r) => r.version), [1, 2, 3]);
    // 业务代码就是这么取「当前版本」的，顺序错了会静默取到旧版
    assert.equal(rows[rows.length - 1].version, 3);
  });

  await t.test("B6 分享 token 取 created_at 最新的一条", async () => {
    const rows = await db.findMany<Row>("share_tokens", {
      where: { requirement_id: { eq: R1 }, type: { eq: "prototype" } },
      orderBy: [["created_at", "desc"]],
      limit: 1,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "tok-new");
  });

  await t.test("A1 需求按 updatedAt 降序", async () => {
    const rows = await db.findMany<Row>("requirements", {
      where: { projectId: { eq: P1 }, archived_at: { isNull: true } },
      orderBy: [["updatedAt", "desc"]],
    });
    assert.deepEqual(rows.map((r) => r.id), ["req-3", R1, R2]);
  });

  await t.test("offset + limit 分页", async () => {
    const all = await db.findMany<Row>("prd_versions", {
      where: { requirement_id: { eq: R1 } },
      orderBy: [["version", "asc"]],
    });
    const page = await db.findMany<Row>("prd_versions", {
      where: { requirement_id: { eq: R1 } },
      orderBy: [["version", "asc"]],
      offset: 1,
      limit: 1,
    });
    assert.deepEqual(page, [all[1]]);
  });
});

// ---------------------------------------------------------------------------
// countMany：A8 从「拉整行判断长度」换成计数
// ---------------------------------------------------------------------------

test("L2 · countMany 与 list().length 一致", async (t) => {
  process.env.USE_MOCK = "true";
  const { db } = await import("@/lib/db");

  for (const c of CASES) {
    await t.test(`${c.id} ${c.table}`, async () => {
      const legacyCount = (await db.list<Row>(c.table, c.legacy)).length;
      const n = await db.countMany(c.table, c.dsl.where);
      assert.equal(n, legacyCount, `${c.id} 计数不一致`);
    });
  }
});

// ---------------------------------------------------------------------------
// 空值口径：四种「没有值」的写法必须被一视同仁
// ---------------------------------------------------------------------------

test("isNull / notNull 覆盖四种空值写法", async () => {
  const pred = whereToPredicate({ archived_at: { isNull: true } })!;
  assert.equal(pred({ id: "a" }), true, "缺字段");
  assert.equal(pred({ id: "b", archived_at: undefined }), true, "undefined");
  assert.equal(pred({ id: "c", archived_at: null }), true, "null");
  assert.equal(pred({ id: "d", archived_at: "" }), true, "空串");
  assert.equal(pred({ id: "e", archived_at: "2026-01-01T00:00:00Z" }), false, "有值");

  const notPred = whereToPredicate({ archived_at: { notNull: true } })!;
  for (const r of [{}, { archived_at: undefined }, { archived_at: null }, { archived_at: "" }]) {
    assert.equal(notPred(r as Row), false);
  }
  assert.equal(notPred({ archived_at: "2026-01-01T00:00:00Z" }), true);
});

test("已知边界：isNull 与 !value 在 0 / false 上不同，但时间列取不到这两个值", () => {
  // 原回调写的是 `!r.archived_at`，JS 的假值里还包含 0 与 false；
  // isNull 只认 null / undefined / ""。这个差异是【故意保留】的：
  //   - 归档时间、删除时间、吊销时间在 PG 里都是 TIMESTAMPTZ，取值只可能是 NULL 或时间戳；
  //   - 若把 0 也算作空，反而会让「数字 0 的列」在未来被误判。
  // 把差异钉在测试里，是为了让日后有人把 isNull 用到数值列上时，能在这里看到警告。
  const pred = whereToPredicate({ archived_at: { isNull: true } })!;
  assert.equal(pred({ archived_at: 0 }), false, "isNull 不把 0 当空");
  assert.equal(!({ archived_at: 0 } as Row).archived_at, true, "而 !value 把 0 当空");
});

test("in 空集合恒假、notIn 空集合恒真", () => {
  const inEmpty = whereToPredicate({ projectId: { in: [] } })!;
  assert.equal(inEmpty({ projectId: P1 }), false);
  const notInEmpty = whereToPredicate({ projectId: { notIn: [] } })!;
  assert.equal(notInEmpty({ projectId: P1 }), true);
});

test("applyOrderBy 的 NULL 排最后，与 PG 的 NULLS LAST 默认一致", () => {
  const rows: Row[] = [
    { id: "a", v: 2 },
    { id: "b", v: null },
    { id: "c", v: 1 },
    { id: "d" },
  ];
  assert.deepEqual(idsOf(applyOrderBy(rows, [["v", "asc"]])), ["c", "a", "b", "d"]);
  assert.deepEqual(idsOf(applyOrderBy(rows, [["v", "desc"]])), ["a", "c", "b", "d"]);
});

// ---------------------------------------------------------------------------
// L3 PG 层：同样的对拍跑在真实 PostgreSQL 上
// ---------------------------------------------------------------------------
//
// 默认跳过。开启方式：先建好库（npm run db:migrate），再
//   DB_PARITY_PG=true npm run test:parity
// 之所以要额外一个开关而不是只看 DATABASE_URL：这套用例会真的往库里写样本行，
// 不能因为某人本地配了连接串就顺手把他的开发库搅乱。

const PG_ENABLED =
  process.env.DB_PARITY_PG === "true" &&
  (!!process.env.DATABASE_URL || process.env.DB_BACKEND === "cloudbase");

test(
  "L3 · 经真实 PostgreSQL 后端（postgres / cloudbase），list 与 findMany 行集合一致",
  {
    skip: PG_ENABLED
      ? false
      : "未设置 DB_PARITY_PG=true，且既无 DATABASE_URL 也无 DB_BACKEND=cloudbase，跳过",
  },
  async (t) => {
    delete process.env.USE_MOCK;
    // 有 DATABASE_URL 走直连 postgres；否则走 cloudbase 网关 SQL 接口（不依赖 DATABASE_URL）。
    const backendName = process.env.DATABASE_URL ? "postgres" : "cloudbase";
    process.env.DB_BACKEND = backendName;
    const { __resetBackend, db } = await import("@/lib/db");
    __resetBackend();

    // 按外键顺序建样本，结束后逆序清理
    const ORDER = [
      "projects",
      "requirements",
      "conversations",
      "requirement_steps",
      "card_versions",
      "research_analysis_versions",
      "solution_versions",
      "prd_versions",
      "prototype_versions",
      "share_tokens",
      "api_tokens",
    ];

    try {
      for (const table of ORDER) {
        for (const row of FIXTURES[table] ?? []) await db.insert(table, row);
      }

      for (const c of CASES) {
        await t.test(`${c.id} ${c.site}`, async () => {
          const legacyRows = await db.list<Row>(c.table, c.legacy);
          const { limit: _limit, ...noLimit } = c.dsl;
          const dslRows = await db.findMany<Row>(c.table, noLimit);
          assert.deepEqual(
            idsOf(byId(dslRows)),
            idsOf(byId(legacyRows)),
            `${c.id} 在 PG 上行集合不一致`
          );
        });
      }
    } finally {
      for (const table of [...ORDER].reverse()) {
        for (const row of FIXTURES[table] ?? []) {
          await db.remove(table, String(row.id)).catch(() => {});
        }
      }
      if (backendName === "postgres") {
        const { closePg } = await import("@/lib/db/postgres");
        await closePg();
      }
    }
  }
);
