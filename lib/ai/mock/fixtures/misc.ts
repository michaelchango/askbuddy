// 其余任务的 mock 占位夹具（M5-D3）。
//
// 这些任务在 e2e 场景 03（导出五格式）/ 05（MCP 冒烟）里只需要「非空、可解析」，
// 不参与逐字节断言；因此统一走一个确定性占位模板，而不是每个任务编一份假内容。

import { hashTag } from "../hash";
import type { AITaskType } from "../../models";

/** 方案文档：Markdown 正文 + 一份结构 JSON（供原型/DevContext 上游消费）。 */
export function solutionFixture(seed: string): string {
  const tag = hashTag(seed);
  return `## 方案概述

（示例）单页原型 + 本地存储，零后端依赖。〔mock-${tag}〕

## 交互流程

1. 打开页面 → 直接进入主界面
2. 主操作区响应单指滑动
3. 结束展示结果与分享入口

\`\`\`json
{
  "structure": {
    "pages": [
      {
        "name": "主界面",
        "components": [
          {"id":"c1","type":"canvas","role":"游戏画布"},
          {"id":"c2","type":"button","role":"开始"},
          {"id":"c3","type":"text","role":"实时排名"}
        ]
      }
    ]
  }
}
\`\`\``;
}

/** PRD：Markdown 长文骨架（导出与 MCP 场景用）。 */
export function prdFixture(seed: string): string {
  const tag = hashTag(seed);
  return `# 需求文档（示例）

## 1. 背景与目标

（示例）提供零门槛的轻量记录体验。〔mock-${tag}〕

## 2. 功能范围

- 灵感速记
- 标签归类

## 3. 验收标准

- 保存后立即可见于时间线
`;
}

/** 原型：完整 HTML（includeHtml=true 时才会被 MCP 返回）。 */
export function prototypeFixture(seed: string): string {
  const tag = hashTag(seed);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><title>原型（示例）</title></head>
<body>
  <main id="app" data-mock="${tag}">
    <h1>原型（示例）</h1>
    <button type="button">开始</button>
  </main>
</body>
</html>`;
}

/** 标题概括：单行短文本（不带 JSON，title 任务就是这么用的）。 */
export function titleFixture(userMessage: string): string {
  return userMessage.replace(/\s+/g, " ").trim().slice(0, 18) || "未命名需求";
}

/** 知识沉淀抽取：JSON 数组（knowledge_extract 任务）。 */
export function knowledgeExtractFixture(seed: string): string {
  const tag = hashTag(seed);
  return `\`\`\`json
[
  {
    "title": "分页统一使用游标",
    "content": "列表类接口统一使用游标分页，避免 offset 深翻页性能问题。〔mock-${tag}〕",
    "category": "rule"
  }
]
\`\`\``;
}

/** 需要「有内容但不必真实」的其余任务：统一占位。 */
export function genericFixture(taskType: AITaskType, seed: string): string {
  const tag = hashTag(seed);
  return `[MOCK:${taskType}:${tag}] 占位输出。`;
}
