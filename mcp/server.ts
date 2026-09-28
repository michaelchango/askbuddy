// AskBuddy MCP Server (v2)
// 通过 stdio 暴露 AskBuddy 产物给 Claude / Cursor / CodeBuddy 等 MCP 客户端。
// 配置：ASKBUDDY_BASE_URL（默认 http://localhost:3000）、ASKBUDDY_TOKEN（PAT）。
// 兼容：历史别名 PRDFLOW_BASE_URL / PRDFLOW_TOKEN 仍被识别（见 mcp/client.ts）。
//
// v2 新增：list_projects / list_requirements / requirement_solution /
// requirement_dev_context + 4 个 dev_context_* 分段工具 / search_knowledge 占位；
// requirement_research 改走 outputs 统一口径返回 Markdown；
// requirement_prototype 默认轻量（不含 HTML），includeHtml=true 才返回 HTML；
// requirement_prd 支持 ?version= 读取历史版本。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { callPlatform } from "./client.js";

const server = new McpServer({ name: "askbuddy", version: "2.0.0" });

// ---------- 项目 / 需求导航 ----------

server.tool(
  "list_projects",
  "列出当前 PAT 所属用户的所有项目（id / name / status 等）",
  {},
  async () => {
    const data = await callPlatform(`/api/mcp/projects`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "list_requirements",
  "列出某项目下的需求（id / title / status）。需传入 projectId。",
  { projectId: z.string().describe("项目 ID") },
  async ({ projectId }) => {
    const data = await callPlatform(`/api/mcp/projects/${projectId}/requirements`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "requirement_get",
  "获取 AskBuddy 需求的基本信息（需求卡片与步骤状态）",
  { requirementId: z.string().describe("需求 ID") },
  async ({ requirementId }) => {
    const data = await callPlatform(`/api/mcp/requirement/${requirementId}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ---------- 各产物（与需求流程四步对应） ----------

server.tool(
  "requirement_research",
  "获取 AskBuddy 需求的调研分析结论（Markdown，含报告 / 用户故事 / 功能清单）",
  { requirementId: z.string().describe("需求 ID") },
  async ({ requirementId }) => {
    const data = await callPlatform(`/api/mcp/requirement/${requirementId}/research`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "requirement_solution",
  "获取 AskBuddy 需求的方案设计文档（Markdown）",
  { requirementId: z.string().describe("需求 ID") },
  async ({ requirementId }) => {
    const data = await callPlatform(`/api/mcp/requirement/${requirementId}/solution`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "requirement_prototype",
  "获取 AskBuddy 需求的可交互 HTML 原型（含页面结构 JSON）。默认返回完整 HTML。",
  { requirementId: z.string().describe("需求 ID") },
  async ({ requirementId }) => {
    const data = await callPlatform(`/api/mcp/requirement/${requirementId}/prototype?includeHtml=true`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "requirement_prd",
  "获取 AskBuddy 需求的 PRD 文档（Markdown）。可传 version 读取指定历史版本。",
  {
    requirementId: z.string().describe("需求 ID"),
    version: z.number().optional().describe("历史版本号，缺省读最新"),
  },
  async ({ requirementId, version }) => {
    const qs = version != null ? `?version=${version}` : "";
    const data = await callPlatform(`/api/mcp/requirement/${requirementId}/prd${qs}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ---------- DevContext（M2 新增，与 PRD 同源并列产出） ----------

server.tool(
  "requirement_dev_context",
  "获取 AskBuddy 需求的整套「开发上下文」DevContext（完整 JSON，含 16 个内容 section、评分与溯源）。供 AI 编码工具直接消费。",
  { requirementId: z.string().describe("需求 ID") },
  async ({ requirementId }) => {
    const data = await callPlatform(`/api/mcp/requirement/${requirementId}/dev-context`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// 4 个分段工具共享 dev-context?section= 路由，降低单次负载、便于按需取用。
server.tool(
  "dev_context_business_rules",
  "仅取 DevContext 的「业务规则」段（BR-xxx 编号列表，含形式化 when/then 与优先级）。",
  { requirementId: z.string().describe("需求 ID") },
  async ({ requirementId }) => {
    const data = await callPlatform(`/api/mcp/requirement/${requirementId}/dev-context?section=business_rules`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "dev_context_data_structures",
  "仅取 DevContext 的「数据模型」段（entities 实体字段定义与关系）。",
  { requirementId: z.string().describe("需求 ID") },
  async ({ requirementId }) => {
    const data = await callPlatform(`/api/mcp/requirement/${requirementId}/dev-context?section=data_structures`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "dev_context_api_specs",
  "仅取 DevContext 的「接口规范」段（REST / 事件接口定义，对应 api_requirements section）。",
  { requirementId: z.string().describe("需求 ID") },
  async ({ requirementId }) => {
    const data = await callPlatform(`/api/mcp/requirement/${requirementId}/dev-context?section=api_requirements`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "dev_context_acceptance_criteria",
  "仅取 DevContext 的「验收标准」段（AC-xxx 编号列表，Given/When/Then 格式，可映射到业务规则）。",
  { requirementId: z.string().describe("需求 ID") },
  async ({ requirementId }) => {
    const data = await callPlatform(`/api/mcp/requirement/${requirementId}/dev-context?section=acceptance_criteria`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ---------- 知识库（M4 知识复利） ----------

server.tool(
  "search_knowledge",
  "在 AskBuddy 项目知识库中语义检索已沉淀的知识条目（业务规则/术语/决策/约束）。需传入 projectId 与 query。",
  {
    projectId: z.string().describe("项目 ID"),
    query: z.string().describe("检索查询（语义检索，可自然语言）"),
    topK: z.number().int().min(1).max(20).optional().describe("返回条数，默认 8"),
  },
  async ({ projectId, query, topK }) => {
    const data = await callPlatform(`/api/mcp/knowledge/search`, {
      method: "POST",
      body: { projectId, query, topK: topK ?? 8 },
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("AskBuddy MCP server running on stdio");
