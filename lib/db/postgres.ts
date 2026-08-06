// postgres 后端：CloudBase PostgreSQL（经 postgres.js 驱动，标准 DATABASE_URL 连接）。
//
// 【为什么不用 CloudBase SDK】
// @cloudbase/node-sdk 只提供 NoSQL 文档接口，不提供 SQL 通道。PG 实例对外暴露的是
// 标准 PostgreSQL 协议，因此这里用 postgres.js + DATABASE_URL，与 CLOUDBASE_SECRET
// 是两套互不相关的凭据。
//
// 【本文件的核心职责：吸收 NoSQL 与 PG 的语义落差】
// NoSQL 是 schema-less、弱类型、静默容错的；PG 是强 schema、强类型、硬报错的。
// 业务层（AD-1）对此一无所知，所有落差必须在这一层消化干净：
//   1. 字段名   —— 代码键 ⇄ 列名，未知键【抛错】而不是静默丢弃（field-map.ts）
//   2. 时间类型 —— TIMESTAMPTZ 读出是 Date，代码全链路当字符串用 → 统一转 ISO
//   3. 大整数   —— int8 读出是 string（postgres.js 防精度丢失），代码当 number 用 → 转 Number
//   4. JSONB    —— JS 数组会被驱动误判为 PG array → 统一 JSON.stringify 后交给 PG 推断
//   5. 空值     —— NoSQL 的「缺字段/空串/null」在 PG 侧统一按「无值」处理
//
// 【AD-1】本文件是 postgres.js 唯一允许出现的地方（lib/db/** 之外禁止 import）。

import postgres from "postgres";
import {
  ALLOWED_ID_KEYS,
  BIGINT_COLS,
  FIELD_MAP,
  JSONB_COLS,
  ORDER_HINT,
  REVERSE_MAP,
  TABLES,
  TIMESTAMP_COLS,
} from "./field-map";
import {
  type DbBackend,
  type FindManyOptions,
  type OrderBy,
  type Row,
  type SearchVectorOptions,
  type SqlWhere,
} from "./backend";

// ---------------------------------------------------------------------------
// 连接管理
// ---------------------------------------------------------------------------

type Sql = ReturnType<typeof postgres>;

// postgres.js 的模板片段（可嵌套进另一个模板）。其内部类型未公开导出，
// 这里用 any 承接 —— 片段只在本文件内部流转，不会外泄到业务层。
type Frag = any;

const g = globalThis as Record<string, unknown>;

/**
 * 连接挂 globalThis：Next.js dev 每次热更新都会重新求值模块顶层，
 * 不复用就会在几十次改动后耗尽 PG 的连接数（表现为 "too many clients already"）。
 */
function pg(): Sql {
  const existing = g.__askbuddy_pg as Sql | undefined;
  if (existing) return existing;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL 未配置：DB_BACKEND=postgres 需要 CloudBase PostgreSQL 的标准连接串，" +
        "形如 postgresql://user:password@host:5432/dbname?sslmode=require（" +
        "它与 CLOUDBASE_SECRET 是两套独立凭据，后者不能用于 SQL 连接）。"
    );
  }

  const sql = postgres(url, {
    max: Number(process.env.DB_POOL_MAX ?? 5),
    idle_timeout: 20,
    connect_timeout: 10,
    // 托管 PG 常在前面挂 PgBouncer（transaction 模式），该模式不支持 prepared statement。
    // 默认关掉最安全；确认是直连实例后可设 DB_PG_PREPARE=true 换取一点性能。
    prepare: process.env.DB_PG_PREPARE === "true",
    // 代码里存在大量可选字段（note / output_version / completed_at…），
    // 不做这个转换的话 postgres.js 会对 undefined 直接抛错。
    transform: { undefined: null },
    onnotice: () => {},
    debug:
      process.env.DB_LOG_SQL === "true"
        ? (_conn: unknown, query: string, params: unknown[]) => {
            console.log("[db:sql]", query, params);
          }
        : undefined,
  });

  g.__askbuddy_pg = sql;
  return sql;
}

