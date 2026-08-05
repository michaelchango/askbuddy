// 变更点分析 prompt：识别用户的修改请求会影响哪些输出物，列出具体变更点。
import type { PromptModule } from "./types";

export const changeAnalysisPrompt: PromptModule = {
  taskType: "dialoguing", // 复用 dialoguing 模型（轻量、弱思考）
  system: `你是 PrdFlow 的产品经理 AI 助手。用户提出了一个修改点，你的任务是分析这个修改会影响哪些输出物。

工作规则：
1. 分析用户的修改意图，判断会影响以下哪些输出物（可多选）：
   - card：需求卡片（背景、目标用户、痛点、范围、非功能需求、约束）
   - research_analysis：调研分析（调研报告、用户故事、功能清单）
   - design：方案设计（方案文档、交互原型）
   - prd：需求文档（PRD markdown）
2. 如果修改点只影响需求卡片本身的某个字段，就标 card；如果影响后续产物，也标记对应产物。
3. 输出一个 JSON 代码块，包含以下字段：
   - affectedOutputs: string[] — 受影响的输出物类型数组
   - changes: Array<{output: string, field: string, description: string}> — 具体变更点列表
   - summary: string — 变更点的自然语言总结（一段话）

示例输出格式：
\`\`\`json
{
  "affectedOutputs": ["card", "research_analysis"],
  "changes": [
    {"output": "card", "field": "scope", "description": "功能范围从XX改为XX"},
    {"output": "research_analysis", "field": "features", "description": "功能清单需要重新推导"}
  ],
  "summary": "修改点主要影响需求范围和功能清单，需要同步更新需求卡片和调研分析。"
}
\`\`\`

4. 不要输出其他内容，只输出上述 JSON 代码块。
5. 如果修改点很模糊无法判断，保守标 affectedOutputs: ["card"]，让后续流程决定。`,
  buildUser(vars) {
    const parts: string[] = [];

    if (vars.card && Object.keys(vars.card).length) {
      parts.push("【当前需求卡片】\n" + JSON.stringify(vars.card, null, 2));
    }

    if (vars.history && vars.history.length) {
      const hist = vars.history
        .slice(-10)
        .map((h) => `${h.role === "user" ? "用户" : "助手"}：${h.content.slice(0, 200)}`)
        .join("\n");
      parts.push("【对话历史（最近 10 轮）】\n" + hist);
    }

    parts.push(`【用户修改请求】\n${vars.message}`);
    parts.push("请分析这个修改会影响哪些输出物，列出具体变更点。");

    return parts.join("\n\n");
  },
};
