// 临时验证：单反引号围栏场景 + 裸引号场景
import { validateMermaidBlocks } from "../lib/utils/markdown";

function show(title: string, bad: string) {
  console.log("=== " + title + " ===");
  const fixed = validateMermaidBlocks(bad);
  console.log("BEFORE:\n" + bad);
  console.log("AFTER:\n" + fixed);
  const triple = (fixed.match(/```mermaid/g) || []).length;
  const single = (fixed.match(/(^|\n)`mermaid(\s|$)/g) || []).length;
  console.log(`-> 三反引号:${triple} 单反引号:${single}\n`);
}

// 场景1：单反引号围栏（本次真实问题）
show(
  "单反引号围栏",
  "## 2. 核心流程\n用户打开页面。\n\n`mermaid\nflowchart TD\n    A[打开 H5 页面] --> B[JS 调用天气 API]\n    B --> C{请求成功?}\n    C -->|是| D[解析]\n`\n\n## 3. 产品架构"
);

// 场景2：三反引号 + 节点英文双引号（历史 sanitize 已处理，验证不破坏）
show(
  "三反引号 + 英文双引号",
  "```mermaid\nflowchart TD\n    A[渲染\"上海 今天 XX℃\"] --> B[完成]\n```"
);

// 场景3：三反引号 + 全角箭头
show(
  "三反引号 + 全角箭头",
  "```mermaid\nflowchart TD\n    A[开始] → B[结束]\n```"
);
