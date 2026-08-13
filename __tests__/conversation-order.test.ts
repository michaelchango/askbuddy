/**
 * 对话顺序兜底排序测试（post-display reorder）。
 *
 * 防什么：M3.5 之前 conversation/route.ts 在 SSE change_update 之后、四路重生成启动之前
 * 写入「✅ 变更已处理完成」summary 消息，导致该 summary 在 DB id ASC 排序里跑到
 * 「调研分析/方案文档/... 已更新」之前——刷新页面/退出重进后看到错位。
 * 已经修复写入时机，但 DB 里仍残留历史数据；UI 层 reorderForDisplay 即在做兜底。
 *
 * 测试覆盖：
 * 1. 已正确顺序：保持不变（id 间距和内容不动）
 * 2. 错位顺序：summary 被提升到所属批次所有「X已更新」之后
 * 3. 多轮变更：两个批次各自紧凑收尾
 * 4. 孤立 summary：保持原位（无前序用户消息）
 * 5. 批次内无 X已更新：summary 紧跟 changeReply 之后
 * 6. 强鲁棒性：夹杂普通对话回复不误判
 */
import test from "node:test";
import assert from "node:assert/strict";
import { reorderForDisplay, isChangeSummary } from "@/lib/services/conversation-order";

let nextId = 1;
function userMsg(content: string) {
  return { id: nextId++, role: "user", content, created_at: "2026-08-13T18:30:00Z" };
}
function assistantMsg(content: string, createdAt?: string) {
  return {
    id: nextId++,
    role: "assistant",
    content,
    created_at: createdAt ?? "2026-08-13T18:30:01Z",
  };
}
function changeReply() {
  return assistantMsg("收到！我检测到你的修改涉及以下内容：\n- 调研报告\n- 方案文档");
}
function updResearch() {
  return assistantMsg("✅ 调研分析已更新。");
}
function updDesign() {
  return assistantMsg("✅ 方案文档已更新。");
}
function updPrototype() {
  return assistantMsg("✅ 原型已更新。");
}
function updPrd() {
  return assistantMsg("✅ 需求文档已更新。");
}
function changeSummary(extra = "需求文档") {
  return assistantMsg("✅ 变更已处理完成，涉及 调研报告、方案文档、原型、需求文档。如需进一步调整请继续描述。");
}
function dialogReply() {
  return assistantMsg("好的，我来帮您梳理需求。");
}

test("已正确顺序：保持不变（id 顺序、created_at 顺序均不变）", () => {
  nextId = 1;
  const input = [
    userMsg("改个需求"),
    changeReply(),
    updResearch(),
    updDesign(),
    updPrototype(),
    updPrd(),
    changeSummary(),
  ];
  const out = reorderForDisplay(input);
  assert.deepEqual(out.map((m) => m.id), input.map((m) => m.id), "id 顺序不变");
  assert.deepEqual(out.map((m) => m.content), input.map((m) => m.content), "内容顺序不变");
  // 没收尾清单错位
  assert.equal(isChangeSummary(out[out.length - 1]), true, "summary 仍为最后一条");
});

test("错位顺序：summary 在 DB 中早于批次内中间产物 → 提升到 X已更新 后", () => {
  nextId = 1;
  // 模拟 DB 中的真实顺序（旧 bug 写入：summary 早于 4 个 X已更新）
  const input = [
    userMsg("改个需求"),
    changeReply(),
    changeSummary(), // ← 早期写入
    updResearch(),
    updDesign(),
    updPrototype(),
    updPrd(),
  ];
  const out = reorderForDisplay(input);
  // summary 应被移到所有 X已更新 之后（最后一条）
  assert.equal(isChangeSummary(out[out.length - 1]), true, "summary 移到末尾");
  assert.equal(out[out.length - 1].content, "✅ 变更已处理完成，涉及 调研报告、方案文档、原型、需求文档。如需进一步调整请继续描述。");
  // 最后 5 条按依赖顺序：research→design→prototype→prd→summary
  const last5 = out.slice(-5).map((m) => m.content);
  assert.deepEqual(last5, [
    "✅ 调研分析已更新。",
    "✅ 方案文档已更新。",
    "✅ 原型已更新。",
    "✅ 需求文档已更新。",
    "✅ 变更已处理完成，涉及 调研报告、方案文档、原型、需求文档。如需进一步调整请继续描述。",
  ]);
  // 头两条：user, changeReply
  assert.equal(out[0].role, "user");
  assert.equal(out[1].content, "收到！我检测到你的修改涉及以下内容：\n- 调研报告\n- 方案文档");
});

