// cloudbase 后端：CloudBase PostgreSQL，经 B 通道 /v1/rdb/exec-pgsql 执行 SQL。
//
// 【为什么不用 DATABASE_URL / pg.Pool】
// 用户决策（M1 收尾）：不依赖 CloudBase PostgreSQL 的 PG 协议连接串（DATABASE_URL），
// 全部走 CloudBase 公网网关的 SQL 执行接口。凭据复用 CLOUDBASE_SECRET（API Key），
// 以 Role=cloudbase_postgres（可写管理员角色）调用。该角色凭据已具备，无需腾讯云密钥。
//
// 【与 postgres.ts 的语义对齐】
// 业务层（AD-1）对三个 PG 系后端一视同仁。本文件吸收同样的 NoSQL⇄PG 落差：
//   字段名（field-map）、时间（TIMESTAMPTZ→字符串）、大整数（int8→number）、
//   JSONB（网关已解析为原生对象）、空值（缺字段/空串/ null 统一为「无值」）。
//
// 【SQL 构造】exec-pgsql 网关不支持参数化（占位符 $1 报 500 DATABASE_EXEC_ERROR），
// 故采用「安全字面量序列化」：标识符（表/列）一律来自 field-map 白名单或 TABLES 集合，
// 无外部输入；值统一经 lit() 转义（字符串转义 ' 与 \，数字/布尔/JSON 按类型生成），
// 对注入等效于预处理语句。JSONB 列追加 ::jsonb 强转，向量列追加 ::vector。

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
// 网关配置
// ---------------------------------------------------------------------------

const ENV_ID = process.env.CLOUDBASE_ENV_ID;
const API_KEY = process.env.CLOUDBASE_SECRET;
const BASE = ENV_ID ? `https://${ENV_ID}.api.tcloudbasegateway.com` : "";
// 可写管理员角色。exec-pgsql 默认是只读角色（DATABASE_25006 read-only transaction），
// DDL/写入必须显式指定 cloudbase_postgres。允许角色仅有 cloudbase_postgres 与
// cloudbase_read_only_user，传 service_role 会被拒。
const ROLE = "cloudbase_postgres";

function assertConfig(): void {
  if (!ENV_ID || !API_KEY || !BASE) {
    throw new Error(
      "CloudBase 未配置：cloudbase 后端需要 CLOUDBASE_ENV_ID 与 CLOUDBASE_SECRET" +
        "（走网关 SQL 执行接口，不依赖 DATABASE_URL）。"
    );
  }
}

// ---------------------------------------------------------------------------
// 执行：exec-pgsql
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 并发栅栏：CloudBase 网关 SQL 通道是「session 模式」，单会话连接池上限 pool_size=10。
// 浏览器打开需求页会瞬间并发发起多个接口（RSC 页面渲染 + 多个 SWR 拉取 + 对话流读），
// 每个接口又各自扇出多条 SELECT（如 listOutputs 一次 Promise.all 4 条 db.get），
// 极易突破 10 连接 → 网关报 DATABASE_XX000 EMAXCONNSESSION（max clients reached），
// 被 execPgSql 包成异常、Route Handler 再包成 500 打回前端控制台。
//
// 两层防御：
//  (1) 每条网关请求强制 Connection: close（见 execPgSqlOnce）——session 模式下一个
//      keep-alive 连接就占一个 SQL 会话槽，本机常驻的孤儿 dev server 即使空闲也会
//      长期霸占几条 keep-alive 会话不释放，把 10 槽池占死。关掉 keep-alive 后，空闲
//      进程占 0 槽，只有「在途」请求才占槽，跨进程竞争问题从根上消除。
//  (2) 令牌桶把「单进程同时打向网关的 exec-pgsql 数」限制在 3（远低于 10），即便同机
//      再开一个 dev server 各跑 3，合计 6 也留 4 槽余量给本环境其它消费者（其它实例/
//      同环境其它应用/真人实时会话），杜绝单进程内突发打满池导致第三个用户被堵。
//
// 实际看：单页打开的扇出常达 10+ 条 SQL，3 槽下排队把所有人拖死 → 客户端表现为
// 偶发 EMAXCONNSESSION（500）。配合下方「in-flight SQL 去重」+ 下一条注释的
// 「同 SQL 复用 in-flight Promise」，单实例单需求场景下从 16 SQL 扇出降到 3~5 SQL。
// ---------------------------------------------------------------------------
const MAX_CONCURRENT_SQL = 5; // 提到 5，留 5 槽余量给同 env 其它消费方
let _sqlActive = 0;
const _sqlWaiters: Array<() => void> = [];
function acquireSqlSlot(): Promise<void> {
  if (_sqlActive < MAX_CONCURRENT_SQL) {
    _sqlActive++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => _sqlWaiters.push(resolve));
}
function releaseSqlSlot(): void {
  _sqlActive--;
  if (_sqlActive < MAX_CONCURRENT_SQL && _sqlWaiters.length > 0) {
    _sqlActive++;
    _sqlWaiters.shift()!();
  }
}

