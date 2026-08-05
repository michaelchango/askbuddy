// 数据库访问封装（基于 db/schema.sql）
// Mock 模式：进程内内存表（表随写入惰性创建，不再预置种子数据）；
// 真实模式：CloudBase NoSQL 文档库（经 @cloudbase/node-sdk，使用服务端 ApiKey）。
// 业务代码一律经此模块读写，禁止在 Route Handler 拼查询。
//
// 说明：内存表挂在 globalThis 上，确保 Next.js dev 把本模块按 route 分别打包时，
// 各 Route Handler 仍共享同一份内存数据（否则会出现跨路由数据不一致）。
// 真实模式下数据落在 CloudBase，无需 globalThis 共享。

import tcb from "@cloudbase/node-sdk";
import { USE_MOCK } from "@/lib/cloudbase";

type Row = Record<string, unknown>;

// ---------- Mock：进程内存表 ----------
const g = globalThis as Record<string, unknown>;
const memory: Record<string, Row[]> =
  (g.__prdflow_memory as Record<string, Row[]> | undefined) ??
  ({} as Record<string, Row[]>);
if (!g.__prdflow_memory) g.__prdflow_memory = memory;

function ensureTable(name: string): Row[] {
  if (!memory[name]) memory[name] = [];
  return memory[name];
}

// ---------- 真实：CloudBase NoSQL ----------
// 懒初始化：仅在真实模式下、首次访问时建立连接（避免在 mock 模式下也加载 SDK/读取配置）。
let _app: any = null;
function cloudApp() {
  if (!_app) {
    const env = process.env.CLOUDBASE_ENV_ID;
    const secret = process.env.CLOUDBASE_SECRET;
    if (!env || !secret) {
      throw new Error(
        "CloudBase 未配置：请在 .env.local 设置 CLOUDBASE_ENV_ID 与 CLOUDBASE_SECRET"
      );
    }
    _app = tcb.init({ env, accessKey: secret });
  }
  return _app;
}

function cloudDb() {
  return cloudApp().database();
}

// 去掉 CloudBase 系统字段，返回与 mock 一致的业务对象
function stripDoc(doc: any): Row {
  if (!doc) return doc;
  const { _id, _openid, ...rest } = doc;
  return rest as Row;
}

// 探测集合是否存在，不存在则创建（ApiKey 具备管理员权限，可建集合）
async function ensureCollection(table: string): Promise<void> {
  try {
    await cloudDb().collection(table).limit(1).get();
  } catch (e: any) {
    const msg = String(e?.message ?? "");
    if (e?.code === "DATABASE_COLLECTION_NOT_EXIST" || /not exist/i.test(msg)) {
      await cloudDb().createCollection(table);
    } else {
      throw e;
    }
  }
}

function isCollectionMissing(e: any): boolean {
  const msg = String(e?.message ?? "");
  return e?.code === "DATABASE_COLLECTION_NOT_EXIST" || /not exist/i.test(msg);
}

export const db = {
  async list<T = Row>(
    table: string,
    where?: (r: Row) => boolean
  ): Promise<T[]> {
    if (USE_MOCK) {
      const all = memory[table] ?? [];
      return (where ? all.filter(where) : [...all]) as T[];
    }
    await ensureCollection(table);
    // 业务过滤回调含任意 JS 逻辑（如 ids.has(...)），在内存中过滤以保证与 mock 完全一致
    const res = await cloudDb().collection(table).limit(1000).get();
    const all = ((res.data as Row[]) ?? []).map(stripDoc);
    return (where ? all.filter(where) : all) as T[];
  },

  async get<T = Row>(
    table: string,
    id: string,
    idKey = "id"
  ): Promise<T | undefined> {
    if (USE_MOCK) {
      const all = memory[table] ?? [];
      return all.find((r) => r[idKey] === id) as T | undefined;
    }
    await ensureCollection(table);
    const res = await cloudDb()
      .collection(table)
      .where({ [idKey]: id })
      .limit(1)
      .get();
    const row = (res.data as Row[] | undefined)?.[0];
    return row ? (stripDoc(row) as T) : undefined;
  },

  async insert<T>(table: string, row: T): Promise<T> {
    if (USE_MOCK) {
      ensureTable(table).push(row as unknown as Row);
      return row;
    }
    await ensureCollection(table);
    try {
      await cloudDb().collection(table).add(row);
    } catch (e: any) {
      if (isCollectionMissing(e)) {
        await cloudDb().createCollection(table);
        await cloudDb().collection(table).add(row);
      } else {
        throw e;
      }
    }
    return row;
  },

  async update<T>(
    table: string,
    id: string | number,
    patch: Partial<T>,
    idKey = "id"
  ): Promise<T | undefined> {
    if (USE_MOCK) {
      const rows = ensureTable(table);
      const idx = rows.findIndex((r) => r[idKey] === id);
      if (idx === -1) return undefined;
      rows[idx] = { ...rows[idx], ...patch } as unknown as Row;
      return rows[idx] as unknown as T;
    }
    await ensureCollection(table);
    const coll = cloudDb().collection(table);
    const found = await coll.where({ [idKey]: id }).limit(1).get();
    const doc = (found.data as Row[] | undefined)?.[0];
    if (!doc?._id) return undefined;
    await coll.doc(doc._id as string).update(patch);
    const updated = await coll.doc(doc._id as string).get();
    const u = (updated.data as Row[] | undefined)?.[0];
    return u ? (stripDoc(u) as T) : undefined;
  },

  async remove(table: string, id: string, idKey = "id"): Promise<void> {
    if (USE_MOCK) {
      const rows = memory[table] ?? [];
      memory[table] = rows.filter((r) => r[idKey] !== id);
      return;
    }
    await ensureCollection(table);
    const coll = cloudDb().collection(table);
    const found = await coll.where({ [idKey]: id }).limit(1).get();
    const doc = (found.data as Row[] | undefined)?.[0];
    if (doc?._id) await coll.doc(doc._id as string).remove();
  },

  // 按字段相等条件批量更新（不依赖易冲突的自增 id）。
  // 用于步骤状态等「按 (requirement_id + step) 精确定位」的场景，
  // 彻底规避 mock/CloudBase 下 id 跨记录不唯一导致更新命中错误行的问题。
  async updateWhere<T = Row>(
    table: string,
    where: Record<string, unknown>,
    patch: Partial<T>
  ): Promise<void> {
    if (USE_MOCK) {
      const rows = memory[table] ?? [];
      for (const r of rows) {
        const hit = Object.entries(where).every(([k, v]) => r[k] === v);
        if (hit) Object.assign(r, patch as Record<string, unknown>);
      }
      return;
    }
    await ensureCollection(table);
    await cloudDb()
      .collection(table)
      .where(where)
      .update(patch as Record<string, unknown>);
  },

  async removeBy(table: string, field: string, value: unknown): Promise<void> {
    if (USE_MOCK) {
      const rows = memory[table] ?? [];
      memory[table] = rows.filter((r) => r[field] !== value);
      return;
    }
    await ensureCollection(table);
    await cloudDb().collection(table).where({ [field]: value }).remove();
  },
};

export type { Row };
