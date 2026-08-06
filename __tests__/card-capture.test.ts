// 需求卡片渐进抽取的回归测试：
// 1) extractReplyAndCard 能从模型回复里分离「自然语言」与「结构化卡片 JSON」（这是整条
//    渐进记录链路最脆弱的一跳——模型漏写/写错 JSON 块就抓不到卡片）。
// 2) mergeRequirementCard 增量合并：只填非空、覆盖已有值、保留其余字段（渐进完善与对话中纠正的语义基础）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEnvConfig } from "@next/env";

// 用 mock 后端跑合并逻辑，无需真实 PG / CloudBase。
loadEnvConfig(process.cwd());
process.env.USE_MOCK = "true";
process.env.DB_BACKEND = "mock";

void test("extractReplyAndCard 分离自然语言与卡片 JSON", () => {
  const full =
    "好的，我已经记下你的想法。\n\n" +
    "```json\n" +
    '{"background":"用户想做一个肉鸽小游戏","targetUsers":"休闲手游玩家","painPoints":"操作门槛高","scope":"","nonFunctional":"","constraints":""}\n' +
    "```\n";
  const { reply, card } = require("@/lib/ai/parse").extractReplyAndCard(full);
  assert.equal(reply, "好的，我已经记下你的想法。");
  assert.equal(card.background, "用户想做一个肉鸽小游戏");
  assert.equal(card.targetUsers, "休闲手游玩家");
  assert.equal(card.painPoints, "操作门槛高");
});

void test("extractReplyAndCard 无 JSON 块时返回空卡片，而非抛错", () => {
  const { reply, card } = require("@/lib/ai/parse").extractReplyAndCard("只是普通回复，没有卡片");
  assert.equal(reply, "只是普通回复，没有卡片");
  assert.deepEqual(card, {});
});

void test("mergeRequirementCard 增量合并：仅填非空、保留已有、覆盖纠正", async () => {
  const { createRequirement, mergeRequirementCard, getRequirement } = await import(
    "@/lib/services/requirements"
  );
  const req = await createRequirement({ projectId: "p-card-test", title: "t" });

  // 第一轮：只填 background
  await mergeRequirementCard(req.id, { background: "背景A", targetUsers: "" });
  let r = await getRequirement(req.id);
  assert.equal(r?.card.background, "背景A");
  assert.equal(r?.card.targetUsers, "");

  // 第二轮：补全 targetUsers / painPoints，background 保持
  await mergeRequirementCard(req.id, { targetUsers: "用户B", painPoints: "痛点B" });
  r = await getRequirement(req.id);
  assert.equal(r?.card.background, "背景A", "已填字段应保留");
  assert.equal(r?.card.targetUsers, "用户B", "新字段应写入");
  assert.equal(r?.card.painPoints, "痛点B", "新字段应写入");

  // 第三轮：对话中纠正 targetUsers（覆盖已有值）
  await mergeRequirementCard(req.id, { targetUsers: "用户B修正" });
  r = await getRequirement(req.id);
  assert.equal(r?.card.targetUsers, "用户B修正", "非空值应覆盖已有值（支持对话中纠正）");
  assert.equal(r?.card.painPoints, "痛点B", "未提及字段应保持");
});