// ---------------------------------------------------------------------------
// In-flight SQL 去重（关键杠杆 P0）
//
// 同一 SQL 字符串在同一时刻如果已在飞（请求已发出、尚未返回），后续所有调用
// 共享这次返回，不再新发请求。典型场景：
//   - 单页打开时 `outputs/prd` 与 `outputs/card` 同时被拉，两个 route 都查
//     `prds` / `cards`，但代码路径未必同一 key——SQL 字符串完全一致时直接复用。
//   - React StrictMode 双渲染 / 同 SWR key 短窗口内两次 mutate。
//
// 实现：Map<sqlText, Promise<T[]>>，命中返回同一个 Promise（所有 then 共用），
// finally 时删除。注意：同一 SQL 在 5 分钟内不重复执行（业务层 SELECT 是幂等的）；
// 不同 SQL 即使语义等价（如 `SELECT * FROM x WHERE id=1` 与 `SELECT id FROM x WHERE id=1`）
// 不会合并（字符串不同），避免误吞结果。
// ---------------------------------------------------------------------------
/**
 * in-flight SQL 去重 + 并发栅栏 + 瞬时错误重试（三层防御合一）。
 * 同一 SQL 字符串在同一时刻只发一次请求，所有 caller 共享同一 Promise。
 */
async function execPgSqlSharedInner<T = Row>(sqlText: string): Promise<T[]> {
  assertConfig();
  await acquireSqlSlot();
  try {
    // 瞬时错误（连接池耗尽 / 限流 / 网关抖动）最多重试 7 次，指数退避 + 抖动。
    // EMAXCONNSESSION 返回的是 HTTP 400（非 5xx），故重试判定靠错误体关键字，不靠状态码。
    const MAX_ATTEMPTS = 7;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await execPgSqlOnce<T>(sqlText);
      } catch (e) {
        lastErr = e;
        // 仅对瞬时的连接池/网关类错误重试；业务错误（如字段契约漂移、SQL 语法错）
        // 立即抛出，避免掩盖真实问题。
        if (!isTransientSqlError(e)) break;
        if (attempt < MAX_ATTEMPTS - 1) {
          await sleepMs(150 * Math.pow(2, attempt) + Math.floor(Math.random() * 120));
        }
      }
    }
    throw lastErr;
  } finally {
    releaseSqlSlot();
  }
}

const _sqlInFlight = new Map<string, Promise<Row[]>>();
function execPgSqlShared<T = Row>(sqlText: string): Promise<T[]> {
  const hit = _sqlInFlight.get(sqlText);
  if (hit) return hit as Promise<T[]>;
  const p = execPgSqlSharedInner<T>(sqlText).finally(() => _sqlInFlight.delete(sqlText));
  _sqlInFlight.set(sqlText, p as Promise<Row[]>);
  return p;
}

