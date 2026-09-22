// Embedding 接入层（M4 知识复利）。
//
// 【接入方式】腾讯 TokenHub，OpenAI 兼容协议：
//   POST https://tokenhub.tencentmaas.com/v1/embeddings
//   Authorization: Bearer $TOKENHUB_API_KEY
//   { model: "kinfra-text-embedding-0.6b", input: [...] , encoding_format: "float" }
//
// 【历史】曾直连 hunyuan.tencentcloudapi.com 的 GetEmbedding（自签 TC3-HMAC-SHA256）。
// 该路径因账号未开通 embedding 服务（FailedOperation.ServiceNotActivated）而不可用，
// 且自签协议维护成本高，故 2026-09 整体切到 TokenHub。旧 TC3 实现已删除；
// 若未来需要回退，可从 git 历史取回。
//
// 【为什么不用 CloudBase SDK】@cloudbase/node-sdk 的 AI 服务只提供 createModel（文本）
// + createImageModel（图像），没有 embedding 接口。
//
// 【密钥分离（M4 总原则之一）】生成模型走 CLOUDBASE_SECRET（CloudBase 环境密钥），
// embedding 走独立的 TOKENHUB_API_KEY。两者分离：即便 embedding 密钥泄露，攻击者
// 也只能「读语义」而无法伪造生成内容；反之生成密钥泄露也无法污染知识库向量。

import crypto from "crypto";
import { USE_MOCK } from "@/lib/cloudbase";

/**
 * 向量维度（不可逆，R3 红线）。与 db/schema.sql 的 vector(1024)、
 * db/drizzle/schema.ts 的 vector("embedding", { dimensions: 1024 }) 强绑定。
 *
 * 该值由模型能力决定、不支持自定义：`kinfra-text-embedding-0.6b` 固定输出 1024 维，
 * 已由 scripts/poc/embedding-probe.ts 对真实 API 实测确认。换模型前必须先跑该探针。
 */
export const EMBEDDING_DIMENSIONS = 1024;

/** 当前 embedding 模型标识（随请求发送，也用于日志/文档）。 */
export const EMBEDDING_MODEL =
  process.env.EMBED_MODEL || process.env.EMBEDDING_MODEL || "kinfra-text-embedding-0.6b";

// ---------------------------------------------------------------------------
// 配置与降级
// ---------------------------------------------------------------------------

const TOKENHUB_BASE =
  process.env.TOKENHUB_BASE || "https://tokenhub.tencentmaas.com/v1";
const TOKENHUB_API_KEY = process.env.TOKENHUB_API_KEY;

/** 是否可用真实 embedding：非 mock 且具备 TokenHub 密钥。 */
function embeddingConfigured(): boolean {
  return !USE_MOCK && Boolean(TOKENHUB_API_KEY);
}

/**
 * 当前是否处于「非真实 API」路径（mock 或未配置密钥）。
 *
 * 【为什么导出】给闸门脚本（scripts/poc/embedding-probe.ts）做人证：
 * 该脚本曾因「ESM import 提升 → loadEnvConfig 晚于模块求值」而拿到空密钥，
 * 于是恒走确定性 mock，却打印出「✓ 维度 1024」的假通过。有了这个出口，
 * 闸门可以断言「本次不是 mock」，避免再次自欺。
 */
export function embeddingMockActive(): boolean {
  return USE_MOCK || !embeddingConfigured();
}

// ---------------------------------------------------------------------------
// TTL 冷却（失败后冷却 60s，避免打爆接口又永久卡死）
// ---------------------------------------------------------------------------

let _coolingUntil = 0;
const COOLDOWN_MS = 60_000;

function inCooldown(): boolean {
  return Date.now() < _coolingUntil;
}

function enterCooldown(): void {
  _coolingUntil = Date.now() + COOLDOWN_MS;
}

// ---------------------------------------------------------------------------
// 确定性 mock（无密钥联调用：对文本做 sha256 哈希，展开成 1024 维伪向量）
// ---------------------------------------------------------------------------

function deterministicVector(text: string): number[] {
  const hex = crypto.createHash("sha256").update(text).digest("hex");
  const out = new Array<number>(EMBEDDING_DIMENSIONS);
  // 用 64 个 hex 字符循环展开到 1024 维，再归一化（近似单位向量）。
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    const c = hex.charCodeAt(i % hex.length);
    out[i] = ((c - 48) / 79) * 2 - 1; // 映射到 [-1, 1]
  }
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

// ---------------------------------------------------------------------------
// TokenHub 调用
// ---------------------------------------------------------------------------

