// nosql 后端：CloudBase NoSQL 文档库（@cloudbase/node-sdk，服务端 ApiKey）。
//
// 实现从原 lib/db/index.ts 的真实模式分支【原样搬运】，未做任何语义调整。
// 保留它的意义：M1 期间线上仍跑 NoSQL，PG 只在 DB_BACKEND=postgres 时启用；
// 一旦 PG 出问题，改一个环境变量就能回滚，不需要回滚代码。

import tcb from "@cloudbase/node-sdk";
import type { DbBackendP1, Row } from "./backend";

// 懒初始化：仅在首次访问时建立连接。
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

export const nosqlBackend: DbBackendP1 = {
  async list<T = Row>(table: string, where?: (r: Row) => boolean): Promise<T[]> {
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
    await ensureCollection(table);
    const coll = cloudDb().collection(table);
    const found = await coll.where({ [idKey]: id }).limit(1).get();
    const doc = (found.data as Row[] | undefined)?.[0];
    if (doc?._id) await coll.doc(doc._id as string).remove();
  },

  // 按字段相等条件批量更新（不依赖易冲突的自增 id）。
  // 用于步骤状态等「按 (requirement_id + step) 精确定位」的场景。
  async updateWhere<T = Row>(
    table: string,
    where: Record<string, unknown>,
    patch: Partial<T>
  ): Promise<void> {
    await ensureCollection(table);
    await cloudDb()
      .collection(table)
      .where(where)
      .update(patch as Record<string, unknown>);
  },

  async removeBy(table: string, field: string, value: unknown): Promise<void> {
    await ensureCollection(table);
    await cloudDb().collection(table).where({ [field]: value }).remove();
  },
};
