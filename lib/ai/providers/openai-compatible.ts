// OpenAI 兼容 Provider（M5-D3，可选后端）。
//
// 存在的意义：**没有第二个真实 provider，抽象层就只是一个空壳**。
// 选 OpenAI 兼容协议是因为它是事实标准（DeepSeek / TokenHub / 多数网关都兼容），
// 一个实现覆盖面最广。
//
// 用原生 fetch 而非 SDK：不为一个可选后端引入新依赖。
// 环境变量：AI_OPENAI_BASE_URL（形如 https://api.deepseek.com/v1）、AI_OPENAI_API_KEY。

import type { AIProvider, GenerateOptions, GenerateResult } from "../provider";
import type { ChatMessage } from "../types";

function baseUrl(): string {
  return (process.env.AI_OPENAI_BASE_URL ?? "").trim().replace(/\/+$/, "");
}

function apiKey(): string {
  return (process.env.AI_OPENAI_API_KEY ?? "").trim();
}

interface ChatCompletionChunk {
  choices?: Array<{
    message?: { content?: string };
    delta?: { content?: string };
  }>;
  error?: { message?: string };
}

async function postChat(
  opts: GenerateOptions,
  stream: boolean
): Promise<Response> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    // 把状态码与响应体一起抛出：classifyAIError 依赖状态码分类
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI 兼容接口返回 ${res.status}：${text.slice(0, 300)}`);
  }
  return res;
}

export const openaiCompatibleProvider: AIProvider = {
  id: "openai-compatible",

  isConfigured(): boolean {
    return Boolean(baseUrl() && apiKey());
  },

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const res = await postChat(opts, false);
    const data = (await res.json()) as ChatCompletionChunk;
    if (data.error?.message) throw new Error(data.error.message);
    const content = data.choices?.[0]?.message?.content ?? "";
    return { model: opts.model, content, provider: "openai-compatible" };
  },

  async *stream(opts: GenerateOptions): AsyncIterable<string> {
    const res = await postChat(opts, true);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("OpenAI 兼容接口没有响应体（无法流式读取）");
    const decoder = new TextDecoder();
    let buf = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue; // 忽略 event:/空行/注释
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const chunk = JSON.parse(payload) as ChatCompletionChunk;
          if (chunk.error?.message) throw new Error(chunk.error.message);
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch (e) {
          // 单行解析失败不该打断整条流（网关偶尔会插入心跳）；但 error 字段要抛
          if (e instanceof Error && !/JSON/.test(e.message)) throw e;
        }
      }
      if (opts.signal?.aborted) return;
    }
  },
};

/** 供测试构造确定性请求体（不触发网络）。 */
export const __openaiInternals = { baseUrl, apiKey };
export type { ChatMessage };
