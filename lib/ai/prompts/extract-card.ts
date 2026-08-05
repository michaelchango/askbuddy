// 卡片抽取 prompt：把整段对话压缩为结构化需求卡片（供「确认/重新生成」阶段复用，P1 接入独立任务路由）。
import type { PromptModule } from "./types";

export const extractCardPrompt: PromptModule = {
  taskType: "dialoguing",
  system: `你负责把一整段需求对话压缩为结构化需求卡片（RequirementCard）。
只输出一个 \`\`\`json 代码块，字段：background、targetUsers、painPoints、scope、nonFunctional、constraints。未确定的字段写空字符串。`,
  buildUser(vars) {
    const hist = (vars.history ?? [])
      .map((h) => `${h.role === "user" ? "用户" : "助手"}：${h.content}`)
      .join("\n");
    return `【对话全文】\n${hist}\n\n请抽取需求卡片 JSON。`;
  },
};