test("多轮变更：两个批次各自紧凑收尾", () => {
  nextId = 1;
  const input = [
    userMsg("改个需求"),
    changeReply(),
    updResearch(),
    changeSummary(), // 批次 1 早期写入
    updDesign(),
    userMsg("再改一下"),
    changeReply(),
    updPrd(),
    changeSummary(), // 批次 2 早期写入
  ];
  const out = reorderForDisplay(input);
  // 批次 1: 调研分析已更新、方案文档已更新、summary（从右往左扫，找 end=4（user2之前），
  // 范围内最近的 X已更新 在 idx 4 = updDesign。summary 移到这里之后 = idx 5.
  // 期望末尾相对顺序：
  //   user1 / changeReply1 / research_updated / design_updated / summary1
  //   user2 / changeReply2 / prd_updated / summary2
  const contents = out.map((m) => m.content);
  // 校验关键索引
  assert.equal(out[0].role, "user");
  assert.equal(out[0].content, "改个需求");
  // 找到 summary1 的索引
  const summary1Idx = out.findIndex(isChangeSummary);
  const summary2Idx = out.findLastIndex(isChangeSummary);
  // summary1 之前必须是「方案文档已更新」，之后必须是 user2
  assert.equal(out[summary1Idx - 1].content, "✅ 方案文档已更新。");
  assert.equal(out[summary1Idx + 1].content, "再改一下");
  // summary2 之前必须是「需求文档已更新」
  assert.equal(out[summary2Idx - 1].content, "✅ 需求文档已更新。");
  assert.equal(summary2Idx, out.length - 1, "summary2 是最后一条");
  // 整体确保顺序良好
  assert.ok(contents.indexOf("✅ 调研分析已更新。") < contents.indexOf("✅ 方案文档已更新。"));
});

test("孤立 summary（无前序用户消息）：保持原位", () => {
  nextId = 1;
  const input = [
    changeReply(),
    changeSummary(),
  ];
  const out = reorderForDisplay(input);
  assert.deepEqual(out.map((m) => m.id), input.map((m) => m.id));
  assert.equal(out[out.length - 1].content, "✅ 变更已处理完成，涉及 调研报告、方案文档、原型、需求文档。如需进一步调整请继续描述。");
});

test("批次内无 X已更新（仅 changeReply + summary）：保持原位", () => {
  nextId = 1;
  const input = [
    userMsg("改个需求"),
    changeReply(),
    changeSummary(),
  ];
  const out = reorderForDisplay(input);
  // summary 紧跟 changeReply 之后；目标位置 = batchStart + 1 = 2，原 i = 2，无需移动
  assert.equal(out[0].role, "user");
  assert.equal(out[1].content, changeReply().content);
  assert.equal(isChangeSummary(out[2]), true);
  assert.deepEqual(out.map((m) => m.id), input.map((m) => m.id));
});

test("鲁棒性：夹杂普通对话回复不被误判", () => {
  nextId = 1;
  const input = [
    userMsg("想问下功能"),
    dialogReply(),
    userMsg("改个需求"),
    changeReply(),
    changeSummary(), // 错位
    updResearch(),
    updDesign(),
    userMsg("再改一下"),
    dialogReply(),
    userMsg("再改改"),
    changeReply(),
    updPrd(),
    changeSummary(), // 错位
  ];
  const out = reorderForDisplay(input);
  // 校验两个 summary 都到了所属批次最后
  const sumIdx = out.findIndex(isChangeSummary);
  const sum2Idx = out.findLastIndex(isChangeSummary);
  assert.equal(out[sumIdx - 1].content, "✅ 方案文档已更新。");
  assert.equal(out[sum2Idx - 1].content, "✅ 需求文档已更新。");
  // 再校验整个数组中，对话回复（dialogReply）位置在两轮变更之间
  assert.equal(out[sumIdx + 1].content, "再改一下");
});

test("空列表：保持空", () => {
  assert.deepEqual(reorderForDisplay([]), []);
});

test("纯函数：输出不与输入共享引用", () => {
  nextId = 1;
  const input = [
    userMsg("改个需求"),
    changeReply(),
    changeSummary(),
    updResearch(),
  ];
  const out = reorderForDisplay(input);
  assert.notEqual(out, input, "返回新数组");
  assert.equal(input[1].content, changeReply().content, "input[1] 未变");
  // 实际上这里的 reorder 让 summary 移到末尾后，input 数组本身由于传引用应当未变
  assert.equal(input.findIndex(isChangeSummary), 2, "原 input 中 summary 仍在 i=2");
});