/**
 * 调用 TokenHub embeddings 接口。返回与输入等长的数组（按 input 顺序对齐），
 * 维度须 === EMBEDDING_DIMENSIONS；任何错误返回 null（不抛）。
 *
 * 响应（OpenAI 兼容）：
 *   { object:"list", data:[{ object:"embedding", index, embedding:number[] }],
 *     model, usage:{ prompt_tokens, total_tokens, ... } }
 */
async function callTokenHubEmbedding(inputs: string[]): Promise<number[][] | null> {
  if (!TOKENHUB_API_KEY) return null;

  try {
    const payload = JSON.stringify({
      model: EMBEDDING_MODEL,
      input: inputs,
      encoding_format: "float",
    });

    const res = await fetch(`${TOKENHUB_BASE}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKENHUB_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: payload,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[embedding] TokenHub HTTP ${res.status}: ${text.slice(0, 300)}`);
      return null;
    }

    const data = (await res.json()) as {
      data?: Array<{ index?: number; embedding?: number[] }>;
      error?: { code?: string; message?: string };
    };

    if (data.error) {
      console.error(`[embedding] TokenHub 错误：${data.error.code} ${data.error.message}`);
      return null;
    }

    // 按 index 排序对齐到 inputs 顺序；维度不对的位保持空数组，由调用方过滤。
    const sorted = (data.data ?? [])
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const out: number[][] = new Array(inputs.length).fill([]);
    let valid = 0;
    for (let i = 0; i < sorted.length && i < inputs.length; i++) {
      const v = sorted[i].embedding ?? [];
      if (v.length === EMBEDDING_DIMENSIONS) {
        out[i] = v;
        valid++;
      }
    }
    if (valid === 0) return null;
    return out;
  } catch (e) {
    console.error(`[embedding] TokenHub 异常：${(e as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 对外公共 API
// ---------------------------------------------------------------------------

/**
 * 计算一条文本的 embedding。失败返回 null（调用方降级为关键词检索）。
 * 维度硬校验：返回非 1024 维直接丢弃（防维度漂移污染库）。
 */
export async function embedText(text: string): Promise<number[] | null> {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;

  if (!embeddingConfigured() || inCooldown()) {
    // mock 或未配置或冷却中：走确定性伪向量，保证「无密钥也能联调」且维度一致。
    return USE_MOCK || !embeddingConfigured() ? deterministicVector(trimmed) : null;
  }

  try {
    const result = await callTokenHubEmbedding([trimmed]);
    if (!result || result[0] === undefined) {
      enterCooldown();
      return null;
    }
    const vec = result[0];
    if (vec.length !== EMBEDDING_DIMENSIONS) {
      console.error(
        `[embedding] 维度漂移：期望 ${EMBEDDING_DIMENSIONS}，实际 ${vec.length}。已拒绝入库。`
      );
      enterCooldown();
      return null;
    }
    return vec;
  } catch (e) {
    console.error(`[embedding] 调用异常：${(e as Error).message}`);
    enterCooldown();
    return null;
  }
}

/**
 * 批量计算 embedding（逐条，失败位填 null，不因单条失败中断整体）。
 * 返回与输入等长的数组，元素为 number[] | null。
 */
export async function embedTexts(texts: string[]): Promise<Array<number[] | null>> {
  const trimmed = texts.map((t) => (t || "").trim());
  if (!embeddingConfigured() || inCooldown()) {
    return trimmed.map((t) =>
      t && (USE_MOCK || !embeddingConfigured()) ? deterministicVector(t) : null
    );
  }

  const out: Array<number[] | null> = new Array(texts.length).fill(null);
  try {
    const nonEmpty = trimmed.filter(Boolean);
    if (nonEmpty.length === 0) return out;
    const result = await callTokenHubEmbedding(nonEmpty);
    if (!result) {
      enterCooldown();
      return out;
    }
    let idx = 0;
    for (let i = 0; i < trimmed.length; i++) {
      if (!trimmed[i]) continue;
      const vec = result[idx++];
      if (vec && vec.length === EMBEDDING_DIMENSIONS) out[i] = vec;
    }
    return out;
  } catch (e) {
    console.error(`[embedding] 批量调用异常：${(e as Error).message}`);
    enterCooldown();
    return out;
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * number[] → PG vector 字面量字符串 '[0.1,0.2,...]'。
 * 供 service 层拼 SQL 或构造向量参数使用（cloudbase/postgres 后端会自动补 ::vector）。
 */
export function vectorToLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** 真实 embedding 当前是否可用（已配置且不在冷却中）。 */
export function isEmbeddingReady(): boolean {
  return embeddingConfigured() && !inCooldown();
}