# AskBuddy MCP 接入说明

AskBuddy 内置一个 **MCP（Model Context Protocol）Server**，通过 `stdio` 把需求流程的产出物
（需求卡片、调研分析、可交互原型、PRD 文档）暴露给 Claude / Cursor / 任意支持 MCP 的 AI 编码工具，
让 AI 在写代码时能直接消费「方案设计 → 原型 → PRD」的成果，无需人工复制粘贴。

---

## 1. 工作原理

```
AI 编码工具 (Claude / Cursor)
        │  stdio（MCP 协议）
        ▼
askbuddy-mcp Server (mcp/server.ts)
        │  HTTP + Bearer(PAT)
        ▼
AskBuddy 后端  GET /api/mcp/requirement/{id}...
        │
        ▼
  数据库（需求 / 调研 / 原型 / PRD）
```

- MCP Server 是一个**独立进程**，通过 `stdio` 与客户端通信。
- 它自己并不访问数据库，而是以 HTTP 调用 AskBuddy 后端暴露的 `/api/mcp/*` 只读接口。
- 鉴权使用 **PAT（Personal Access Token）**，作为 `Authorization: Bearer <token>` 传给后端。

---

## 2. 前置条件

1. **AskBuddy 服务端已启动**（本地默认 `http://localhost:3000`，或任意已部署的地址）。
2. **Node.js ≥ 18**（MCP SDK 与 `tsx` 需要）。
3. 你已在 AskBuddy 中完成至少一个需求，并拿到其 `requirementId`。

---

## 3. 获取访问令牌（PAT）

MCP Server 通过 Bearer Token 调用后端接口，需要先创建 PAT：

1. 登录 AskBuddy Web 端。
2. 调用令牌创建接口（或在控制台「访问令牌」页面创建）：

   ```bash
   # 先登录拿到浏览器 Cookie，再请求（该接口依赖会话）
   curl -X POST http://localhost:3000/api/tokens \
     -H "Content-Type: application/json" \
     -d '{"name":"mcp-local"}'
   ```

   返回示例：

   ```json
   { "ok": true, "data": { "id": "tk_xxx", "token": "YOUR_PAT_HERE", "name": "mcp-local" } }
   ```

3. 复制 `data.token` 字段的值（即上一步生成的**完整** PAT），它就是 MCP Server 要用的 `ASKBUDDY_TOKEN`。
   > **注意**：`token` 是一串随机的十六进制字符串（形如 `a1b2c3...f9e8`，共 48 位），**没有固定的前缀**。请整段复制，不要把它当作「某个前缀 + 你的密钥」的格式。
   > 令牌仅在创建时明文返回一次，请妥善保存。

---

## 4. 安装与运行

进入仓库内的 `mcp/` 目录安装依赖：

```bash
cd mcp
npm install
```

直接以源码运行（推荐，无需编译）：

```bash
ASKBUDDY_BASE_URL=http://localhost:3000 \
ASKBUDDY_TOKEN=YOUR_PAT_HERE \
npx tsx server.ts
```

或先编译再运行：

```bash
npm run build      # 产出 dist/
node dist/server.js
```

看到终端输出 `AskBuddy MCP server running on stdio` 即表示启动成功（该进程由 AI 客户端托管，无需手动常驻）。

---

## 5. 客户端接入配置

### 5.1 Claude Desktop

编辑配置文件（macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`；
Windows：`%APPDATA%\Claude\claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "askbuddy": {
      "command": "npx",
      "args": ["tsx", "/绝对路径/AskBuddy/mcp/server.ts"],
      "env": {
        "ASKBUDDY_BASE_URL": "http://localhost:3000",
        "ASKBUDDY_TOKEN": "YOUR_PAT_HERE"
      }
    }
  }
}
```

> 把 `YOUR_PAT_HERE` **整段替换**为你在「访问令牌」页面创建得到的完整 Token（它是一串纯十六进制字符，没有 `pat_` 之类的前缀）。

重启 Claude Desktop 后，在对话中即可看到 `askbuddy` 提供的工具。

### 5.2 Cursor

编辑项目根目录的 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "askbuddy": {
      "command": "npx",
      "args": ["tsx", "/绝对路径/AskBuddy/mcp/server.ts"],
      "env": {
        "ASKBUDDY_BASE_URL": "http://localhost:3000",
        "ASKBUDDY_TOKEN": "YOUR_PAT_HERE"
      }
    }
  }
}
```