/** 供脚本与测试收尾调用；业务代码不需要（连接随进程生命周期复用）。 */
export async function closePg(): Promise<void> {
  const existing = g.__askbuddy_pg as Sql | undefined;
  if (existing) {
    await existing.end({ timeout: 5 });
    delete g.__askbuddy_pg;
  }
}

// ---------------------------------------------------------------------------
// 表名 / 字段名 / 值的翻译
// ---------------------------------------------------------------------------

function assertTable(table: string): void {
  if (!TABLES.has(table)) {
    throw new Error(
      `未知数据表 "${table}"。PG 没有 NoSQL 的「写入即建集合」魔法，` +
        `新表必须先在 db/schema.sql、db/drizzle/schema.ts 与 lib/db/field-map.ts 三处登记。`
    );
  }
}

/** 代码键 → 列名。未知键抛错，把字段契约漂移拦在开发期。 */
function toColumn(table: string, key: string): string {
  const col = FIELD_MAP[table]?.[key];
  if (!col) {
    throw new Error(
      `字段契约漂移：表 "${table}" 没有登记代码键 "${key}"。` +
        `若这是新字段，请同步更新 lib/db/field-map.ts、db/schema.sql 与 db/drizzle/schema.ts；` +
        `若这是笔误，请修正调用方（NoSQL 会静默接受这类写入，PG 不会）。`
    );
  }
  return col;
}

function isJsonbCol(table: string, col: string): boolean {
  return (JSONB_COLS[table] ?? []).includes(col);
}

/**
 * 业务对象（代码键）→ 数据库列对象（列名）。
 * JSONB 列在此序列化：postgres.js 会把 JS 数组当成 PG array 处理，
 * 而 tags / features / upstream_ids 这些都是 JS 数组，不转换就会写坏。
 */
function toColumns(table: string, row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const col = toColumn(table, key);
    if (value === undefined) {
      // 未提供的字段直接【省略】，交给 PG 应用列默认值（如 created_at 的 now()）。
      // 早期版本这里把 undefined 转成 NULL 再下发，会覆盖 NOT NULL 列的默认值、
      // 触发 "null value violates not-null constraint"。PG 的 DEFAULT 只在「列不出现于
      // INSERT/SET 列表」时生效，显式写 NULL 会让默认值失效。
      // 若某列是 NOT NULL 且无默认，这里省略后 PG 仍会报错 —— 但那是更清晰的「缺字段」
      // 错误，而非「静默写入 NULL 后行为诡异」。
      continue;
    }
    if (isJsonbCol(table, col)) {
      out[col] = value === null ? null : JSON.stringify(value);
    } else {
      out[col] = value;
    }
  }
  return out;
}

/** 数据库行（列名）→ 业务对象（代码键），并做时间/大整数的类型还原。 */
function toRow<T = Row>(table: string, dbRow: Row | undefined): T | undefined {
  if (!dbRow) return undefined;
  const reverse = REVERSE_MAP[table] ?? {};
  const tsCols = TIMESTAMP_COLS[table] ?? [];
  const bigCols = BIGINT_COLS[table] ?? [];
  const out: Row = {};

  for (const [col, raw] of Object.entries(dbRow)) {
    // 未登记的列保留原名而不是丢弃：SELECT * 若带出映射外的列，
    // 丢弃会造成静默数据缺失，保留至少能被上层发现。
    const key = reverse[col] ?? col;
    let value: unknown = raw;

    if (raw !== null && raw !== undefined) {
      if (tsCols.includes(col)) {
        // 代码全链路把时间当字符串用，含 `a.created_at < b.created_at` 的字典序比较。
        // 若这里漏转，字典序比较会退化成 "[object Date]" 之间的比较（恒 false），
        // 排序静默错乱且不抛任何错 —— 是这次迁移最难排查的一类回归。
        value = raw instanceof Date ? raw.toISOString() : String(raw);
      } else if (bigCols.includes(col)) {
        // postgres.js 默认把 int8 返回为字符串以防精度丢失，
        // 但代码把它们当数字用（conversations 的 `a.id - b.id` 排序会变成 NaN）。
        value = typeof raw === "number" ? raw : Number(raw);
      }
    }

    out[key] = value;
  }

  return out as T;
}

