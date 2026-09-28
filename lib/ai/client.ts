// AI 调用管理层（M5-D3 起改为**编排层**）。
//
// 【签名冻结】`callAI(taskType, messages, signal?)` / `streamAI(taskType, messages, signal?)`
// 的签名与返回类型与改造前**一字不改**——这是整个 D3 风险可控的根本：
// 业务引用点（card.ts / change-analyzer.ts / lib/ai/steps/* / orchestrator）全部无需改动。
//
// 内部流程：resolveProvider() → withRetry(provider.generate) → 失败则查 DEGRADE 表
// 换模型再试一轮 → 仍失败抛 classifyAIError 的结果（AICallError）。
//
// 三件事刻意留在本层而不下沉到 provider：
//   1. **模型降级**：DEGRADE 是任务级策略，与后端无关；
//   2. **重试**：所有后端共用的调用策略；
//   3. **结构化日志**：单行 JSON，可 grep 可聚合（顺手给 M0 遗留的裸 console.log 立个正例）。
import { AI_TASK_MODEL, type AITaskType } from "./models";
import type { AIResult, ChatMessage } from "./types";
import { resolveProvider } from "./provider";
import { AICallError, classifyAIError, isRetryableAIError, withRetry } from "./retry";

// 降级映射：preview 失败时回退到 hy3，保证核心生成不中断。
const DEGRADE: Partial<Record<AITaskType, AITaskType>> = {
  designing: "research_analysis",
  prd_writing: "research_analysis",
};

function pickModel(taskType: AITaskType): string {
  return AI_TASK_MODEL[taskType];
}

interface CallLog {
  taskType: AITaskType;
  provider: string;
  model: string;
  attempts: number;
  degraded: boolean;
  durationMs: number;
  ok: boolean;
  error?: string;
}

/**
 * 结构化单行日志。
 * `AI_CALL_LOG=0` 可关闭（单测与 e2e 里几百次调用会淹没断言输出；
 * 生产默认开启，单行 JSON 可 grep 可聚合）。
 */
function logCall(entry: CallLog): void {
  if (process.env.AI_CALL_LOG === "0") return;
  console.log(JSON.stringify({ event: "ai_call", ...entry }));
}

// ---------- 非流式：callAI ----------

export async function callAI(
  taskType: AITaskType,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<AIResult> {
  const provider = resolveProvider();
  const started = Date.now();
  let attempts = 0;
  let degraded = false;
  let model = pickModel(taskType);

  const run = (m: string) =>
    withRetry<AIResult>(
      (attempt) => {
        attempts = attempt;
        return provider.generate({ model: m, messages, signal, taskType });
      },
      { signal }
    );

  try {
    const res = await run(model);
    logCall({
      taskType,
      provider: provider.id,
      model: res.model,
      attempts,
      degraded,
      durationMs: Date.now() - started,
      ok: true,
    });
    return { model: res.model, content: res.content };
  } catch (firstErr) {
    const alt = DEGRADE[taskType];
    if (alt && !signal?.aborted) {
      try {
        const altModel = pickModel(alt);
        const res = await run(altModel);
        degraded = true;
        model = altModel;
        logCall({
          taskType,
          provider: provider.id,
          model: res.model,
          attempts,
          degraded: true,
          durationMs: Date.now() - started,
          ok: true,
        });
        return { model: res.model, content: res.content };
      } catch (secondErr) {
        throw throwClassified(secondErr, taskType, provider.id, model, attempts, started);
      }
    }
    throw throwClassified(firstErr, taskType, provider.id, model, attempts, started);
  }
}

function throwClassified(
  e: unknown,
  taskType: AITaskType,
  providerId: string,
  model: string,
  attempts: number,
  started: number
): AICallError {
  const c = classifyAIError(e);
  logCall({
    taskType,
    provider: providerId,
    model,
    attempts,
    degraded: false,
    durationMs: Date.now() - started,
    ok: false,
    error: c.code,
  });
  return new AICallError(c);
}

// ---------- 流式：streamAI ----------

/**
 * 边生成边产出文本块的生成器，带「一次模型降级」。
 *
 * ⚠️ 已经吐出过内容就**不再**换模型续写：半截文档 + 另一模型的后半截
 * 比直接失败更糟（用户拿到一份语法自洽、语义断裂的产物）。
 */
async function* iterateWithDegrade(
  taskType: AITaskType,
  messages: ChatMessage[],
  signal?: AbortSignal
): AsyncGenerator<string> {
  const provider = resolveProvider();
  const models = [pickModel(taskType)];
  const alt = DEGRADE[taskType];
  if (alt) models.push(pickModel(alt));

  let lastErr: unknown;
  for (let i = 0; i < models.length; i++) {
    let emitted = false;
    try {
      for await (const chunk of provider.stream({
        model: models[i],
        messages,
        signal,
        taskType,
      })) {
        emitted = true;
        yield chunk;
      }
      return;
    } catch (e) {
      lastErr = e;
      const canFallback =
        !emitted && i < models.length - 1 && isRetryableAIError(e) && !signal?.aborted;
      if (!canFallback) break;
      console.log(
        JSON.stringify({
          event: "ai_call",
          taskType,
          provider: provider.id,
          model: models[i],
          ok: false,
          degraded: true,
          error: "stream_fallback",
        })
      );
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// 流式生成：返回文本块流（ReadableStream<string>），供 SSE 边生成边推送。
export function streamAI(
  taskType: AITaskType,
  messages: ChatMessage[],
  signal?: AbortSignal
): ReadableStream<string> {
  const gen = iterateWithDegrade(taskType, messages, signal);
  return new ReadableStream<string>({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (e) {
        controller.error(e);
      }
    },
  });
}
