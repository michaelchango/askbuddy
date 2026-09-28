// 确定性 Mock Provider（M5-D3）。
//
// 【确定性三铁律】（由 tests/unit/ai-provider.spec.ts 守护，含夹具源码静态扫描）
//   1. 禁用 Math.random() / Date.now() / new Date() / crypto.randomUUID()：
//      需要「随机」时用输入内容的 FNV-1a 哈希取模（lib/ai/mock/hash.ts）；
//   2. 同一 (taskType, messages) 输入 → **逐字节相同**的输出；
//   3. 时间戳一律用固定值 MOCK_TIMESTAMP（不用 new Date()）。
//
// 【场景注入】读 AI_MOCK_SCENARIO，或识别用户消息中的 `[[scenario:xxx]]` 标记。
// 供 e2e 精确驱动分支（如「让 DevContext 故意缺 data_structures」验证完整度与 draft）。
//
// 【流式】固定 8 字符切片（与改造前 mockStream 一致）；延迟由 AI_MOCK_DELAY_MS 控制，
// e2e 设 0。

import type { AIProvider, GenerateOptions, GenerateResult } from "../provider";
import { mockTextFor } from "../mock/fixtures";

const DEFAULT_CHUNK_SIZE = 8;
const DEFAULT_DELAY_MS = 12;

/** 场景解析：环境变量优先，其次用户消息里的 `[[scenario:xxx]]` 标记。 */
export function resolveMockScenario(messages: Array<{ role: string; content: string }>): string {
  const env = (process.env.AI_MOCK_SCENARIO ?? "").trim();
  if (env) return env;
  const joined = messages.map((m) => m.content).join("\n");
  const m = joined.match(/\[\[scenario:([a-z0-9-]+)\]\]/i);
  return m ? m[1].toLowerCase() : "";
}

/** 去掉场景标记，避免它污染夹具输出（标记本身不该出现在产物里）。 */
function stripScenarioMarkers(messages: GenerateOptions["messages"]): GenerateOptions["messages"] {
  return messages.map((m) => ({
    ...m,
    content: m.content.replace(/\[\[scenario:[a-z0-9-]+\]\]/gi, ""),
  }));
}

function delayMs(): number {
  const raw = process.env.AI_MOCK_DELAY_MS;
  if (raw === undefined || raw === "") return DEFAULT_DELAY_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DELAY_MS;
}

export const mockProvider: AIProvider = {
  id: "mock",

  // mock 永远「可配置」——这是「本地无凭据也能全链路联调」的兜底实现。
  isConfigured(): boolean {
    return true;
  },

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const scenario = resolveMockScenario(opts.messages);
    const content = mockTextFor(
      opts.taskType ?? "dialoguing",
      stripScenarioMarkers(opts.messages),
      scenario
    );
    return { model: opts.model, content, provider: "mock" };
  },

  async *stream(opts: GenerateOptions): AsyncIterable<string> {
    const scenario = resolveMockScenario(opts.messages);
    const text = mockTextFor(
      opts.taskType ?? "dialoguing",
      stripScenarioMarkers(opts.messages),
      scenario
    );
    const chunks = text.match(/[\s\S]{1,8}/g) ?? [text];
    for (const c of chunks) {
      // 用户主动停止：mock 模式下也响应中断，与真实模型的 signal 行为一致
      if (opts.signal?.aborted) return;
      const wait = delayMs();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      yield c;
    }
  },
};
