// 调研分析报告 → Markdown 的纯函数渲染（服务端 / 客户端共用，单一真源）。
// 不依赖 db 或任何服务端/客户端专属模块，确保前端打包安全。
export interface ResearchAnalysisRow {
  report?: string;
  user_stories?: unknown[];
  features?: unknown[];
}

// 将调研分析结构化数据渲染为最终存档 / 预览使用的 Markdown。
// 报告正文在前，随后是两个小节（用户故事 / 功能清单），与最终文档格式一致。
export function buildResearchAnalysisMarkdown(row: ResearchAnalysisRow): string {
  const lines: string[] = [];

  if (row.report) {
    lines.push(row.report, "");
  } else {
    lines.push("# 调研分析", "");
  }

  const stories = Array.isArray(row.user_stories) ? row.user_stories : [];
  if (stories.length) {
    lines.push("## 用户故事", "");
    for (const s of stories) {
      const o = s as Record<string, unknown>;
      lines.push(`- 作为${o.role ?? "用户"}，我希望${o.goal ?? ""}${o.reason ? `，以便${o.reason}` : ""}`);
    }
    lines.push("");
  }

  const features = Array.isArray(row.features) ? row.features : [];
  if (features.length) {
    lines.push("## 功能清单", "");
    for (const f of features) {
      const o = f as Record<string, unknown>;
      lines.push(`- **${o.name ?? "功能"}**：${o.desc ?? ""}${o.priority ? `（${o.priority}）` : ""}`);
    }
    lines.push("");
  }

  if (!stories.length && !features.length && !row.report) {
    lines.push("_暂无调研分析内容。_");
  }

  return lines.join("\n");
}