> 同样把 `YOUR_PAT_HERE` **整段替换**为你的完整 Token（纯十六进制字符，无前缀）。

在 Cursor 设置 → MCP 中刷新，状态变为 `connected` 即可。

### 5.3 其它 MCP 客户端

只要支持 `stdio` 传输，用相同方式填入：
- `command`: 可运行 `tsx server.ts` 的 Node 入口（建议用 `npx tsx <绝对路径>/server.ts` 或 `node <绝对路径>/dist/server.js`）；
- `env`: 必须包含 `ASKBUDDY_TOKEN`，可选 `ASKBUDDY_BASE_URL`。

---

## 6. 工具清单

所有工具均接收一个参数 `requirementId: string`（需求 ID），返回 JSON 文本。

| 工具名 | 说明 | 后端接口 | 返回结构 |
|--------|------|----------|----------|
| `requirement_get` | 需求基本信息（卡片 + 四步状态） | `GET /api/mcp/requirement/{id}` | `getRequirementWithStatus` 结果（含步骤状态、当前阶段） |
| `requirement_research` | 调研分析结论 | `GET /api/mcp/requirement/{id}/research` | `{ report, userStories, features }` |
| `requirement_prototype` | 可交互 HTML 原型 + 页面结构 | `GET /api/mcp/requirement/{id}/prototype` | `{ version, structure, html }`（`html` 为完整 HTML 字符串） |
| `requirement_prd` | PRD 文档（Markdown） | `GET /api/mcp/requirement/{id}/prd` | `{ version, markdown }` |

> 原型与 PRD 未生成时，对应接口返回 `not_found`，MCP 工具会如实返回错误文本。

---

## 7. 典型用法示例

在接入后的 AI 客户端中，可以直接这样对话：

- “读取需求 `req_abc123` 的 PRD，帮我用 Next.js 实现其中的「个人中心」页面。”
- “根据 `req_abc123` 的原型结构，生成对应的 React 组件骨架。”
- “结合 `req_abc123` 的调研分析功能清单，写一份后端接口设计。”

AI 会自行调用 `requirement_prd` / `requirement_prototype` / `requirement_research` 获取上下文，
再基于真实产出物编写代码，避免凭空臆测需求。

---

## 8. 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `ASKBUDDY_TOKEN` | 是 | 空 | PAT，作为 `Authorization: Bearer` 传给后端。缺失时所有接口返回 401。 |
| `ASKBUDDY_BASE_URL` | 否 | `http://localhost:3000` | AskBuddy 后端地址。部署到远程时改为对应域名（含协议）。 |

---

> **兼容说明**：为便于存量用户平滑迁移，MCP Server 仍会识别历史变量名
> `PRDFLOW_BASE_URL` / `PRDFLOW_TOKEN`（新变量 `ASKBUDDY_*` 优先生效）。
> 该兼容为过渡措施，将在后续版本移除，请尽快改用 `ASKBUDDY_*`。

---

## 9. 常见问题排查

- **工具列表为空 / `connected` 失败**：确认 `npx tsx <路径>/server.ts` 能在终端手动跑通，且依赖已 `npm install`。
- **调用工具返回 401 `unauthorized`**：`ASKBUDDY_TOKEN` 未配置或令牌失效，重新创建 PAT 并更新配置。
- **调用工具返回 404 `not_found`**：该需求尚未生成对应产物（如原型 / PRD 还未确认），请先在 AskBuddy 流程中完成该步骤。
- **读到的是旧内容**：`/api/mcp/*` 为只读实时查询，刷新即可获取最新版本；若仍滞后，确认 AskBuddy 后端进程是同一实例。
- **远程部署场景**：将 `ASKBUDDY_BASE_URL` 指向线上地址，并确保该地址的 `/api/mcp/*` 路由对外可访问、且 PAT 属于同一用户。

---

## 10. 目录结构

```
mcp/
├── server.ts          # MCP Server 入口，注册 4 个 tool（stdio 传输）
├── client.ts          # 平台 HTTP 客户端，封装 callPlatform（携带 PAT）
├── package.json       # 脚本：npm start / npm run build
└── tsconfig.json     # NodeNext 编译配置
```
