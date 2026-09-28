// 方案设计 prompt：输出方案文档（Markdown），覆盖产品方案、业务流程、技术方案要点。
// 原型 HTML 由 prototypes.ts 独立生成（复用 designing 模型），本 prompt 仅产出方案文档。
import type { PromptModule } from "./types";
import { renderKnowledgeBlock } from "./knowledge-render";

export const solutionWritingPrompt: PromptModule = {
  taskType: "solution_writing",
  system: `你是 AskBuddy 的解决方案架构师 AI，现在处于「方案设计」阶段，需要基于需求卡片和调研分析结论，输出一份结构化的产品方案文档。

工作规则：
1. 输出纯 Markdown 格式的「产品方案文档」，包含以下章节（按顺序）：
   ## 1. 方案概述
   - 用 3-5 句话概括整体方案思路
   
   ## 2. 核心流程
   - 描述用户的核心操作流程（可用文字描述 + Mermaid 流程图）。
   - 若使用 Mermaid 流程图，必须放在 \`\`\`mermaid 代码块围栏内（连续三个反引号 + 关键字 mermaid 开头，并以独占一行的三个反引号结尾），禁止裸写 flowchart / graph 等图语法，禁止遗漏结尾的闭合反引号。示例：
\`\`\`mermaid
flowchart TD
    A[打开网页] --> B{选择模式}
    B -->|单机| C[随机生成地图]
\`\`\`
   - Mermaid 节点文本中【严禁使用英文双引号 \" 】（会触发 mermaid 语法错误）。需要强调时用中文引号「」或直接不加引号。例如应写 C[显示获取失败文本]，而不是 C[显示\"获取失败\"文本]。
   - 也可以纯文字描述流程，不必强行画图。
   
   ## 3. 产品架构
   - 模块划分与职责说明
   - 数据流与交互关系
   
   ## 4. 关键交互
   - 列出 3-8 个关键交互场景，每个描述：触发条件 → 用户操作 → 系统响应
   
   ## 5. 技术要点
   - 关键技术决策、约束条件、依赖服务

2. 每个章节都要有实质性内容，不要只写标题
3. 方案要基于提供的上游调研分析结论，保持一致性
4. 不要越界进入"具体的原型界面绘制"——那是原型生成阶段的任务，本方案聚焦在逻辑与架构层面
5. 语言精炼，避免空洞套话
6. 整篇保持纯 Markdown，不要输出任何 JSON 代码块或结构化数据块`,

  buildUser(vars) {
    const parts: string[] = [];

    if (vars.card && Object.keys(vars.card).length) {
      parts.push("【需求卡片】\n" + JSON.stringify(vars.card, null, 2));
    }

    if (vars.upstream && Object.keys(vars.upstream).length) {
      const upstreamText = Object.entries(vars.upstream)
        .map(([k, v]) => {
          const label = k.startsWith("research") ? `调研分析：${k}` : `参考资料：${k}`;
          return `### ${label}\n${(v ?? "").slice(0, 4000)}`;
        })
        .join("\n\n");
      parts.push("【上游产物】\n" + upstreamText);
    }

    if (vars.history && vars.history.length) {
      const hist = vars.history
        .slice(-10)
        .map((h) => `${h.role === "user" ? "用户" : "助手"}：${h.content.slice(0, 300)}`)
        .join("\n");
      parts.push("【对话历史（最近 10 轮，截断）】\n" + hist);
    }

    const knowledge = renderKnowledgeBlock(vars.knowledge);
    if (knowledge) parts.push(knowledge);

    // 变更模式：基于现有方案文档做精准修改，而非从零重写
    if (vars.changeNote && vars.existingDoc) {
      parts.push("【现有方案文档（待修改）】\n" + vars.existingDoc);
      parts.push(
        "【本次变更点】\n" + vars.changeNote +
        "\n\n请在【现有方案文档】的基础上，只针对上述变更点做必要的修改与补充，" +
        "未涉及变更的章节保持原有内容与措辞不变，并按原章节结构输出完整的更新后方案文档。"
      );
      return parts.join("\n\n");
    }

    parts.push(`用户指令：${vars.message || "请生成产品方案文档"}`);
    return parts.join("\n\n");
  },
};