function toRows<T = Row>(table: string, dbRows: readonly Row[]): T[] {
  return dbRows.map((r) => toRow<T>(table, r) as T);
}

// ---------------------------------------------------------------------------
// 声明式条件 → SQL
// ---------------------------------------------------------------------------

/**
 * SqlWhere → SQL 片段（字段间 AND）。返回 undefined 表示无条件。
 *
 * 【isNull / notNull 的口径】backend.ts 的 whereToPredicate 把 null / undefined /
 * 空串三者都视为「无值」（NoSQL 里缺字段就是 undefined，历史数据里也存在空串）。
 * 为了让 PG 与内存回落的对拍结果一致，这里生成 `col IS NULL OR col::text = ''`。
 * 用 ::text 而不是直接 `col = ''`：archived_at 这类 TIMESTAMPTZ 列与空串比较会
 * 直接抛类型错误，而强转文本对任何列类型都合法且永不产生空串。
 */
function buildWhere(sql: Sql, table: string, w?: SqlWhere): Frag | undefined {
  if (!w) return undefined;
  const entries = Object.entries(w);
  if (entries.length === 0) return undefined;

  const frags: Frag[] = entries.map(([key, cmp]) => {
    const c = sql(toColumn(table, key));

    if ("eq" in cmp) {
      return cmp.eq === null ? sql`${c} IS NULL` : sql`${c} = ${cmp.eq as never}`;
    }
    if ("ne" in cmp) {
      return cmp.ne === null ? sql`${c} IS NOT NULL` : sql`${c} IS DISTINCT FROM ${cmp.ne as never}`;
    }
    if ("in" in cmp) {
      // IN () 是语法错误；空集合恒为假。
      return cmp.in.length === 0 ? sql`false` : sql`${c} IN ${sql(cmp.in as never[])}`;
    }
    if ("notIn" in cmp) {
      return cmp.notIn.length === 0
        ? sql`true`
        : sql`(${c} IS NULL OR ${c} NOT IN ${sql(cmp.notIn as never[])})`;
    }
    if ("isNull" in cmp) return sql`(${c} IS NULL OR ${c}::text = '')`;
    if ("notNull" in cmp) return sql`(${c} IS NOT NULL AND ${c}::text <> '')`;
    if ("lt" in cmp) return sql`${c} < ${cmp.lt as never}`;
    if ("lte" in cmp) return sql`${c} <= ${cmp.lte as never}`;
    if ("gt" in cmp) return sql`${c} > ${cmp.gt as never}`;
    if ("gte" in cmp) return sql`${c} >= ${cmp.gte as never}`;
    if ("like" in cmp) return sql`${c} LIKE ${cmp.like}`;

    throw new Error(`不支持的查询算子：${JSON.stringify(cmp)}`);
  });

  return frags.reduce((acc, f) => sql`${acc} AND ${f}`);
}

/**
 * OrderBy → SQL 片段。显式写 NULLS LAST 与 applyOrderBy 对齐：
 * PG 的默认是 ASC→NULLS LAST、DESC→NULLS FIRST，不统一会让两条路径排序不同。
 */
function buildOrderBy(sql: Sql, table: string, orderBy?: OrderBy): Frag | undefined {
  if (!orderBy || orderBy.length === 0) return undefined;
  const frags = orderBy.map(([field, dir]) => {
    const c = sql(toColumn(table, field));
    return dir === "desc" ? sql`${c} DESC NULLS LAST` : sql`${c} ASC NULLS LAST`;
  });
  return frags.reduce((acc, f) => sql`${acc}, ${f}`);
}

