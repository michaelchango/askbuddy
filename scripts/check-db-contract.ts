/**
 * 数据库契约校验（M1-T8.5）
 *
 * 【为什么需要这个脚本】
 * 同一份表结构在仓库里有三个副本：
 *   db/schema.sql        人读基线，评审、DBA 沟通、故障排查时看的那份
 *   db/drizzle/schema.ts 机器事实源，drizzle-kit 据此生成迁移
 *   lib/db/field-map.ts  代码键 ⇄ 列名映射，运行时据此拼 SQL
 * 三者任何一处漂移，症状都是「某个字段在某条路径上静默丢失」——
 * 这类问题在 NoSQL 时代根本不会报错，到了 PG 会变成随机 500，且往往在上线后才暴露。
 *
 * T2 花了很大力气把三者对齐了一次。但 M2/M3/M4 都要加表加列，
 * 没有这个脚本，那次勘定的成果撑不过三个里程碑。
 *
 * 运行：npm run db:check
 * 退出码：0 全部通过；1 存在契约违规（可直接接 CI）
 */
import fs from "node:fs";
import path from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";

import * as drizzleSchema from "../db/drizzle/schema";
import {
  TABLES,
  FIELD_MAP,
  ALLOWED_ID_KEYS,
  TIMESTAMP_COLS,
  JSONB_COLS,
  BIGINT_COLS,
  ORDER_HINT,
} from "../lib/db/field-map";

const ROOT = path.resolve(__dirname, "..");
const SQL_PATH = path.join(ROOT, "db", "schema.sql");

const problems: string[] = [];
const notes: string[] = [];

function fail(msg: string): void {
  problems.push(msg);
}

// ---------------------------------------------------------------------------
// 1. 从 db/drizzle/schema.ts 提取「表 → 列集合」
// ---------------------------------------------------------------------------

interface DrizzleTableInfo {
  columns: Set<string>;
  /** 列名 → 是否有 UNIQUE 约束（主键或唯一索引） */
  unique: Set<string>;
}

function readDrizzleTables(): Map<string, DrizzleTableInfo> {
  const out = new Map<string, DrizzleTableInfo>();

  for (const value of Object.values(drizzleSchema)) {
    // 只挑 PgTable，跳过枚举、关系、辅助函数等其他导出
    let cfg: ReturnType<typeof getTableConfig>;
    try {
      cfg = getTableConfig(value as PgTable);
    } catch {
      continue;
    }
    if (!cfg?.name) continue;

    const columns = new Set(cfg.columns.map((c) => c.name));
    const unique = new Set<string>();

    // 单列主键
    for (const pk of cfg.primaryKeys) {
      if (pk.columns.length === 1) unique.add(pk.columns[0].name);
    }
    // 列级 .primaryKey() / .unique()
    for (const c of cfg.columns) {
      if (c.primary || c.isUnique) unique.add(c.name);
    }
    // 单列唯一索引
    for (const idx of cfg.indexes) {
      const cfgIdx = idx.config;
      if (!cfgIdx.unique) continue;
      const cols = cfgIdx.columns ?? [];
      if (cols.length === 1 && cols[0] && "name" in cols[0]) {
        unique.add((cols[0] as { name: string }).name);
      }
    }
    // 表级 unique() 约束
    for (const uq of cfg.uniqueConstraints ?? []) {
      if (uq.columns.length === 1) unique.add(uq.columns[0].name);
    }

    out.set(cfg.name, { columns, unique });
  }

  return out;
}

// ---------------------------------------------------------------------------
// 2. 从 db/schema.sql 提取「表 → 列集合」
// ---------------------------------------------------------------------------
//
// 这是个刻意保持粗糙的解析器：只认 `CREATE TABLE x (` 到配对右括号之间、
// 每行第一个标识符。它不理解 SQL 语法，但对这份手写、格式统一的 DDL 足够用，
// 而且不引入 SQL parser 依赖。解析不到就直接报错，不做静默兜底 ——
// 一个「看起来通过了但其实什么都没校验」的脚本比没有脚本更危险。

// 列定义行的首 token 若是下列之一，则它不是列（而是约束/外键续行关键字）。
// 尤其注意 REFERENCES：外键约束常跨两行写，
//   CONSTRAINT fk_x FOREIGN KEY (col)
//     REFERENCES other(id) ON DELETE ...
// 第二行的首 token 就是 REFERENCES，必须排除，否则会被误判成名为 REFERENCES 的列。
const NON_COLUMN_PREFIX =
  /^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE|REFERENCES|ON|DEFERRABLE|INITIALLY|USING|WITH|MATCH)\b/i;

