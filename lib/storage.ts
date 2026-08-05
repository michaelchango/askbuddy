// 对象存储封装。
// - USE_MOCK：进程内内存表；
// - 真实模式：落 CloudBase NoSQL 的 objects 集合（{ id: key, key, content }）。
//
// 说明：原先这里有一段「COS 已配置则走 COS」的分支，但 COS 上传/下载从未实现，
// 一旦用户在 .env 里填了 COS_BUCKET/COS_REGION 就会直接 throw，属于反向陷阱，
// 故在 M0 移除。真正接入对象存储放在 M1（见 M1 阶段文档），届时在此新增实现分支。
import { USE_MOCK } from "@/lib/cloudbase";
import { db } from "@/lib/db";

const mem: Record<string, string> = {};

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
