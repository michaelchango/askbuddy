// 三后端（mock / nosql / postgres）的共同契约。
//
// 任何后端必须完整实现 P1 七方法；P2 方法可选 —— 未实现时由 lib/db/index.ts 的门面
// 回落到「list + 内存过滤」，保证切到 mock/nosql 时热点路径仍然可用。
//
// 【AD-1 硬约束】业务代码（lib/services/** 与 app/**）只认这里定义的方法，
// 不得 import drizzle-orm / postgres / @/db/drizzle 的任何符号。

export type Row = Record<string, unknown>;

/** P1：与历史 lib/db 完全一致的七个方法，语义等价优先于性能。 */
export interface DbBackendP1 {
  /**
   * 列表查询。where 是任意 JS 回调（含闭包捕获的 Set、字符串方法、时间运算），
   * 无法安全翻译成 SQL，因此 PG 后端也是「拉回内存过滤」，与 nosql 逐字节等价。
   * 需要下推的热点路径请改用 findMany。
   */
  list<T = Row>(table: string, where?: (r: Row) => boolean): Promise<T[]>;
  get<T = Row>(table: string, id: string, idKey?: string): Promise<T | undefined>;
  insert<T>(table: string, row: T): Promise<T>;
  update<T>(
    table: string,
    id: string | number,
    patch: Partial<T>,
    idKey?: string
  ): Promise<T | undefined>;
  remove(table: string, id: string, idKey?: string): Promise<void>;
  updateWhere<T = Row>(
    table: string,
    where: Record<string, unknown>,
    patch: Partial<T>
  ): Promise<void>;
  removeBy(table: string, field: string, value: unknown): Promise<void>;
}

// ---- P2：可下推的声明式条件 DSL（刻意不支持 JS 回调）----
//
// 只有下面 11 个算子，因此可以被【安全、完整、无歧义】地翻译成 SQL，
// 也可以被翻译成等价的 JS 谓词（供 mock/nosql 回落）。
// 「能不能下推」这个问题因此从运行时推断变成了编译期的 API 选择。

export type Cmp =
  | { eq: unknown }
  | { ne: unknown }
  | { in: unknown[] }
  | { notIn: unknown[] }
  | { isNull: true }
  | { notNull: true }
  | { lt: unknown }
  | { lte: unknown }
  | { gt: unknown }
  | { gte: unknown }
  | { like: string };

/** 字段之间是 AND 关系。字段名用【代码键】，由 field-map 映射为 PG 列名。 */
export type SqlWhere = Record<string, Cmp>;

export type OrderBy = Array<[field: string, dir: "asc" | "desc"]>;

export interface FindManyOptions {
  where?: SqlWhere;
  orderBy?: OrderBy;
  limit?: number;
  offset?: number;
}

export interface SearchVectorOptions {
  /** 向量列的代码键，如 "embedding" */
  column: string;
  query: number[];
  topK: number;
  where?: SqlWhere;
  /** 余弦相似度下限（1 = 完全相同） */
  minScore?: number;
}

export interface DbBackendP2 {
  findMany<T = Row>(table: string, opts: FindManyOptions): Promise<T[]>;
  countMany(table: string, where?: SqlWhere): Promise<number>;
  /**
   * 向量检索。M1 已落真实 pgvector：列须为 vector 类型，相似度用
   * `1 - (col <=> $q::vector)` 在 SQL 层下推（<=> 为余弦距离），接口不变。
   * M4 知识复利接入时只需在对应表加 vector 列即可启用。
   */
  searchVector<T = Row>(
    table: string,
    opts: SearchVectorOptions
  ): Promise<Array<T & { score: number }>>;
}

export type DbBackend = DbBackendP1 & Partial<DbBackendP2>;

export type BackendName = "mock" | "nosql" | "postgres" | "cloudbase";

// ---- 供 mock/nosql 回落与对拍单测复用的纯函数 ----

/** 把声明式 SqlWhere 翻译成等价的 JS 谓词（11 个算子逐一映射）。 */
export function whereToPredicate(
  w?: SqlWhere
): ((r: Row) => boolean) | undefined {
  if (!w) return undefined;
  const entries = Object.entries(w);
  if (entries.length === 0) return undefined;

  return (r: Row) =>
    entries.every(([field, cmp]) => {
      const v = r[field];
      if ("eq" in cmp) return v === cmp.eq;
      if ("ne" in cmp) return v !== cmp.ne;
      if ("in" in cmp) return cmp.in.includes(v);
      if ("notIn" in cmp) return !cmp.notIn.includes(v);
      // isNull / notNull 与业务侧的 !r.archived_at 语义对齐：
      // null / undefined / 空串都视为「无值」（NoSQL 里缺字段就是 undefined）。
      if ("isNull" in cmp) return v === null || v === undefined || v === "";
      if ("notNull" in cmp) return !(v === null || v === undefined || v === "");
      if ("lt" in cmp) return v != null && (v as never) < (cmp.lt as never);
      if ("lte" in cmp) return v != null && (v as never) <= (cmp.lte as never);
      if ("gt" in cmp) return v != null && (v as never) > (cmp.gt as never);
      if ("gte" in cmp) return v != null && (v as never) >= (cmp.gte as never);
      if ("like" in cmp) {
        if (typeof v !== "string") return false;
        // SQL LIKE → 正则：% → .*，_ → .
        const re = new RegExp(
          "^" +
            cmp.like
              .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
              .replace(/%/g, ".*")
              .replace(/_/g, ".") +
            "$"
        );
        return re.test(v);
      }
      return true;
    });
}

/** 内存排序，语义对齐 PG 的 ORDER BY（NULL 值排在最后，与 PG 的 NULLS LAST 默认一致）。 */
export function applyOrderBy<T extends Row>(rows: T[], orderBy?: OrderBy): T[] {
  if (!orderBy || orderBy.length === 0) return rows;
  const sorted = [...rows];
  sorted.sort((a, b) => {
    for (const [field, dir] of orderBy) {
      const av = a[field];
      const bv = b[field];
      const an = av === null || av === undefined;
      const bn = bv === null || bv === undefined;
      if (an && bn) continue;
      if (an) return 1; // NULLS LAST
      if (bn) return -1;
      if ((av as never) < (bv as never)) return dir === "asc" ? -1 : 1;
      if ((av as never) > (bv as never)) return dir === "asc" ? 1 : -1;
    }
    return 0;
  });
  return sorted;
}

/** 余弦相似度（1 = 完全相同）。供 postgres 后端的应用层向量检索与单测复用。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