function readSqlTables(): Map<string, Set<string>> {
  if (!fs.existsSync(SQL_PATH)) {
    fail(`找不到 ${SQL_PATH}`);
    return new Map();
  }
  const sql = fs.readFileSync(SQL_PATH, "utf8");
  const out = new Map<string, Set<string>>();

  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(sql)) !== null) {
    const table = m[1];
    // 从左括号开始做括号配平，找到本表定义的结束位置
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i + 1;
    for (; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) {
      fail(`schema.sql 中 ${table} 的括号未配平，解析中断`);
      continue;
    }

    const body = sql.slice(start, i);
    const cols = new Set<string>();
    for (const rawLine of body.split("\n")) {
      const line = rawLine.replace(/--.*$/, "").trim();
      if (!line) continue;
      if (NON_COLUMN_PREFIX.test(line)) continue;
      const cm = /^"?([a-z_][a-z0-9_]*)"?\s+/i.exec(line);
      if (cm) cols.add(cm[1]);
    }
    out.set(table, cols);
  }

  return out;
}

// ---------------------------------------------------------------------------
// 3. 断言
// ---------------------------------------------------------------------------

function checkTableSets(
  drizzle: Map<string, DrizzleTableInfo>,
  sqlTables: Map<string, Set<string>>
): void {
  const fromMap = new Set(TABLES);
  const fromDrizzle = new Set(drizzle.keys());
  const fromSql = new Set(sqlTables.keys());

  for (const t of fromMap) {
    if (!fromDrizzle.has(t)) fail(`表 ${t}：field-map 有，但 db/drizzle/schema.ts 没有`);
    if (!fromSql.has(t)) fail(`表 ${t}：field-map 有，但 db/schema.sql 没有`);
  }
  for (const t of fromDrizzle) {
    if (!fromMap.has(t)) fail(`表 ${t}：Drizzle 有，但 field-map 的 TABLES 没登记（db.list 会拒绝访问它）`);
  }
  for (const t of fromSql) {
    if (!fromMap.has(t)) fail(`表 ${t}：schema.sql 有，但 field-map 的 TABLES 没登记`);
  }

  // FIELD_MAP 的键必须与 TABLES 完全一致，不能只登记一半
  for (const t of Object.keys(FIELD_MAP)) {
    if (!fromMap.has(t)) fail(`表 ${t}：出现在 FIELD_MAP 里但不在 TABLES 集合中`);
  }
  for (const t of fromMap) {
    if (!FIELD_MAP[t]) fail(`表 ${t}：在 TABLES 里但 FIELD_MAP 没有对应条目`);
  }
}

function checkColumns(
  drizzle: Map<string, DrizzleTableInfo>,
  sqlTables: Map<string, Set<string>>
): void {
  for (const [table, keyMap] of Object.entries(FIELD_MAP)) {
    const d = drizzle.get(table);
    const s = sqlTables.get(table);
    if (!d || !s) continue; // 表级缺失已在上一步报过

    // 每个代码键都要能落到一个真实存在的列
    for (const [key, col] of Object.entries(keyMap)) {
      if (!d.columns.has(col)) {
        fail(`${table}.${key} → 列 "${col}"：Drizzle schema 里没有这个列`);
      }
      if (!s.has(col)) {
        fail(`${table}.${key} → 列 "${col}"：db/schema.sql 里没有这个列`);
      }
    }

    // 反向：Drizzle 里有、但没有任何代码键映射到它
    // 不算错误（有些列确实是代码从不读写的，如 team_id、priority），但要提示，
    // 因为「新加了列却忘了加映射」与「这列本来就不用」在这里长得一模一样。
    const mapped = new Set(Object.values(keyMap));
    for (const col of d.columns) {
      if (!mapped.has(col)) {
        notes.push(`${table}.${col}：Drizzle 有此列，但 FIELD_MAP 无任何代码键映射到它（新增列请补映射，否则代码永远读写不到）`);
      }
    }

    // 两份 schema 之间的列差异
    for (const col of d.columns) {
      if (!s.has(col)) fail(`${table}.${col}：Drizzle 有，schema.sql 没有（两份基线已漂移）`);
    }
    for (const col of s) {
      if (!d.columns.has(col)) fail(`${table}.${col}：schema.sql 有，Drizzle 没有（两份基线已漂移）`);
    }
  }
}

