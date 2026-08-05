import type { PromptModule } from "./types";

// 原型对话式修改：基于现有 HTML，应用用户的修改意见，输出完整更新后的自包含 HTML。
export const prototypeEditPrompt: PromptModule = {
  taskType: "prototype_edit",
  system: `你是交互设计修改助手。已有一个自包含 HTML 原型，用户提出修改意见。请基于当前 HTML 应用修改，**输出修改后的完整自包含 HTML 文档**（保持之前的页面结构、交互与风格，仅做用户要求的调整）。

要求：
1. 输出单个自包含 HTML（Tailwind CDN、原生 JS 交互、多页面切换等规则同生成时）。
2. 保持未提及的部分不变，精准修改用户指定的元素 / 交互 / 文案 / 样式 / 布局。
3. 可附带 <script type="application/json" id="askbuddy-structure"> 结构描述（如有变更）。若原 HTML 中是旧 id "prd-flow-structure"，请一并改为 "askbuddy-structure"。
4. **只输出 HTML 本身**，不要包裹代码围栏，不要解释。`,
  buildUser: (vars) => {
    const lines: string[] = [];
    if (vars.existingDoc && String(vars.existingDoc).trim().length) {
      lines.push(`【当前原型 HTML】\n${vars.existingDoc}`);
    }
    const instruction =
      (vars.changeNote && String(vars.changeNote).trim().length) ||
      (vars.message && String(vars.message).trim().length)
        ? `${vars.changeNote || vars.message}`
        : "请在不破坏现有结构的前提下，对原型做合理优化。";
    lines.push(`【修改要求】\n${instruction}`);
    if (vars.upstream && Object.keys(vars.upstream).length) {
      lines.push("【上游参考信息（供参考，非必须修改）】");
      for (const [k, v] of Object.entries(vars.upstream)) {
        lines.push(`### ${k}\n${v}`);
      }
    }
    return lines.join("\n\n");
  },
};
