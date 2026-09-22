// 数据库访问门面。业务代码一律经此模块读写，禁止在 Route Handler 拼查询。
//
// 【三个后端，一套契约】
//   mock     进程内内存表（USE_MOCK=true）
//   nosql    CloudBase NoSQL 文档库（默认，M1 期间线上仍在跑）
//   postgres CloudBase PostgreSQL 直连（DB_BACKEND=postgres，需 DATABASE_URL）
//   cloudbase CloudBase PostgreSQL 经网关 SQL 执行接口（DB_BACKEND=cloudbase，不依赖 DATABASE_URL）
//
// 选择逻辑在 lib/cloudbase/resolveDbBackend()：USE_MOCK > DB_BACKEND > 默认 nosql。
// 「不设任何新环境变量 = 行为与 M1 之前逐字节一致」是这次改造的合入前提。
//
// 【P1 与 P2 的分界】
//   P1（list/get/insert/update/remove/updateWhere/removeBy）
//       历史签名，一字不改。list 的 where 是任意 JS 回调，三个后端一律「拉回内存过滤」。
//   P2（findMany/countMany/searchVector）
//       新增的声明式 DSL，只有 11 个算子，因此可以被完整翻译成 SQL。
//       它刻意【不接受】函数 —— 于是「这个查询能不能下推」从运行时的玄学
//       变成了编译期的 API 选择：写得出 findMany，就一定能下推。
//   后端未实现 P2 时（mock / nosql），由本文件回落到 list + 内存过滤，
//   保证同一份业务代码在三个后端上都能跑，只是快慢不同。

import { resolveDbBackend } from "@/lib/cloudbase";
import {
  applyOrderBy,
  whereToPredicate,
  type DbBackend,
  type FindManyOptions,
  type Row,
  type SearchVectorOptions,
  type SqlWhere,
} from "./backend";

// 后端按需懒加载：mock 模式下不会加载 @cloudbase/node-sdk 与 postgres，
// nosql 模式下也不会加载 postgres 驱动。
let _backend: DbBackend | null = null;
let _loading: Promise<DbBackend> | null = null;

async function backend(): Promise<DbBackend> {
  if (_backend) return _backend;
  if (!_loading) {
    _loading = (async (): Promise<DbBackend> => {
      const name = resolveDbBackend();
      switch (name) {
        case "mock":
          return (await import("./mock")).mockBackend;
      case "postgres":
        return (await import("./postgres")).postgresBackend;
      case "cloudbase":
        return (await import("./cloudbase")).cloudbaseBackend;
        case "nosql":
        default:
          return (await import("./nosql")).nosqlBackend;
      }
    })().then((b) => {
      _backend = b;
      return b;
    });
  }
  return _loading;
}

/** 仅供测试：丢弃已解析的后端，使下次调用重新按环境变量选择。 */
export function __resetBackend(): void {
  _backend = null;
  _loading = null;
}

export const db = {
  // ---------------- P1：历史签名，不做任何改动 ----------------

  async list<T = Row>(table: string, where?: (r: Row) => boolean): Promise<T[]> {
    return (await backend()).list<T>(table, where);
  },

  async get<T = Row>(table: string, id: string, idKey = "id"): Promise<T | undefined> {
    return (await backend()).get<T>(table, id, idKey);
  },

  async insert<T>(table: string, row: T): Promise<T> {
    return (await backend()).insert<T>(table, row);
  },

  async update<T>(
    table: string,
    id: string | number,
    patch: Partial<T>,
    idKey = "id"
  ): Promise<T | undefined> {
    return (await backend()).update<T>(table, id, patch, idKey);
  },

  async remove(table: string, id: string, idKey = "id"): Promise<void> {
    return (await backend()).remove(table, id, idKey);
  },

  /**
   * 按字段相等条件批量更新（不依赖易冲突的自增 id）。
   * 用于步骤状态等「按 (requirement_id + step) 精确定位」的场景。
   */
  async updateWhere<T = Row>(
    table: string,
    where: Record<string, unknown>,
    patch: Partial<T>
  ): Promise<void> {
    return (await backend()).updateWhere<T>(table, where, patch);
  },

  async removeBy(table: string, field: string, value: unknown): Promise<void> {
    return (await backend()).removeBy(table, field, value);
  },

  // ---------------- P2：声明式查询（可下推） ----------------

  /**
   * 声明式列表查询。PG 后端翻译成带 WHERE/ORDER BY/LIMIT 的 SQL；
   * mock / nosql 回落到「list + 内存过滤」，结果集与 PG 完全一致（由对拍单测保证）。
   */
  async findMany<T = Row>(table: string, opts: FindManyOptions = {}): Promise<T[]> {
    const b = await backend();
    if (b.findMany) return b.findMany<T>(table, opts);

    const rows = await b.list<Row>(table, whereToPredicate(opts.where));
    let out = applyOrderBy(rows, opts.orderBy);
    if (opts.offset) out = out.slice(opts.offset);
    if (opts.limit != null) out = out.slice(0, opts.limit);
    return out as T[];
  },

  async countMany(table: string, where?: SqlWhere): Promise<number> {
    const b = await backend();
    if (b.countMany) return b.countMany(table, where);
    const rows = await b.list<Row>(table, whereToPredicate(where));
    return rows.length;
  },

  /**
   * 向量检索。真 pgvector（列须为 vector 类型），相似度用 1 - (col <=> q) 下推。
   * M1 已就绪，业务（M4 知识复利）接入即可用。
   */
  async searchVector<T = Row>(
    table: string,
    opts: SearchVectorOptions
  ): Promise<Array<T & { score: number }>> {
    const b = await backend();
    if (b.searchVector) return b.searchVector<T>(table, opts);
    throw new Error(
      `当前数据库后端不支持 searchVector（向量检索需要 DB_BACKEND=postgres 或 cloudbase）。`
    );
  },

  async queryRaw<T = Row>(
    table: string,
    sql: string,
    params?: Record<string, unknown>
  ): Promise<T[]> {
    const b = await backend();
    if (b.queryRaw) return b.queryRaw<T>(table, sql, params);
    throw new Error(
      `当前数据库后端不支持 queryRaw（需要 DB_BACKEND=cloudbase 或 postgres）。`
    );
  },
};

export type {
  Row,
  SqlWhere,
  FindManyOptions,
  SearchVectorOptions,
  OrderBy,
  Cmp,
} from "./backend";
