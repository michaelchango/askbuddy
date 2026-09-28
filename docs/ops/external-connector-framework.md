# 外部连接器框架（轻量自研，不引入 cordis）

> 状态：规划方案（未实现）。落地点见 `待办事项.md` →「三、3.1 外部工具连接器」。
> 决策背景：评估过引入 cordis 做 MCP 热插拔，结论是当前阶段（自有工具链、内部迭代）不引入，用一套轻量自研框架覆盖「AI 反向调外部工具（Figma / 各类 skill / 外部 MCP）」的需求。若未来要做第三方插件平台，再迁移到 cordis（接口稳定后仅需改 registry 一个文件）。

## 一、需求拆解

「内部向外连」本质是 4 件事，不需要 IOC 容器：

1. **注册**：一个外部工具（Figma / Linear / 某 skill / 某下游 MCP server）以「适配器」形式登记进来。
2. **发现**：运行时能列出当前可用工具及其能力描述（给 AI 当 tool schema 用）。
3. **调用**：AI 选中工具后，参数透传执行并拿回结果。
4. **热插拔**：不重启 MCP server 进程即可加/减适配器（目录扫描 + 配置驱动）。

cordis 的 `Plugin`/`Service` 能覆盖这些，但其中「共享有状态 Service」当前用不上（外部调用都是无状态 `fetch`/stdio）。自研一个 `Map` 注册表即可等价替代。

## 二、目录结构（落地点）

```
lib/ai/connectors/external/
├── types.ts            # ExternalAdapter 接口 + AdapterCtx
├── registry.ts         # 注册表（热插拔核心，对应 cordis 容器）
├── index.ts            # 统一出口 + 启动时 auto-register
├── adapters/           # 各外部工具适配器（新增一个 = 加一个文件）
│   ├── figma.ts        # 示例
│   └── ...
```

> 注意：现在 `lib/ai/connectors/types.ts` 里已有 `Connector`（含 `kind: "internal" | "external"`）。新方案**不直接复用**那个抽象——它签名是 `execute(input): Promise<void>`（无返回值、面向「写回平台」），与「外部工具调用需要返回结果给 AI」语义不同。外部适配器用独立的 `ExternalAdapter` 接口，避免污染 internal 路径。

## 三、核心代码（约 150 行）

### 3.1 `external/types.ts`

```typescript
import type { z } from "zod";

export interface ExternalToolSpec {
  name: string;            // "figma", "linear"
  description: string;     // 给 AI 看的能力描述
  inputSchema: z.ZodType;  // 参数校验（zod）
}

export interface AdapterCtx {
  requirementId: string;
  // 未来可加：platform client、日志、知识库引用等
}

export interface ExternalAdapter {
  spec: ExternalToolSpec;
  execute(args: unknown, ctx: AdapterCtx): Promise<unknown>;
}
```

### 3.2 `external/registry.ts`（热插拔核心）

```typescript
import type { ExternalAdapter, ExternalToolSpec, AdapterCtx } from "./types";

const adapters = new Map<string, ExternalAdapter>();

export function registerAdapter(a: ExternalAdapter): void {
  adapters.set(a.spec.name, a);
}

export function clearAdapters(): void {
  adapters.clear();
}

export function listAdapters(): ExternalToolSpec[] {
  return [...adapters.values()].map((a) => a.spec);
}

export async function runAdapter(
  name: string,
  args: unknown,
  ctx: AdapterCtx
): Promise<unknown> {
  const a = adapters.get(name);
  if (!a) throw new Error(`未知外部工具: ${name}`);
  const parsed = a.spec.inputSchema.parse(args); // zod 校验
  return a.execute(parsed, ctx);
}
```

### 3.3 `external/index.ts`（统一出口 + auto-register）

```typescript
export * from "./types";
export * from "./registry";

// 启动时自动注册内置适配器
import "./adapters/figma";
// import "./adapters/linear"; // 后续新增时加一行
```

