// 场景 05：MCP 冒烟（M5-D5）。
//
// 这个场景**不开浏览器**，而是 spawn 真正的 MCP server 子进程，走 stdio 的
// JSON-RPC 打一遍工具清单与几个代表性工具调用。它盯的是「AI 编码工具看到的接口」
// 这一层 —— 页面全绿但 MCP 返回 500，是很容易漏掉的一类故障。
//
// 用 node 直接跑 tsx 的入口（不走 `npx tsx`）：Node 22+ 在 Windows 上 spawn `.cmd`
// 会抛 EINVAL（安全修复），而把参数交给 cmd 解析又会踩引号坑。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { introspect, seed, sendMessage } from "./fixtures/seed";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100";

/** 最小 stdio JSON-RPC 客户端（换行分隔，MCP 的 stdio 传输格式）。 */
class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private pending = new Map<number, (v: unknown) => void>();
  /** 非请求类消息（服务端日志/通知）累积在这里，失败时打出来便于定位。 */
  readonly stderr: string[] = [];

  constructor(env: Record<string, string>) {
    const tsxCli = path.join("node_modules", "tsx", "dist", "cli.mjs");
    this.child = spawn(process.execPath, [tsxCli, "mcp/server.ts"], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      const lines = this.buf.split("\n");
      this.buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const msg = JSON.parse(trimmed) as {
            id?: number;
            result?: unknown;
            error?: unknown;
          };
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            // 把 JSON-RPC error 也回给调用方：否则工具级失败会表现成「结果为空」，
            // 断言报错信息会指向完全无关的地方（这个坑调试过一次）
            this.pending.get(msg.id)!(msg.error ? { __mcpError: msg.error } : msg.result);
            this.pending.delete(msg.id);
          }
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (c: string) => this.stderr.push(c));
  }

  private send(payload: unknown): void {
    this.child.stdin.write(JSON.stringify(payload) + "\n");
  }

  /** 发请求并等回复。 */
  async call(method: string, params: unknown, id: number, timeoutMs = 60_000): Promise<unknown> {
    const p = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} 超时；stderr=${this.stderr.join("").slice(0, 500)}`));
      }, timeoutMs);
      this.pending.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return p;
  }

  notify(method: string): void {
    this.send({ jsonrpc: "2.0", method });
  }

  kill(): void {
    this.child.kill();
  }
}

/** 从 tools/call 结果里取出文本载荷并解析（工具统一返回 JSON 文本）。 */
function textPayload(result: unknown): unknown {
  const r = result as { content?: Array<{ type: string; text: string }> };
  const text = r.content?.map((c) => c.text).join("") ?? "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

test.describe("场景 05 · MCP 冒烟", () => {
  let client: McpClient | null = null;

  test.afterEach(() => {
    client?.kill();
    client = null;
  });

  test("工具清单 = 13 个；代表性工具与 stale 感知均正常", async ({ request }) => {
    const { requirementId, projectId, token } = await seed(request, "full-flow", {
      withToken: true,
    });
    const rid = requirementId as string;
    expect(token, "seed 必须签发 PAT（MCP 用 Bearer 鉴权）").toBeTruthy();

    client = new McpClient({
      ASKBUDDY_BASE_URL: BASE_URL,
      ASKBUDDY_TOKEN: token as string,
    });

    // ---------- initialize ----------
    await client.call(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "e2e", version: "1.0.0" },
      },
      1
    );
    client.notify("notifications/initialized");

    // ---------- tools/list：恰好 13 个（增删工具必须是有意识的改动） ----------
    const list = (await client.call("tools/list", {}, 2)) as {
      tools: Array<{ name: string }>;
    };
    const names = list.tools.map((t) => t.name).sort();
    expect(names.length, `工具数应为 13，实际：${names.join(",")}`).toBe(13);
    for (const required of [
      "list_projects",
      "list_requirements",
      "requirement_get",
      "requirement_solution",
      "requirement_prototype",
      "requirement_dev_context",
      "dev_context_business_rules",
      "dev_context_data_structures",
      "dev_context_api_specs",
      "dev_context_acceptance_criteria",
      "search_knowledge",
    ]) {
      expect(names, `缺少工具：${required}`).toContain(required);
    }

    // ---------- list_projects / list_requirements：含 seed 数据 ----------
    const projects = textPayload(await client.call("tools/call", {
      name: "list_projects",
      arguments: {},
    }, 3));
    expect(JSON.stringify(projects)).toContain(projectId);

    const reqs = textPayload(await client.call("tools/call", {
      name: "list_requirements",
      arguments: { projectId },
    }, 31));
    expect(JSON.stringify(reqs)).toContain(rid);

    // ---------- requirement_dev_context：通过 schema + 带 _meta ----------
    const dc = textPayload(await client.call("tools/call", {
      name: "requirement_dev_context",
      arguments: { requirementId: rid },
    }, 4)) as { content?: Record<string, unknown>; _meta?: Record<string, unknown> };
    expect(dc.content, "DevContext 内容不应为空").toBeTruthy();
    expect(Object.keys(dc.content as object).length).toBeGreaterThan(5);
    expect(dc._meta).toBeTruthy();

    // ---------- requirement_prototype：默认不带 HTML（上下文窗口保护） ----------
    const proto = textPayload(await client.call("tools/call", {
      name: "requirement_prototype",
      arguments: { requirementId: rid },
    }, 5)) as Record<string, unknown>;
    expect(JSON.stringify(proto)).not.toContain("<!DOCTYPE html");
    expect(proto.structure, "轻量返回也必须带页面结构").toBeTruthy();

    // 显式要求时才返回 HTML
    const protoFull = textPayload(await client.call("tools/call", {
      name: "requirement_prototype",
      arguments: { requirementId: rid, includeHtml: true },
    }, 51)) as { html?: string };
    expect(protoFull.html ?? "").toContain("<!DOCTYPE html");

    // ---------- 分段工具：只返回对应段 ----------
    const rules = textPayload(await client.call("tools/call", {
      name: "dev_context_business_rules",
      arguments: { requirementId: rid },
    }, 6)) as { section?: string; content?: unknown };
    expect(rules.section).toBe("business_rules");
    expect(rules.content).toBeTruthy();

    // ---------- search_knowledge：返回数组（M4） ----------
    const knowledge = textPayload(await client.call("tools/call", {
      name: "search_knowledge",
      arguments: { projectId, query: "分页", topK: 3 },
    }, 7)) as { results?: unknown[] };
    // 注意：MCP 的 callPlatform 会**拆掉 `{ok,data}` 外层**（mcp/client.ts:return json.data），
    // 所以工具载荷就是 data 本身，没有 .data 再套一层。
    expect(Array.isArray(knowledge.results)).toBe(true);

    // ---------- stale 感知：先制造一次变更，再取 DevContext ----------
    await sendMessage(request, rid, "把保留期从 30 天改成 90 天");
    const stale = textPayload(await client.call("tools/call", {
      name: "requirement_dev_context",
      arguments: { requirementId: rid },
    }, 8)) as { _meta?: { maybe_stale?: boolean; warning?: string; stale_sections?: string[] } };
    const meta = stale._meta;
    expect(meta, "MCP 返回体必须带 _meta").toBeTruthy();
    expect(meta?.maybe_stale).toBe(true);
    expect((meta?.warning ?? "").length).toBeGreaterThan(0);
    expect((meta?.warning ?? "")).toContain("尚未重算");
    expect((meta?.stale_sections ?? []).length).toBeGreaterThan(0);
  });
});
