// 对象存储封装（MVP：USE_MOCK 走内存；真实模式优先腾讯云 COS，未配置时回落到 CloudBase NoSQL 集合）。
import { USE_MOCK } from "@/lib/cloudbase";
import { db } from "@/lib/db";

const mem: Record<string, string> = {};

// COS 未配置时，把对象存进 NoSQL 的 objects 集合（{ id: key, content }），
// 让原型 HTML 等在真实模式下也能持久化；后续接入 COS 后此分支可移除。
const COS_READY =
  !!process.env.COS_BUCKET && !!process.env.COS_REGION;

export async function putObject(key: string, content: string): Promise<void> {
  if (USE_MOCK) {
    mem[key] = content;
    return;
  }
  if (COS_READY) {
    // TODO: 腾讯云 COS putObject(key, content)
    throw new Error("COS 已配置但尚未实现上传，请补充 COS 上传逻辑或暂时留空 COS_BUCKET。");
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
  if (COS_READY) {
    // TODO: 腾讯云 COS getObject(key)
    throw new Error("COS 已配置但尚未实现下载，请补充 COS 下载逻辑或暂时留空 COS_BUCKET。");
  }
  const row = await db.get<{ id: string; content: string }>("objects", key);
  return row?.content ?? null;
}
