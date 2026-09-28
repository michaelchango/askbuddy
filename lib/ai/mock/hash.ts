// Mock 引擎的「伪随机」唯一合法来源（M5-D3 确定性三铁律之一）。
//
// 禁用 Math.random() / Date.now() / new Date() / crypto.randomUUID()：
// 需要「随机」时一律用输入内容的 FNV-1a 哈希取模——同一输入必得同一输出，
// 这是 D4/D5 全部验收断言的地基。夹具源码的静态扫描测试会守护这条纪律。

/** 固定时间戳：mock 里出现的任何时间都用它，保证输出逐字节可复现。 */
export const MOCK_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** FNV-1a 32 位哈希。 */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 乘 16777619（FNV prime），用移位避免浮点误差
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** 6 位 base36 短标签，用于把「输入指纹」写进 mock 内容（可被人眼与断言同时看到）。 */
export function hashTag(input: string): string {
  return fnv1a(input).toString(36).padStart(6, "0").slice(0, 6);
}

/** 把消息数组压成一个稳定的指纹源（顺序敏感，role 参与）。 */
export function fingerprint(messages: Array<{ role: string; content: string }>): string {
  return messages.map((m) => `${m.role}:${m.content}`).join("\u0000");
}