// 网关瞬时错误：连接池耗尽 / 限流 / 网关抖动等。这些应重试而非直接 500。
export function isTransientSqlError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /EMAXCONNSESSION|max clients reached|DATABASE_XX000|DATABASE_25006|429|503|ECONNRESET|ETIMEDOUT|socket hang up|timed out/i.test(
    msg
  );
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 单次执行一条 SQL（不含并发控制与重试）。 */
async function execPgSqlOnce<T = Row>(sqlText: string): Promise<T[]> {
  const res = await fetch(`${BASE}/v1/rdb/exec-pgsql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      // 【必须 Connection: close】CloudBase 网关 SQL 通道是 session 模式：一个
      // keep-alive 连接就占一个 SQL 会话槽，pool_size=10。若开 keep-alive，本机
      // 空闲的孤儿 dev server 也会长期握着几条会话不释放，把 10 槽池占死，导致
      // 活跃服务器任何请求（哪怕是单条 UPDATE）都 EMAXCONNSESSION。关掉后空闲进程
      // 占 0 槽，仅在途请求占槽，跨进程争用从根上消除。（undici 会尊重该请求头、
      // 响应后立即不复用 socket。）
      "Connection": "close",
    },
    body: JSON.stringify({ Sql: sqlText, Role: ROLE }),
    // 【必须 no-store，删掉会立刻制造"数据永远不更新"的幽灵 bug】
    // Next.js 在 App Router 运行时里替换了全局 fetch，默认把响应写进 Data Cache，
    // 且该缓存【落盘】在 .next/cache/fetch-cache，重启 dev server 都不失效。
    // 本函数的 SELECT 语句对同一行是逐字节相同的字符串 —— 一旦命中缓存，
    // 之后无论数据库怎么变，读到的永远是第一次的快照：
    // 现象就是"UPDATE 明明 RETURNING 了新值，接口却一直返回旧值"。
    // （PRDHub 时代走 @cloudbase/node-sdk，用的是 SDK 自带 HTTP 客户端，
    //   不经全局 fetch，所以没这个问题；迁到网关 SQL 通道后才暴露。）
    // 数据库读写是绝对动态的，任何缓存语义在这里都是错的。
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`exec-pgsql HTTP ${res.status}: ${text}\nSQL: ${sqlText.slice(0, 300)}`);
  }
  const data = (await res.json()) as unknown;
  // DB_SQL_TRACE=1 时打印每条 SQL 与网关原始响应，排查"写了没生效/读到旧值"用。
  if (process.env.DB_SQL_TRACE) {
    console.error(
      `[SQL] ${sqlText.slice(0, 400)}\n[RES] isArray=${Array.isArray(data)} ${JSON.stringify(data).slice(0, 300)}`
    );
  }
  if (Array.isArray(data)) return data as T[];
  return [];
}

/**
 * 经 B 通道执行一条 SQL。返回 SELECT 的结果行（数组，空结果即 []）；
 * 非 SELECT 返回 [] 或 [{ok:1}]（网关形态，本后端不依赖其具体形状）。
 *
 * 修复：套上「in-flight SQL 去重 + 并发栅栏 + 瞬时错误重试」。
 * - in-flight 去重：相同 SQL 字符串在同一时刻只发一次（其它 caller 复用 Promise）；
 *   单页打开时多 endpoint 同一查询（如 outputs/prd 与 outputs/card 同时查 prds/cards）
 *   自动合并，避免挤爆令牌桶与 PG 连接池。
 * - 并发栅栏：本进程同时在飞 SQL 数 ≤ MAX_CONCURRENT_SQL=5（留 5 槽余量给同 env 其它消费方）。
 * - 瞬时错误重试：EMAXCONNSESSION / 限流 / 网关抖动最多 7 次，指数退避。
 */
function execPgSql<T = Row>(sqlText: string): Promise<T[]> {
  return execPgSqlShared<T>(sqlText);
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

/** 代码键 → 列名（已白名单化）。未知键抛错，把字段契约漂移拦在开发期。 */
function toColumn(table: string, key: string): string {
  const col = FIELD_MAP[table]?.[key];
  if (!col) {
    throw new Error(
      `字段契约漂移：表 "${table}" 没有登记代码键 "${key}"。` +
        `请同步更新 lib/db/field-map.ts、db/schema.sql 与 db/drizzle/schema.ts。`
    );
  }
  return col;
}

/**
 * 把 JS 值安全序列化为 SQL 字面量（无参数化支持时的等效预处理）。
 * 字符串转义 ' 与 \；数字/布尔按类型生成；数组/对象走 JSON（jsonb 与向量字面量都是 JSON 形态）。
 */
function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new Error(`非有限数不能序列化为 SQL 字面量: ${v}`);
    }
    return String(v);
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

/** 标识符加双引号（表/列名均来自白名单，纯防御性）。 */
function id(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function isJsonbCol(table: string, col: string): boolean {
  return (JSONB_COLS[table] ?? []).includes(col);
}

/**
 * 生成一段不会与 content 冲突的 PostgreSQL dollar-quote 标签。
 * 从 "j" 开始，若 content 里包含该闭合 delimiter 则递增标签长度，
 * 直到无冲突（实际 JSON 内容极少含 $j$ 形态子串，通常一次命中）。
 */
function dollarQuoteTag(content: string): string {
  let tag = "j";
  while (content.includes(`$${tag}$`)) {
    tag += "j";
    if (tag.length > 32) {
      // 理论上不会发生；兜底：用随机后缀继续尝试，避免无限循环
      tag = `j${Math.random().toString(36).slice(2, 10)}`;
    }
  }
  return tag;
}

/**
 * 把 JSON 值序列化为 PostgreSQL dollar-quoted jsonb 字面量。
 * 相比单引号 + 反斜杠转义，dollar-quote 对换行、反斜杠、单引号都免疫，
 * 可彻底规避 CloudBase exec-pgsql 网关对 JSONB 字符串的转义歧义（DATABASE_22P02）。
 */
function jsonbLit(v: unknown): string {
  if (v === null || v === undefined) return "NULL"; // jsonb 列也允许 NOT NULL 约束下由调用方保证
  const json = JSON.stringify(v);
  const tag = dollarQuoteTag(json);
  return `$${tag}$${json}$${tag}$::jsonb`;
}

/** 业务对象（代码键）→ [列名, 字面量] 列表（INSERT/UPDATE SET 用）。 */
function toColumns(table: string, row: Row): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue; // 省略 → PG 应用列默认值
    const col = toColumn(table, key);
    if (isJsonbCol(table, col)) {
      out.push([col, jsonbLit(value)]);
    } else {
      out.push([col, lit(value)]);
    }
  }
  return out;
}

/** 数据库行（列名）→ 业务对象（代码键），做时间/大整数/JSONB 类型还原。 */
function toRow<T = Row>(table: string, dbRow: Row | undefined): T | undefined {
  if (!dbRow) return undefined;
  const reverse = REVERSE_MAP[table] ?? {};
  const tsCols = TIMESTAMP_COLS[table] ?? [];
  const bigCols = BIGINT_COLS[table] ?? [];
  const jsonbCols = JSONB_COLS[table] ?? [];
  const out: Row = {};

  for (const [col, raw] of Object.entries(dbRow)) {
    const key = reverse[col] ?? col;
    let value: unknown = raw;

    if (raw !== null && raw !== undefined) {
      if (tsCols.includes(col)) {
        // 网关已把 TIMESTAMPTZ 序列化为 ISO 字符串，统一确保为字符串。
        value = String(raw);
      } else if (bigCols.includes(col)) {
        value = typeof raw === "number" ? raw : Number(raw);
      } else if (jsonbCols.includes(col) && typeof raw === "string") {
        // 防御：个别网关实现可能把 jsonb 当字符串回传，这里补解析。
        try {
          value = JSON.parse(raw);
        } catch {
          value = raw;
        }
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
// 声明式条件 → SQL 字符串
// ---------------------------------------------------------------------------

function buildWhere(table: string, w?: SqlWhere): string | undefined {
  if (!w) return undefined;
  const entries = Object.entries(w);
  if (entries.length === 0) return undefined;

  const frags = entries.map(([key, cmp]) => {
    const c = id(toColumn(table, key));
    if ("eq" in cmp) {
      return cmp.eq === null ? `${c} IS NULL` : `${c} = ${lit(cmp.eq)}`;
    }
    if ("ne" in cmp) {
      return cmp.ne === null
        ? `${c} IS NOT NULL`
        : `${c} IS DISTINCT FROM ${lit(cmp.ne)}`;
    }
    if ("in" in cmp) {
      return cmp.in.length === 0
        ? "false"
        : `${c} IN (${cmp.in.map((x) => lit(x)).join(", ")})`;
    }
    if ("notIn" in cmp) {
      return cmp.notIn.length === 0
        ? "true"
        : `(${c} IS NULL OR ${c} NOT IN (${cmp.notIn.map((x) => lit(x)).join(", ")}))`;
    }
    // isNull / notNull：与后端内存回落对齐，把 null / 空串都视为「无值」。
    if ("isNull" in cmp) return `(${c} IS NULL OR ${c}::text = '')`;
    if ("notNull" in cmp) return `(${c} IS NOT NULL AND ${c}::text <> '')`;
    if ("lt" in cmp) return `${c} < ${lit(cmp.lt)}`;
    if ("lte" in cmp) return `${c} <= ${lit(cmp.lte)}`;
    if ("gt" in cmp) return `${c} > ${lit(cmp.gt)}`;
    if ("gte" in cmp) return `${c} >= ${lit(cmp.gte)}`;
    if ("like" in cmp) return `${c} LIKE ${lit(cmp.like)}`;
    throw new Error(`不支持的查询算子：${JSON.stringify(cmp)}`);
  });

  return frags.join(" AND ");
}

function buildOrderBy(table: string, orderBy?: OrderBy): string | undefined {
  if (!orderBy || orderBy.length === 0) return undefined;
  return orderBy
    .map(([field, dir]) => {
      const c = id(toColumn(table, field));
      return dir === "desc" ? `${c} DESC NULLS LAST` : `${c} ASC NULLS LAST`;
    })
    .join(", ");
}

function listLimit(): number {
  const raw = Number(process.env.DB_LIST_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? raw : 1000;
}

// ---------------------------------------------------------------------------
// 后端实现
// ---------------------------------------------------------------------------

export const cloudbaseBackend: DbBackend = {
  // ---- P1：与 mock / nosql 语义等价 ----

  async list<T = Row>(table: string, where?: (r: Row) => boolean): Promise<T[]> {
    assertTable(table);
    const hint = ORDER_HINT[table];
    const sql = hint
      ? `SELECT * FROM ${id(table)} ORDER BY ${id(hint)} ASC NULLS LAST LIMIT ${listLimit()}`
      : `SELECT * FROM ${id(table)} LIMIT ${listLimit()}`;
    const rows = toRows<T>(table, await execPgSql(sql));
    return where ? (rows as unknown as Row[]).filter(where) as T[] : rows;
  },

  async get<T = Row>(
    table: string,
    idVal: string,
    idKey = "id"
  ): Promise<T | undefined> {
    assertTable(table);
    const allowed = ALLOWED_ID_KEYS[table] ?? [];
    if (!allowed.includes(idKey)) {
      throw new Error(
        `db.get("${table}", …, "${idKey}") 的 idKey 不在白名单 [${allowed.join(", ")}] 内。` +
          `白名单内的列都有 PK/UNIQUE 索引；放开它意味着引入一条无索引的全表扫描。`
      );
    }
    const col = toColumn(table, idKey);
    const rows = await execPgSql<T>(
      `SELECT * FROM ${id(table)} WHERE ${id(col)} = ${lit(idVal)} LIMIT 1`
    );
    return toRow<T>(table, rows[0] as unknown as Row);
  },

  async insert<T>(table: string, row: T): Promise<T> {
    assertTable(table);
    const cols = toColumns(table, row as unknown as Row);
    if (cols.length === 0) {
      throw new Error(`db.insert("${table}") 收到空对象，无法插入。`);
    }
    const colNames = cols.map(([c]) => id(c)).join(", ");
    const values = cols.map(([, v]) => v).join(", ");
    await execPgSql(`INSERT INTO ${id(table)} (${colNames}) VALUES (${values})`);
    // 与 mock / nosql 一致：原样回传入参，不回读数据库默认值。
    return row;
  },

  async update<T>(
    table: string,
    idVal: string | number,
    patch: Partial<T>,
    idKey = "id"
  ): Promise<T | undefined> {
    assertTable(table);
    const cols = toColumns(table, patch as unknown as Row);
    const col = toColumn(table, idKey);

    if (cols.length === 0) {
      const rows = await execPgSql<T>(
        `SELECT * FROM ${id(table)} WHERE ${id(col)} = ${lit(idVal)} LIMIT 1`
      );
      return toRow<T>(table, rows[0] as unknown as Row);
    }

    const setList = cols.map(([c, v]) => `${id(c)} = ${v}`).join(", ");
    const rows = await execPgSql<T>(
      `UPDATE ${id(table)} SET ${setList} WHERE ${id(col)} = ${lit(idVal)} RETURNING *`
    );
    return toRow<T>(table, rows[0] as unknown as Row);
  },

  async remove(table: string, idVal: string, idKey = "id"): Promise<void> {
    assertTable(table);
    const col = toColumn(table, idKey);
    await execPgSql(`DELETE FROM ${id(table)} WHERE ${id(col)} = ${lit(idVal)}`);
  },

  async updateWhere<T = Row>(
    table: string,
    where: Record<string, unknown>,
    patch: Partial<T>
  ): Promise<void> {
    assertTable(table);
    const whereCols = toColumns(table, where);
    if (whereCols.length === 0) {
      throw new Error(
        `db.updateWhere("${table}") 的 where 为空，将更新整表。这几乎总是 bug，已拒绝执行。`
      );
    }
    const patchCols = toColumns(table, patch as unknown as Row);
    if (patchCols.length === 0) return;

    const setList = patchCols.map(([c, v]) => `${id(c)} = ${v}`).join(", ");
    const whereList = whereCols
      .map(([c, v]) => (v === "NULL" ? `${id(c)} IS NULL` : `${id(c)} = ${v}`))
      .join(" AND ");
    await execPgSql(`UPDATE ${id(table)} SET ${setList} WHERE ${whereList}`);
  },

  async removeBy(table: string, field: string, value: unknown): Promise<void> {
    assertTable(table);
    const col = toColumn(table, field);
    if (value === null || value === undefined) {
      await execPgSql(`DELETE FROM ${id(table)} WHERE ${id(col)} IS NULL`);
      return;
    }
    await execPgSql(`DELETE FROM ${id(table)} WHERE ${id(col)} = ${lit(value)}`);
  },

  // ---- P2：可下推的声明式查询 ----

  async findMany<T = Row>(table: string, opts: FindManyOptions): Promise<T[]> {
    assertTable(table);
    const whereStr = buildWhere(table, opts.where);
    const orderStr = buildOrderBy(table, opts.orderBy);
    const parts = [
      `SELECT * FROM ${id(table)}`,
      whereStr ? `WHERE ${whereStr}` : "",
      orderStr ? `ORDER BY ${orderStr}` : "",
      opts.limit != null ? `LIMIT ${opts.limit}` : "",
      opts.offset != null ? `OFFSET ${opts.offset}` : "",
    ].filter(Boolean);
    const rows = toRows<T>(table, await execPgSql(parts.join(" ")));
    return rows;
  },

  async countMany(table: string, where?: SqlWhere): Promise<number> {
    assertTable(table);
    const whereStr = buildWhere(table, where);
    const sql = [
      `SELECT COUNT(*)::text AS n FROM ${id(table)}`,
      whereStr ? `WHERE ${whereStr}` : "",
    ].filter(Boolean).join(" ");
    const rows = await execPgSql<{ n: string }>(sql);
    return Number(rows[0]?.n ?? 0);
  },

  /**
   * 向量检索（真 pgvector）。
   * 目标列须为 vector 类型；相似度用 `1 - (col <=> q)` 下推到 SQL（<=> 为余弦距离）。
   * 接口与 postgres 后端完全一致，业务零改动。
   */
  async searchVector<T = Row>(
    table: string,
    opts: SearchVectorOptions
  ): Promise<Array<T & { score: number }>> {
    assertTable(table);
    const col = toColumn(table, opts.column);
    const q = `${lit(opts.query)}::vector`;
    const whereStr = buildWhere(table, opts.where);
    const notNull = `${id(col)} IS NOT NULL`;
    const finalWhere = whereStr ? `${whereStr} AND ${notNull}` : notNull;

    const sql = [
      `SELECT *, (1 - (${id(col)} <=> ${q})) AS score`,
      `FROM ${id(table)}`,
      `WHERE ${finalWhere}`,
      `ORDER BY ${id(col)} <=> ${q} ASC`,
      `LIMIT ${opts.topK}`,
    ].join(" ");

    const rows = await execPgSql<Row & { score: number }>(sql);
    const scored: Array<T & { score: number }> = [];
    for (const r of rows) {
      const score = typeof r.score === "number" ? r.score : Number(r.score);
      if (opts.minScore != null && score < opts.minScore) continue;
      scored.push(toRow<T>(table, r as unknown as Row) as T & { score: number });
    }
    return scored;
  },
};

/** 供 scripts / 冒烟测试复用（业务层不得使用）。 */
export const __internals = { toRow, toColumns, toColumn, assertTable, lit, execPgSql };