function listLimit(): number {
  const raw = Number(process.env.DB_LIST_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? raw : 1000;
}

// ---------------------------------------------------------------------------
// 后端实现
// ---------------------------------------------------------------------------

export const postgresBackend: DbBackend = {
  // ---- P1：与 mock / nosql 语义等价 ----

  /**
   * where 是任意 JS 回调，无法安全翻译成 SQL，因此与 nosql 后端一样「拉回内存过滤」。
   * 这是刻意的：P1 阶段语义等价优先于性能，下推交给 P2 的 findMany 逐点人工完成。
   */
  async list<T = Row>(table: string, where?: (r: Row) => boolean): Promise<T[]> {
    assertTable(table);
    const sql = pg();
    const limit = listLimit();
    const hint = ORDER_HINT[table];

    // ORDER BY 是 P1 唯一超出「逐字节等价」的部分：NoSQL 本就无序返回，
    // 固定排序反而消除了三个后端之间的隐性不确定性。
    const dbRows: Row[] = hint
      ? await sql`SELECT * FROM ${sql(table)} ORDER BY ${sql(hint)} ASC NULLS LAST LIMIT ${limit}`
      : await sql`SELECT * FROM ${sql(table)} LIMIT ${limit}`;

    if (dbRows.length >= limit) {
      console.warn(
        `[db] list("${table}") 触顶 ${limit} 行，结果可能被截断。` +
          `该调用点应改用 db.findMany 把条件下推到 SQL（见 M1 T8）。`
      );
    }

    const rows = toRows<T>(table, dbRows);
    return where ? (rows as unknown as Row[]).filter(where) as T[] : rows;
  },

  async get<T = Row>(table: string, id: string, idKey = "id"): Promise<T | undefined> {
    assertTable(table);
    const allowed = ALLOWED_ID_KEYS[table] ?? [];
    if (!allowed.includes(idKey)) {
      throw new Error(
        `db.get("${table}", …, "${idKey}") 的 idKey 不在白名单 [${allowed.join(", ")}] 内。` +
          `白名单内的列都有 PK/UNIQUE 索引；放开它意味着引入一条无索引的全表扫描。`
      );
    }
    const sql = pg();
    const col = toColumn(table, idKey);
    const dbRows: Row[] =
      await sql`SELECT * FROM ${sql(table)} WHERE ${sql(col)} = ${id} LIMIT 1`;
    return toRow<T>(table, dbRows[0]);
  },

  async insert<T>(table: string, row: T): Promise<T> {
    assertTable(table);
    const sql = pg();
    const cols = toColumns(table, row as unknown as Row);
    if (Object.keys(cols).length === 0) {
      throw new Error(`db.insert("${table}") 收到空对象，无法插入。`);
    }
    await sql`INSERT INTO ${sql(table)} ${sql(cols)}`;
    // 与 mock / nosql 一致：原样回传入参，不回读数据库默认值。
    return row;
  },

  async update<T>(
    table: string,
    id: string | number,
    patch: Partial<T>,
    idKey = "id"
  ): Promise<T | undefined> {
    assertTable(table);
    const sql = pg();
    const col = toColumn(table, idKey);
    const cols = toColumns(table, patch as unknown as Row);

    // 空 patch 会生成 `SET  WHERE` 语法错。mock 后端遇到空 patch 会原样返回该行，
    // 这里保持同样的行为。
    if (Object.keys(cols).length === 0) {
      const rows: Row[] =
        await sql`SELECT * FROM ${sql(table)} WHERE ${sql(col)} = ${id} LIMIT 1`;
      return toRow<T>(table, rows[0]);
    }

    const dbRows: Row[] =
      await sql`UPDATE ${sql(table)} SET ${sql(cols)} WHERE ${sql(col)} = ${id} RETURNING *`;
    return toRow<T>(table, dbRows[0]);
  },

  async remove(table: string, id: string, idKey = "id"): Promise<void> {
    assertTable(table);
    const sql = pg();
    const col = toColumn(table, idKey);
    await sql`DELETE FROM ${sql(table)} WHERE ${sql(col)} = ${id}`;
  },

  async updateWhere<T = Row>(
    table: string,
    where: Record<string, unknown>,
    patch: Partial<T>
  ): Promise<void> {
    assertTable(table);
    const whereCols = toColumns(table, where);
    if (Object.keys(whereCols).length === 0) {
      throw new Error(
        `db.updateWhere("${table}") 的 where 为空，将更新整表。这几乎总是 bug，已拒绝执行。`
      );
    }
    const patchCols = toColumns(table, patch as unknown as Row);
    if (Object.keys(patchCols).length === 0) return;

    const sql = pg();
    const conds: Frag[] = Object.entries(whereCols).map(([col, v]) =>
      v === null ? sql`${sql(col)} IS NULL` : sql`${sql(col)} = ${v as never}`
    );
    const whereFrag = conds.reduce((acc, f) => sql`${acc} AND ${f}`);
    await sql`UPDATE ${sql(table)} SET ${sql(patchCols)} WHERE ${whereFrag}`;
  },

  async removeBy(table: string, field: string, value: unknown): Promise<void> {
    assertTable(table);
    const sql = pg();
    const col = toColumn(table, field);
    if (value === null || value === undefined) {
      await sql`DELETE FROM ${sql(table)} WHERE ${sql(col)} IS NULL`;
      return;
    }
    await sql`DELETE FROM ${sql(table)} WHERE ${sql(col)} = ${value as never}`;
  },

  // ---- P2：可下推的声明式查询 ----

  async findMany<T = Row>(table: string, opts: FindManyOptions): Promise<T[]> {
    assertTable(table);
    const sql = pg();
    const whereFrag = buildWhere(sql, table, opts.where);
    const orderFrag = buildOrderBy(sql, table, opts.orderBy);

    const dbRows: Row[] = await sql`
      SELECT * FROM ${sql(table)}
      ${whereFrag ? sql`WHERE ${whereFrag}` : sql``}
      ${orderFrag ? sql`ORDER BY ${orderFrag}` : sql``}
      ${opts.limit != null ? sql`LIMIT ${opts.limit}` : sql``}
      ${opts.offset != null ? sql`OFFSET ${opts.offset}` : sql``}
    `;
    return toRows<T>(table, dbRows);
  },

  async countMany(table: string, where?: SqlWhere): Promise<number> {
    assertTable(table);
    const sql = pg();
    const whereFrag = buildWhere(sql, table, where);
    const rows: Array<{ n: string }> = await sql`
      SELECT COUNT(*)::text AS n FROM ${sql(table)}
      ${whereFrag ? sql`WHERE ${whereFrag}` : sql``}
    `;
    return Number(rows[0]?.n ?? 0);
  },

  /**
   * 向量检索（真 pgvector）。col 须为 vector 类型，余弦距离用 `<=>` 下推到 SQL，
   * `score = 1 - 距离` 即余弦相似度。接口与 cloudbase 后端完全一致，业务零改动。
   */
  async searchVector<T = Row>(
    table: string,
    opts: SearchVectorOptions
  ): Promise<Array<T & { score: number }>> {
    assertTable(table);
    const sql = pg();
    const col = toColumn(table, opts.column);
    // 真 pgvector：vector 字面量经 sql.unsafe 注入（JSON.stringify(number[]) 仅含数字，安全），再 ::vector 强转。
    const q = sql.unsafe(JSON.stringify(opts.query));
    const whereFrag = buildWhere(sql, table, opts.where);
    const notNull = sql`${sql(col)} IS NOT NULL`;
    const finalWhere = whereFrag ? sql`${whereFrag} AND ${notNull}` : notNull;

    const dbRows: Row[] = await sql`
      SELECT *, (1 - (${sql(col)} <=> ${q}::vector)) AS score
      FROM ${sql(table)}
      WHERE ${finalWhere}
      ORDER BY ${sql(col)} <=> ${q}::vector ASC
      LIMIT ${opts.topK}
    `;

    const scored: Array<T & { score: number }> = [];
    for (const dbRow of dbRows) {
      const score = typeof dbRow.score === "number" ? dbRow.score : Number(dbRow.score);
      if (opts.minScore != null && score < opts.minScore) continue;
      scored.push({ ...(toRow<T>(table, dbRow) as T), score });
    }
    return scored;
  },
};

/** 供 scripts/ 与冒烟测试复用（业务层不得使用）。 */
export const __internals = { toRow, toColumns, toColumn, buildWhere, assertTable, pg };
