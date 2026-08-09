// AD-2 同源并列约束：DevContext 与 PRD 平行消费同一组上游，绝不以 PRD 为输入。
//
// 抽成零依赖纯函数有两个目的：
//   1. builder.ts 的 buildUpstream 在开发期直接抛错（见调用处）。
//   2. 可被单元测试，无需触及 db / 任何上游加载逻辑（见 __tests__/builder.test.ts）。
//
// 之所以用「需求文档」这个上游 key 作为判据：buildUpstream 里 PRD 分支写入的 key
// 正是 "需求文档"（见 builder.ts UPSTREAM_LIMITS / prd_writing 分支）。任何为
// devcontext 分支加载 prds 的回归都会在此处被拦下。

import type { AITaskType } from "../models";

/** 若 devcontext 任务的上游里混入了 PRD，立即抛错（AD-2 违例）。其余任务类型放行。 */
export function assertNoPrdUpstream(
  upstream: Record<string, string>,
  taskType: AITaskType
): void {
  if (taskType === "devcontext" && "需求文档" in upstream) {
    throw new Error("AD-2 违例：DevContext 上游不得包含 PRD");
  }
}
