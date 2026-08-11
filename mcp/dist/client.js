// AskBuddy 平台 HTTP 客户端：MCP Server 通过它调用 AskBuddy 后端 API（携带 PAT）。
//
// 环境变量兼容：新变量 ASKBUDDY_* 优先，回落到历史别名 PRDFLOW_*。
// 用户本地 MCP 客户端配置（Claude Desktop / CodeBuddy 的 mcp.json）不会随代码库一起更新，
// 直接改名会让存量用户的 MCP 静默连不上后端，故过渡期双读，待 T5 复查时再移除旧别名。
const BASE = (process.env.ASKBUDDY_BASE_URL ??
    process.env.PRDFLOW_BASE_URL ??
    "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.ASKBUDDY_TOKEN ?? process.env.PRDFLOW_TOKEN ?? "";
export async function callPlatform(path) {
    const url = `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await fetch(url, {
        headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`AskBuddy API ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    const json = (await res.json());
    if (json && json.ok === false) {
        throw new Error(json.error || "AskBuddy API error");
    }
    return json.data;
}