### 3.4 改造 `mcp/server.ts`（挂一个通用 tool）

```typescript
import { listAdapters, runAdapter } from "../lib/ai/connectors/external";

// 把当前所有适配器声明为 AI 可见的 tool
for (const spec of listAdapters()) {
  server.tool(
    `external_${spec.name}`,
    spec.description,
    { args: spec.inputSchema },
    async ({ args }, extra) => {
      const result = await runAdapter(spec.name, args, {
        requirementId: extra.requirementId,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );
}
```

> 若希望「单一通用 tool」而非「每个适配器一个 tool」，可只挂一个 `call_external_tool`（`{ name: z.string(), args: z.any() }`），内部 `runAdapter`。两种都行，按 AI 调用习惯选；单 tool 更灵活但要 AI 自己拼 name。

### 3.5 示例：`adapters/figma.ts`（约 40 行）

```typescript
import { z } from "zod";
import { registerAdapter, type ExternalAdapter } from "../registry";

const figmaAdapter: ExternalAdapter = {
  spec: {
    name: "figma",
    description: "读取 Figma 文件 / 组件定义",
    inputSchema: z.object({
      fileKey: z.string(),
      nodeId: z.string().optional(),
    }),
  },
  async execute(args, ctx) {
    const res = await fetch(
      `https://api.figma.com/v1/files/${args.fileKey}`,
      { headers: { "X-Figma-Token": process.env.FIGMA_TOKEN! } }
    );
    if (!res.ok) throw new Error(`Figma API ${res.status}`);
    return res.json();
  },
};

registerAdapter(figmaAdapter);
```

## 四、热插拔实现

MCP server 是长驻 `tsx` 进程（`mcp/server.ts`）。热插拔两种可选方案：

- **方案 A（推荐，配置驱动）**：维护 `mcp/adapters.config.ts`（或 `.json`），列出启用哪些适配器；`index.ts` 改为「读配置 → 动态 `import()` 对应模块」。改配置后触发 reload（定时轮询 / `fs.watch` 配置目录）重建 Map。`clearAdapters()` + 重新 import 即可。
- **方案 B（目录扫描）**：`fs.readdir("adapters/")` 自动 import 所有 `*.ts`。零配置但难禁用单个适配器。

当前阶段用方案 A 即可，简单可控。

## 五、与「外部 MCP server」对接

部分外部工具本身就是独立 MCP server（如 `npx @some/mcp`）。可在 `adapters/` 里写一个「MCP 桥接适配器」：内部用 `@modelcontextprotocol/sdk` 的 client 连上那个 server，把它的 tool 列表映射成 `ExternalToolSpec`，调用时转发。这样「第三方 MCP」和「自己写的 fetch 适配器」在 `ExternalAdapter` 接口下统一。

## 六、迁移到 cordis 的退路

若未来要做「第三方开发者装插件」的平台级需求，迁移成本极低：

- `ExternalAdapter` 接口保持不变；
- 仅把 `registry.ts` 的 `Map` 换成 cordis `ApplicationContext` + `ctx.plugin()` 动态加载；
- `mcp/server.ts` 的挂载逻辑改用 cordis 容器取服务。

届时 cordis 的 `Plugin`/`Service`/`Inject` 才真正发挥价值（沙箱隔离、插件间依赖注入、生命周期钩子）。

## 七、落地检查清单

- [ ] 新建 `lib/ai/connectors/external/{types,registry,index}.ts`
- [ ] 写 `adapters/figma.ts` 打通端到端（验证业务价值）
- [ ] 改 `mcp/server.ts` 挂外部 tool
- [ ] 加 `mcp/adapters.config.ts` 做配置驱动热插拔
- [ ] 补一个 `external/registry.test.ts`（register / list / run / 未知工具报错）
- [ ] （可选）MCP 桥接适配器，接一个真实第三方 MCP server
