// 对象存储封装。
// - USE_MOCK：进程内内存表；
// - 真实模式：落 CloudBase NoSQL 的 objects 集合（{ id: key, key, content }）。
//
// 说明：原先这里有一段「COS 已配置则走 COS」的分支，但 COS 上传/下载从未实现，
// 一旦用户在 .env 里填了 COS_BUCKET/COS_REGION 就会直接 throw，属于反向陷阱，
// 故在 M0 移除。真正接入对象存储放在 M1（见 M1 阶段文档），届时在此新增实现分支。
import { USE_MOCK } from "@/lib/cloudbase";
import { db } from "@/lib/db";

/**
 * mock 对象存储。
 *
 * 【为什么挂在 globalThis 而不是模块局部变量】
 * 模块局部变量在 Next dev 的**模块重评估**（路由首次编译 / HMR）之后会被重置，
 * 而 mock DB 因为挂在 `globalThis.__askbuddy_memory` 上会存活下来。两者持久性不一致
 * 会造出一类极难查的 flake：同一个进程内「先生成原型 → 后读原型」，中间只要发生
 * 一次模块重评估，HTML 就静默变成空字符串（DB 行还在、`html_storage_key` 也在，
 * 只有对象内容没了，没有任何报错）。
 *
 * 由 M5 e2e 场景 05 的 `--repeat-each=2` 暴露（第二遍必失败，第一遍必成功）。
 * 修法就是让 mock 层的持久性与 DB 对齐：用同一个 globalThis 兜底。
 */
const globalStore = globalThis as unknown as { __askbuddy_objects?: Record<string, string> };
const mem: Record<string, string> = (globalStore.__askbuddy_objects ??= {});

export async function putObject(key: string, content: string): Promise<void> {
  if (USE_MOCK) {
    mem[key] = content;
    return;
  }
  const existing = await db.get<{ id: string; content: string }>("objects", key);
  if (existing) {
    await db.update("objects", key, { content });
  } else {
    await db.insert("objects", { id: key, key, content });
  }
}

export async function getObject(key: string): Promise<string | null> {
  if (USE_MOCK) return mem[key] ?? null;
  const row = await db.get<{ id: string; content: string }>("objects", key);
  return row?.content ?? null;
}
