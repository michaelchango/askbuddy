// 纯函数：DevContext 分级溯源辅助（AD-3 + 验收红线回溯）。
//
// 刻意不依赖 db / 任何服务端 SDK，因此【可被客户端组件安全引用】，
// 避免把 @cloudbase/node-sdk 拖进浏览器打包（devcontext-panel 仅用 firstSourceTurn）。
import type { DevContext } from "@/lib/schemas/devcontext";

// 递归填充 DevContext 条目的 _source.conversation_turn（分级溯源 + 验收红线回溯）。
// 仅对「已带 _source 但 conversation_turn 缺失」的条目补填，不覆盖模型已填值。
export function injectConversationTurn(node: unknown, turn: number): void {
  if (Array.isArray(node)) {
    node.forEach((n) => injectConversationTurn(n, turn));
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const src = obj._source;
    if (src && typeof src === "object") {
      const s = src as Record<string, unknown>;
      if (s.conversation_turn == null) s.conversation_turn = turn;
    }
    for (const k of Object.keys(obj)) {
      if (k !== "_source") injectConversationTurn(obj[k], turn);
    }
  }
}

/** 从 DevContext 内容中找出第一个非空 conversation_turn（供 UI 回溯跳转）。 */
export function firstSourceTurn(content: DevContext | null | undefined): number | null {
  let found: number | null = null;
  const walk = (node: unknown): void => {
    if (found != null) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      const src = obj._source;
      if (src && typeof src === "object") {
        const t = (src as Record<string, unknown>).conversation_turn;
        if (typeof t === "number" && t > 0) {
          found = t;
          return;
        }
      }
      for (const k of Object.keys(obj)) {
        if (k !== "_source") walk(obj[k]);
      }
    }
  };
  walk(content);
  return found;
}
