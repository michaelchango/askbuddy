// 对话列表展示时的「事后排序」纯函数：补偿历史数据在 DB 中的写入顺序错位。
//
// 背景：M3.5 之前，conversation/route.ts 会在 SSE change_update 之后、四路重生成启动之前
// 写入一条「✅ 变更已处理完成，涉及 ...」summary 消息，导致按 id ASC 排序的对话列表里
// summary 跑到「调研分析/方案文档/... 已更新」之前——刷新页面/退出重进后看到错位。
// 已经修复写入时机（summary 改为所有重生成完成后再落库），但 DB 里仍残留修复前产生的
// 旧记录。仅靠新写法的顺序无法覆盖旧数据，因此这里在 UI 层做一次兜底排序：
// 把每条「✅ 变更已处理完成」summary 消息，提升到它所属变更批次（同一波变更的所有
// 「X已更新」系列消息）的最后。
//
// 原则：
// 1. 在原始 id ASC 顺序上做局部调整，不改变同一批次内其他消息的相对顺序。
// 2. 不修改 id/created_at 字段，只调整数组位置——避免影响持久化与对话跳转定位（data-turn）。
// 3. 后续由 conversation-panel 用 reordered 后的数组替换 messages state。
//
// 纯函数：无副作用，便于单测。
// 仅依赖结构化字段（id/role/content/created_at），既兼容 ConversationRow，也兼容
// ConversationPanel 内部 Msg 类型——避免跨包循环依赖。
export interface MessageLike {
  id: number;
  role: string;
  content: string;
  created_at: string;
}

// 标记「变更已处理完成」summary 消息（前缀 ✅ + 变更已处理完成）。仅匹配由我们自家
// 写入的总结；其它系统/AI 文本不会被误判。
const SUMMARY_PREFIX = "✅ 变更已处理完成";

// 检测消息是否为「变更完成」summary。
export function isChangeSummary(msg: MessageLike): boolean {
  return msg.role === "assistant" && msg.content.startsWith(SUMMARY_PREFIX);
}

// 检测消息是否为「X已更新」系列（属于某波变更的中间产物）。
// 这类消息是判断批次边界的关键——一批变更通常以「收到！我检测到你的修改涉及」开头
// 后接 N 条「X已更新」系列消息，再以「✅ 变更已处理完成」收尾。
function isUpdatedMessage(msg: MessageLike): boolean {
  if (msg.role !== "assistant") return false;
  // 形如「✅ 原型已更新。」「✅ 调研分析已生成，请在下方确认后进入下一阶段。」等
  return /已更新|已生成|已更新，请在下方/ .test(msg.content);
}

// 找到「变更批次」范围 [batchStart, batchEnd]：
// - batchStart：向前找到的最后一个用户消息（>= 0）。若找不到用户消息，返回 null（视为孤立）。
// - batchEnd：向后找到的下一个用户消息之前的最后一条；或者列表末尾。
// 在 [batchStart, batchEnd] 范围（含 user/changeReply/X已更新/summary）内：
//   - 找到所有「X已更新」消息中最后一条的位置 lastUpdIdx。
//   - 把 summary 移到 lastUpdIdx + 1。
function findBatch(
  messages: MessageLike[],
  summaryIdx: number
): { start: number; end: number } | null {
  // 向前：找用户消息；若中间遇到前一个 summary，视为孤立（理论上 summary 之前不应有
  // 另一个 summary，因为每次变更只会落一条 summary）。
  let start = -1;
  for (let i = summaryIdx - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      start = i;
      break;
    }
    if (isChangeSummary(messages[i])) {
      return null;
    }
  }
  if (start < 0) return null;
  // 向后：找下一个用户消息
  let end = messages.length - 1;
  for (let i = summaryIdx + 1; i < messages.length; i++) {
    if (messages[i].role === "user") {
      end = i - 1;
      break;
    }
  }
  return { start, end };
}

/**
 * 局部调整：在原始排序基础上，把「✅ 变更已处理完成」summary 提升到所属变更批次最后。
 * 不改变消息 id、created_at；其他消息相对顺序不变。
 *
 * 注意：扫描方向从右往左——这样后处理的变更批次先调整，前处理的批次调整时不受
 * 后处理批次的影响（splice 已使后续索引前移，从右往左扫描天然兼容）。
 *
 * 拼接目标位置：先在原数组中用 lastUpdIdx 算出"目标位置"（lastUpdIdx + 1），再
 * 转成 splice 后的索引。splice 会在 i 处移除 1 个元素，导致 i 之后所有元素前移 1 位，
 * 从而 target_orig 与 i 的关系决定 target_after_splice 的偏移：
 *   - target_orig <= i：summary 已经在 X已更新 之后（target = target_orig = i），无需移动。
 *   - target_orig > i：summary 错位在 X已更新 之前（splice 后 lastUpdIdx 之前移 1，
 *     target_after_splice = lastUpdIdx_new + 1 = (lastUpdIdx - 1) + 1 = lastUpdIdx，
 *     也即 target_orig - 1）。
 */
export function reorderForDisplay<T extends MessageLike>(messages: T[]): T[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (!isChangeSummary(out[i])) continue;
    const summary = out[i];
    const batch = findBatch(out, i);
    if (!batch) continue; // 孤立 summary，保持原位
    const { start, end } = batch;
    // 在 (start, end]（不含 user）范围内找「X已更新」最后一条位置。
    // 注意：summary 自己也可能落在 (start, end] 内，必须跳过——否则 summary 错位
    // 在 X已更新 之前时，自己被当成 lastUpdIdx 导致 target === i 通过退出（误判为已正确）。
    let lastUpdIdx = -1;
    for (let j = end; j > start; j--) {
      if (j === i) continue; // 跳过 summary 自己
      if (isUpdatedMessage(out[j])) {
        lastUpdIdx = j;
        break;
      }
    }
    if (lastUpdIdx < 0) continue; // 批次内无「X已更新」，summary 位置已正确，保持原位
    const targetOrig = lastUpdIdx + 1;
    const target = targetOrig <= i ? targetOrig : targetOrig - 1;
    if (target === i) continue;
    // 移除并插入
    out.splice(i, 1);
    out.splice(target, 0, summary);
  }
  return out;
}
