/**
 * 验证脚本公共库。
 *
 * embedForVerify：优先取真实混元向量；若真实 embedding 不可用（服务未开通 / 密钥缺失 /
 * 网络失败），退化为**确定性合成向量**，并在返回值中标注来源。
 *
 * 【为什么要标注来源】合成向量与真实语义无关，只能用来验证「向量读写 / 余弦计算 /
 * 闸门逻辑」这类与语义质量无关的部分。若不标注，就会出现「拿 mock 当真实 API 通过」
 * 的假阳性（本项目已实际发生过一次）。
 */
import { embedText, EMBEDDING_DIMENSIONS } from "@/lib/ai/embedding";
import crypto from "node:crypto";

let warned = false;

/** 与 lib/ai/embedding.ts 的 deterministicVector 同构（仅用于验证脚本本地兜底）。 */
function syntheticVector(text: string): number[] {
  const hex = crypto.createHash("sha256").update(text).digest("hex");
  const out = new Array<number>(EMBEDDING_DIMENSIONS);
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    out[i] = ((hex.charCodeAt(i % hex.length) - 48) / 79) * 2 - 1;
  }
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

export async function embedForVerify(
  text: string
): Promise<{ vec: number[] | null; source: "real" | "synthetic" }> {
  const real = await embedText(text);
  if (real && real.length === EMBEDDING_DIMENSIONS) return { vec: real, source: "real" };

  if (!warned) {
    warned = true;
    console.warn(
      "⚠ [verify] 真实 embedding 不可用（见上方 [embedding] 日志）→ 本脚本改用**合成向量**，" +
        "仅验证向量管道与业务逻辑，不代表真实语义质量。"
    );
  }
  return { vec: syntheticVector(text), source: "synthetic" };
}
