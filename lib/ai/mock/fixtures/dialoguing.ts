// 对话访谈 mock 夹具（自 client.ts::mockDialogueText 迁入，未重写逻辑）。
//
// 唯一的确定性增强：输出末尾带 `〔mock-<tag>〕` 指纹标记，
// 便于断言「同一输入逐字节同输出」以及「不同输入确实不同」。

import { hashTag } from "../hash";

export function dialogueFixture(userMessage: string, seed: string): string {
  const card = {
    background: userMessage.slice(0, 200),
    targetUsers: "（示例）注重效率的职场用户",
    painPoints: "（待补充）",
    scope: "（待补充）",
    nonFunctional: "（待补充）",
    constraints: "（待补充）",
  };
  const reply =
    "收到，我已经记下你的初步想法。为了把这条需求打磨清楚，我想先确认几个关键点：\n" +
    "1. 这个需求的用户是谁？他们最核心的痛点是什么？\n" +
    "2. 你期望的第一版范围大概包含哪些功能？\n" +
    "3. 有没有必须遵循的约束（技术栈 / 合规 / 时间）？\n" +
    "你可以随意补充，我会边聊边把信息沉淀到右侧的需求卡片里。";
  const tag = hashTag(seed);
  return `${reply}〔mock-${tag}〕\n\n\`\`\`json\n${JSON.stringify(card, null, 2)}\n\`\`\`\n`;
}
