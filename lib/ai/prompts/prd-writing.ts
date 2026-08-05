// PRD 生成 prompt：将上游所有产物积累式汇入一份完整的需求文档。
import type { PromptModule } from "./types";

export const prdWritingPrompt: PromptModule = {
  taskType: "prd_writing",
  system: `你是 PrdFlow 的产品文档专家 AI，现在处于「需求文档」阶段，需要将所有上游产物（需求卡片、调研分析、产品方案）汇聚成一份完整、可交付的 PRD（产品需求文档）。

工作规则：
1. 输出纯 Markdown 格式的 PRD 文档，严格按以下章节组织：
   
   ## 1. 概述
   - 需求名称、所属项目、优先级
   - 一句话摘要
   
   ## 2. 背景与依据
   - 业务背景（来源：需求卡片 + 调研分析报告）
   - 用户痛点与调研结论
   - 为什么要做这个需求
   
   ## 3. 目标与范围
   - 核心目标（3-5 条可衡量的目标）
   - 功能范围（做什么 + 不做什么）
   
   ## 4. 用户故事
   - 列出所有用户故事，格式：「作为 <角色>，我希望 <目标>，以便 <收益>」
   - 每条约 1-3 行说明
   
   ## 5. 产品方案
   - 核心流程（来源：方案设计文档）
   - 关键交互说明
   - 产品架构与模块划分
   - 嵌入原型引用（如有）
   
   ## 6. 功能详情
   - 功能清单表格必须使用**标准 Markdown 表格语法**：表头行 + 分隔行（形如 |------|------|...|）+ 每一行数据独占一行（真实换行），禁止把多行挤成同一行。示例：
     | 名称 | 描述 | 优先级 | 所属模块 |
     |------|------|--------|----------|
     | 触控转向优化 | 滑动跟手与防误触区，响应延迟≤50ms | P0 | 操作 |
     | 随机地图生成 | 每局异形大小、形状与障碍布局，种子化保证联机一致性 | P0 | 玩法 |
   - 每个 P0/P1 功能附简要验收标准（可在表格后补充）。

   ## 7. 非功能需求
   - 性能指标、安全要求、兼容性、可用性
   
   ## 8. 约束与依赖
   - 技术约束、外部依赖、风险项

2. 每个章节必须包含实质性内容；如果上游未提供对应信息，标注「（待补充）」而非编造
3. 语言专业、精炼，面向产品经理和开发团队
4. 保持与上游产物的一致性，不引入矛盾信息
5. 整份 PRD 应该可以直接交付评审，无需再追加补充
6. 整篇保持纯 Markdown，不要输出任何 JSON 代码块或结构化数据块`,

  buildUser(vars) {
    const parts: string[] = [];

    if (vars.card && Object.keys(vars.card).length) {
      parts.push("【需求卡片】\n" + JSON.stringify(vars.card, null, 2));
    }

    if (vars.upstream && Object.keys(vars.upstream).length) {
      const upstreamText = Object.entries(vars.upstream)
        .map(([k, v]) => {
          const label = k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
          return `### ${label}\n${(v ?? "").slice(0, 6000)}`;
        })
        .join("\n\n");
      parts.push("【上游产物汇总】\n" + upstreamText);
    }

    if (vars.history && vars.history.length) {
      const hist = vars.history
        .slice(-15)
        .map((h) => `${h.role === "user" ? "用户" : "助手"}：${h.content.slice(0, 300)}`)
        .join("\n");
      parts.push("【对话历史（最近 15 轮，截断）】\n" + hist);
    }

    // 变更模式：基于现有 PRD 做精准修改，而非从零重写
    if (vars.changeNote && vars.existingDoc) {
      parts.push("【现有 PRD（待修改）】\n" + vars.existingDoc);
      parts.push(
        "【本次变更点】\n" + vars.changeNote +
        "\n\n请在【现有 PRD】的基础上，只针对上述变更点做必要的修改与补充，" +
        "未涉及变更的章节保持原有内容与措辞不变，并按原章节结构输出完整的更新后 PRD。"
      );
      return parts.join("\n\n");
    }

    parts.push(`用户指令：${vars.message || "请基于所有上游产物生成完整 PRD"}`);
    return parts.join("\n\n");
  },
};
