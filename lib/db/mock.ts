// mock 后端：进程内内存表（表随写入惰性创建，不预置种子数据）。
//
// 实现从原 lib/db/index.ts 的 USE_MOCK 分支【原样搬运】，未做任何语义调整 ——
// M1 的目标是「新增第三个后端」，不是「顺手重构前两个」。任何行为差异都会让
// 「切回 mock 复现问题」这条排障路径失效。
//
// 内存表挂在 globalThis 上：Next.js dev 会把本模块按 route 分别打包，
// 不共享就会出现跨路由数据不一致。

import type { DbBackendP1, Row } from "./backend";

const g = globalThis as Record<string, unknown>;
const memory: Record<string, Row[]> =
  (g.__askbuddy_memory as Record<string, Row[]> | undefined) ??
  ({} as Record<string, Row[]>);
if (!g.__askbuddy_memory) g.__askbuddy_memory = memory;

function ensureTable(name: string): Row[] {
  if (!memory[name]) memory[name] = [];
  return memory[name];
}

export const mockBackend: DbBackendP1 = {
  async list<T = Row>(table: string, where?: (r: Row) => boolean): Promise<T[]> {
    const all = memory[table] ?? [];
    return (where ? all.filter(where) : [...all]) as T[];
  },

  async get<T = Row>(
    table: string,
    id: string,
    idKey = "id"
  ): Promise<T | undefined> {
    const all = memory[table] ?? [];
    return all.find((r) => r[idKey] === id) as T | undefined;
  },

  async insert<T>(table: string, row: T): Promise<T> {
    ensureTable(table).push(row as unknown as Row);
    return row;
  },

  async update<T>(
    table: string,
    id: string | number,
    patch: Partial<T>,
    idKey = "id"
  ): Promise<T | undefined> {
    const rows = ensureTable(table);
    const idx = rows.findIndex((r) => r[idKey] === id);
    if (idx === -1) return undefined;
    rows[idx] = { ...rows[idx], ...patch } as unknown as Row;
    return rows[idx] as unknown as T;
  },

  async remove(table: string, id: string, idKey = "id"): Promise<void> {
    const rows = memory[table] ?? [];
    memory[table] = rows.filter((r) => r[idKey] !== id);
  },

  async updateWhere<T = Row>(
    table: string,
    where: Record<string, unknown>,
    patch: Partial<T>
  ): Promise<void> {
    const rows = memory[table] ?? [];
    for (const r of rows) {
      const hit = Object.entries(where).every(([k, v]) => r[k] === v);
      if (hit) Object.assign(r, patch as Record<string, unknown>);
    }
  },

  async removeBy(table: string, field: string, value: unknown): Promise<void> {
    const rows = memory[table] ?? [];
    memory[table] = rows.filter((r) => r[field] !== value);
  },
};

/** 仅供测试使用：清空全部内存表。生产代码不得调用。 */
export function __resetMemory(): void {
  for (const k of Object.keys(memory)) delete memory[k];
}