function checkIdKeys(drizzle: Map<string, DrizzleTableInfo>): void {
  for (const [table, keys] of Object.entries(ALLOWED_ID_KEYS)) {
    const d = drizzle.get(table);
    const keyMap = FIELD_MAP[table];
    if (!d || !keyMap) continue;

    for (const key of keys) {
      const col = keyMap[key];
      if (!col) {
        fail(`ALLOWED_ID_KEYS[${table}] 含 "${key}"，但 FIELD_MAP 里没有这个代码键`);
        continue;
      }
      // db.get(table, id, idKey) 假定 idKey 能唯一定位一行。
      // 若该列没有唯一约束，"取一行"实际是"取任意一行"——是那种平时看不出、
      // 数据一多就开始随机返回错误记录的缺陷。
      if (!d.unique.has(col)) {
        fail(
          `ALLOWED_ID_KEYS[${table}].${key} → 列 "${col}" 没有唯一约束/唯一索引，` +
            `db.get 用它查询无法保证唯一命中`
        );
      }
    }
  }
}

function checkTypeMeta(drizzle: Map<string, DrizzleTableInfo>): void {
  const metas: Array<[string, Readonly<Record<string, readonly string[]>>]> = [
    ["TIMESTAMP_COLS", TIMESTAMP_COLS],
    ["JSONB_COLS", JSONB_COLS],
    ["BIGINT_COLS", BIGINT_COLS],
  ];

  for (const [name, meta] of metas) {
    for (const [table, cols] of Object.entries(meta)) {
      const d = drizzle.get(table);
      if (!d) {
        fail(`${name} 登记了未知表 ${table}`);
        continue;
      }
      for (const col of cols) {
        if (!d.columns.has(col)) {
          fail(`${name}[${table}] 含列 "${col}"，但 Drizzle schema 里没有`);
        }
      }
    }
  }

  // ORDER_HINT 指向的列必须存在，否则 db.list 的默认排序会拼出一条报错 SQL
  for (const [table, col] of Object.entries(ORDER_HINT)) {
    if (!col) continue;
    const d = drizzle.get(table);
    if (!d) {
      fail(`ORDER_HINT 登记了未知表 ${table}`);
      continue;
    }
    if (!d.columns.has(col)) {
      fail(`ORDER_HINT[${table}] = "${col}"，但该列不存在`);
    }
  }
}

function checkForbidden(sqlTables: Map<string, Set<string>>): void {
  // AC-8：这五张表在 M1 被明确废弃，任何一张重新出现都说明有人在照抄旧 schema
  for (const t of ["research", "analysis", "webhook_configs", "ai_tasks", "outputs"]) {
    if (sqlTables.has(t)) fail(`schema.sql 中出现已废弃的表 ${t}（AC-8）`);
  }

  // AC-9 / AC-10：cos_key 已在 M1 全面移除
  for (const [table, cols] of sqlTables) {
    if (cols.has("cos_key")) {
      fail(`${table}.cos_key：该列已于 M1 移除（原型改用 html_storage_key，PRD 侧本就恒空）`);
    }
  }

  // AC-5：M1 不建任何向量业务表
  if (sqlTables.has("knowledge_entries")) {
    fail(`schema.sql 中出现 knowledge_entries —— 向量表属于 M4，M1 不得建（维度不可逆，见 R3）`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(): void {
  const drizzle = readDrizzleTables();
  const sqlTables = readSqlTables();

  if (drizzle.size === 0) fail("未能从 db/drizzle/schema.ts 解析出任何表");
  if (sqlTables.size === 0) fail("未能从 db/schema.sql 解析出任何表");

  checkTableSets(drizzle, sqlTables);
  checkColumns(drizzle, sqlTables);
  checkIdKeys(drizzle);
  checkTypeMeta(drizzle);
  checkForbidden(sqlTables);

  console.log(
    `[db:check] 表数量  field-map=${TABLES.size}  drizzle=${drizzle.size}  schema.sql=${sqlTables.size}`
  );

  if (notes.length > 0) {
    console.log(`\n[db:check] 提示 ${notes.length} 条（不阻断）：`);
    for (const n of notes) console.log(`  · ${n}`);
  }

  if (problems.length > 0) {
    console.error(`\n[db:check] 契约违规 ${problems.length} 条：`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(
      `\n三份表结构必须同步修改：db/schema.sql（人读基线）、` +
        `db/drizzle/schema.ts（迁移事实源）、lib/db/field-map.ts（运行时映射）。`
    );
    process.exit(1);
  }

  console.log("[db:check] 契约校验通过");
}

main();
