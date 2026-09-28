// AI Provider 抽象（M5-D3）：让 LLM 后端可替换，而不改动任何业务代码。
//
// 【为什么不返回 null 让调用方处理】PRDHub 的 AI 出口只有 lib/ai/client.ts 一个，
// 降级逻辑应当在这一层收敛干净；若 resolveProvider 返回 null，每个调用点都要
// 重写一遍「没配置就走 mock」的判断。
//
// 【保留 signal】D6 决定不做异步任务表，长任务仍走同步 SSE；留出取消能力，
// M6 复查 T3 时不必改接口。
//
// 明确不引入 Vercel AI SDK（技术选型）：cloudbase provider 走 @cloudbase/node-sdk，
// openai-compatible 走原生 fetch。
import type { AIResult, ChatMessage } from "./types";
import type { AITaskType } from "./models";
import { cloudbaseProvider } from "./providers/cloudbase";
import { openaiCompatibleProvider } from "./providers/openai-compatible";
import { mockProvider } from "./providers/mock";

export type ProviderId = "cloudbase" | "openai-compatible" | "mock";

export interface GenerateOptions {
  /** 模型名，由 lib/ai/models.ts 的路由表给出，禁止在 provider 内再选一次。 */
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 取消信号（SSE 客户端断开 / 超时 abort）。 */
  signal?: AbortSignal;
  /**
   * 任务类型（M5 追加）。
   *
   * 【为什么需要】mock provider 要按任务选夹具，而 `model` 无法反查任务——
   * `hy3-preview` 同时服务 designing / prd_writing / devcontext / prototype_gen。
   * 用「读 prompt 特征」来猜任务会让 10 个任务里的大多数退化成同一个占位输出，
   * 于是所有依赖 mock 的断言都会失去判别力（D4/D5 的全部验收都建立在这上面）。
   *
   * 真实 provider 忽略本字段；`callAI`/`streamAI` 的对外签名不受影响。
   */
  taskType?: AITaskType;
}

export interface GenerateResult extends AIResult {
  provider: ProviderId;
  /** 是否发生了 preview→hy3 之类的模型降级（由编排层置位）。 */
  degraded?: boolean;
  /** 实际尝试次数（可观测性）。 */
  attempts?: number;
}

export interface AIProvider {
  readonly id: ProviderId;
  /** 是否具备运行条件（env/凭据齐备）。false 时 resolveProvider 会回落 mock。 */
  isConfigured(): boolean;
  generate(opts: GenerateOptions): Promise<GenerateResult>;
  stream(opts: GenerateOptions): AsyncIterable<string>;
}

/** AI 是否强制走 mock：AI_MOCK 优先，其次整体 USE_MOCK。 */
export function aiUseMock(): boolean {
  if (process.env.AI_MOCK === "true") return true;
  if (process.env.USE_MOCK === "true") return true;
  return false;
}

/** 已配置（可运行）的 provider 列表，供诊断与日志。 */
export function getConfiguredProviders(): ProviderId[] {
  return ALL_PROVIDER_IDS.filter((id) => isProviderConfigured(id));
}

export function isProviderConfigured(id: ProviderId): boolean {
  return PROVIDER_FACTORY(id).isConfigured();
}

const ALL_PROVIDER_IDS: ProviderId[] = ["cloudbase", "openai-compatible", "mock"];

/**
 * Provider 选择顺序（前者命中即返回）：
 *   1. AI_MOCK=true 或 USE_MOCK=true              → mock
 *   2. AI_PROVIDER 指定且 isConfigured()           → 该 provider
 *   3. cloudbase（默认，保留已打通链路）
 *   4. 以上均未配置                                → mock（保证无 Key 时全链路可联调）
 *
 * 第 4 条是刻意的：宁可跑 mock 也不要让「没配 Key」变成运行时崩溃——
 * 本地开发与 CI 都不配任何真实凭据（见 tests/setup/unit.ts）。
 */
export function resolveProvider(): AIProvider {
  if (aiUseMock()) return PROVIDER_FACTORY("mock");

  const explicit = (process.env.AI_PROVIDER ?? "").trim() as ProviderId | "";
  if (explicit && ALL_PROVIDER_IDS.includes(explicit)) {
    const p = PROVIDER_FACTORY(explicit);
    if (p.isConfigured()) return p;
  }

  const cloudbase = PROVIDER_FACTORY("cloudbase");
  if (cloudbase.isConfigured()) return cloudbase;

  return PROVIDER_FACTORY("mock");
}

/**
 * 具体 provider 的分发。
 *
 * 用静态 import 而非 `require`：本仓库是 Next.js + TS（ESM），`require` 在运行时
 * 解析不了 TS 模块路径。带来的副作用是「import provider.ts 即引入
 * @cloudbase/node-sdk」，但这不是新增负担——改造前 `lib/ai/client.ts` 已经静态
 * import 了 `@/lib/cloudbase/app`（同一个 SDK）。真正的「无凭据可跑」保障来自
 * 第 4 条回落 mock，而不是靠不加载 SDK。
 */
function PROVIDER_FACTORY(id: ProviderId): AIProvider {
  switch (id) {
    case "cloudbase":
      return cloudbaseProvider;
    case "openai-compatible":
      return openaiCompatibleProvider;
    case "mock":
    default:
      return mockProvider;
  }
}
