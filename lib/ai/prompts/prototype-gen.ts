import type { PromptModule } from "./types";
import { renderKnowledgeBlock } from "./knowledge-render";

// 原型生成：输出单个自包含、可交互的高保真 HTML 原型（多页面 + 页面间跳转）。
export const prototypeGenPrompt: PromptModule = {
  taskType: "prototype_gen",
  system: `你是资深交互设计师与前端工程师。根据用户需求、调研结论与产品方案，生成一个**可交互的高保真 HTML 原型**。

硬性要求：
1. 输出**单个自包含 HTML 文档**：根标签为 <html>，包含完整 <head> 与 <body>。
2. 样式使用 Tailwind CSS CDN：<script src="https://cdn.tailwindcss.com"></script>。允许用内联 <style> 补充动画/特殊样式。禁止引用其它外部资源（图片可用占位 SVG / emoji / data URI）。
3. **交互可用**：用原生 JavaScript 实现按钮点击、表单输入、页面切换、弹窗、Tab 等真实交互；不要用死图或假按钮。
4. **多页面**：若产品存在多个核心页面（如首页 / 列表 / 详情 / 设置），在同一 HTML 内用容器切换的方式实现页面间跳转（顶部或侧边导航 + JS 切换显示），并标注每个页面名称。
5. 中文文案；结构清晰、视觉美观、贴近真实产品；移动端优先（适配窄屏）。
6. 可在 <body> 末尾附一个隐藏的结构描述，供系统解析（可选但推荐）：
   <script type="application/json" id="askbuddy-structure">{ "pages": [{"id":"home","title":"首页"},{"id":"detail","title":"详情页"}] }</script>
7. **只输出 HTML 本身**，不要包裹在 \`\`\`html 代码围栏中，不要输出任何解释性文字。`,
  buildUser: (vars) => {
    const lines: string[] = [];
    if (vars.card && Object.keys(vars.card).length) {
      lines.push(`【需求卡片】\n${JSON.stringify(vars.card, null, 2)}`);
    }
    if (vars.upstream && Object.keys(vars.upstream).length) {
      lines.push("【上游参考信息】");
      for (const [k, v] of Object.entries(vars.upstream)) {
        lines.push(`### ${k}\n${v}`);
      }
    }
    const knowledge = renderKnowledgeBlock(vars.knowledge);
    if (knowledge) lines.push(knowledge);
    const instruction =
      vars.message && String(vars.message).trim().length
        ? `额外要求：${vars.message}`
        : "请据此生成完整的可交互原型（覆盖核心页面与关键交互）。";
    lines.push(`【任务】\n${instruction}`);
    return lines.join("\n\n");
  },
};
