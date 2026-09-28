// CloudBase Provider（默认后端，M5-D3）。
//
// 自 lib/ai/client.ts 原样迁入真实模式代码（streamToText / realGenerate / realStream），
// 只做两件事：包成 AIProvider、把「按 taskType 选模型」换成「用调用方给的 model」。
//
// ⚠️ **模型降级（DEGRADE 表）刻意不迁进来**：降级是「任务级」策略
// （designing 失败退到 research_analysis 的模型），与 provider 无关；
// 放进 provider 会导致每个 provider 都要复制一份，且换后端时降级规则会跟着漂移。
// 它留在 lib/ai/client.ts 的编排层。

import { getCloudAI } from "@/lib/cloudbase/app";
import type { AIProvider, GenerateOptions, GenerateResult } from "../provider";
import type { ChatMessage } from "../types";

// 通过流式 textStream 聚合文本：思考模型的推理链由 SDK 单独处理，textStream 仅返回最终答案，
// 避免 generateText().text 把 <think> 思考链混入正文（标题/PRD 等生成结果）。
async function streamToText(
  modelName: string,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<string> {
  const ai = getCloudAI();
  const model = ai.createModel("cloudbase");
  const res = await model.streamText({
    model: modelName,
    messages,
    ...(signal ? { signal } : {}),
  });
  let text = "";
  for await (const chunk of res.textStream) {
    if (chunk) text += chunk;
  }
  return text;
}

export const cloudbaseProvider: AIProvider = {
  id: "cloudbase",

  isConfigured(): boolean {
    return Boolean(process.env.CLOUDBASE_ENV_ID && process.env.CLOUDBASE_SECRET);
  },

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const content = await streamToText(opts.model, opts.messages, opts.signal);
    return { model: opts.model, content, provider: "cloudbase" };
  },

  async *stream(opts: GenerateOptions): AsyncIterable<string> {
    const ai = getCloudAI();
    const model = ai.createModel("cloudbase");
    const res = await model.streamText({
      model: opts.model,
      messages: opts.messages,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    for await (const chunk of res.textStream) {
      // 用户主动终止（客户端断开 / 点终止按钮）：立即停止向流里写入，
      // 使上游 reader 循环提前收到 done，已累积的 full 即为「终止时」的文档内容。
      if (opts.signal?.aborted) break;
      if (chunk) yield chunk;
    }
  },
};
