// PrdFlow MCP Server
// 通过 stdio 暴露 PrdFlow 产物给 Claude / Cursor / 其它 MCP 客户端。
// 配置：PRDFLOW_BASE_URL（默认 http://localhost:3000）、PRDFLOW_TOKEN（PAT）。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { callPlatform } from "./client.js";

const server = new McpServer({ name: "prdflow", version: "1.0.0" });

server.tool(
  "requirement_get",
  "获取 PrdFlow 需求的基本信息（需求卡片与步骤状态）",
  { requirementId: z.string().describe("需求 ID") },
  async ({ requirementId }) => {
    const data = await callPlatform(`/api/mcp/requirement/${requirementId}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "requirement_research",
  "获取 PrdFlow 需求的调研分析结论（报告、用户故事、功能清单）",
  { requirementId: z.string().describe("需求 ID") },
  async ({ requirementId }) => {
    const data = await callPlatform(`/api/mcp/requirement/${requirementId}/research`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "requirement_prototype",
  "获取 PrdFlow 需求的可交互 HTML 原型（含页面结构 JSON）",
  { requirementId: z.string().describe("需求 ID") },
  async ({ requirementId }) => {
    const data = await callPlatform(`/api/mcp/requirement/${requirementId}/prototype`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "requirement_prd",
  "获取 PrdFlow 需求的 PRD 文档（Markdown 文本）",
  { requirementId: z.string().describe("需求 ID") },
  async ({ requirementId }) => {
    const data = await callPlatform(`/api/mcp/requirement/${requirementId}/prd`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("PrdFlow MCP server running on stdio");
