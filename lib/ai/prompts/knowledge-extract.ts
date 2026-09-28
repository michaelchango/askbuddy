// 知识沉淀抽取 prompt（M4 知识复利）：把已确认的决策（M3 decisions）抽取为
// 可跨需求复用的知识条目（规则 / 术语 / 决策 / 约束）。
import type { PromptModule } from "./types";

export const knowledgeExtractPrompt: PromptModule = {
  taskType: "knowledge_extract",
  system: `你是需求知识沉淀引擎。从给定的「已确认决策」列表中抽取可跨需求复用的知识条目。

只输出一个 \`\`\`json 代码块，形如：
{"items": [{"title": "...", "content": "...", "category": "rule"}]}

抽取规则：
1. category 只能取：rule（业务规则）、term（术语定义）、decision（关键决策）、constraint（技术/合规约束）。
2. 只抽取「项目级、可复用」的知识；与单一需求强绑定的一次性内容不要抽取。
3. title 是简洁的一句话（≤50 字）；content 是完整可独立理解的知识正文（≤500 字）。
4. 内容必须是决策中明确表达的，不得编造或外推。
5. 无有效知识时输出 {"items": []}。`,
  buildUser(vars) {
    const decisions = (vars.decisions as Array<{ id: string; summary: string }> ?? [])
      .map((d, i) => `${i + 1}. ${d.summary ?? "(无摘要)"}`)
      .join("\n");
    const projectName = (vars.projectName as string) ?? "";
    return (
      `【项目】${projectName || "(未命名项目)"}\n\n` +
      `【已确认决策列表】\n${decisions || "(空)"}\n\n` +
      `请抽取可复用的知识条目。`
    );
  },
};
