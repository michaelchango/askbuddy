/**
 * M4-0.2 闸门：实测 embedding 模型返回维度 === 1024（R3 不可逆防线）。
 *
 * 建 knowledge_entries（embedding vector(1024)）之前必须跑一次本脚本，确认
 * TokenHub 向量模型实际返回维度与 EMBEDDING_DIMENSIONS（1024）一致，
 * 否则 vector(N) 维度一旦落定不可逆，改维度要重建表。
 *
 * 前置：.env.local 设置 TOKENHUB_API_KEY（+ 可选 TOKENHUB_BASE / EMBED_MODEL）。
 * 运行：npx tsx scripts/poc/embedding-probe.ts
 * 退出码：0 维度 === 1024；1 维度漂移 / 调用失败 / 走了 mock。
 *
 * 【重要】`import "../_env"` 必须在 lib/ai/embedding 之前：ESM 的 import 会提升到
 * 模块体之前执行，若先 import embedding 再 loadEnvConfig，embedding.ts 的模块级
 * 常量（TOKENHUB_API_KEY）会在密钥装载前求值 → 恒为 undefined → 静默走确定性
 * mock → 本脚本会「假通过」（实测已发生过一次）。
 */
import "../_env";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, embedText, embeddingMockActive } from "../../lib/ai/embedding";

async function main(): Promise<void> {
  const sample = "知识复利：同一项目下已确立的业务规则与决策应跨需求复用，避免重复调研。";

  console.log(`[embedding-probe] 期望维度 EMBEDDING_DIMENSIONS = ${EMBEDDING_DIMENSIONS}`);
  console.log(`[embedding-probe] 模型标识 = ${EMBEDDING_MODEL}`);
  console.log(`[embedding-probe] 密钥 = ${process.env.TOKENHUB_API_KEY ? "已配置" : "未配置"}`);

  if (!process.env.TOKENHUB_API_KEY) {
    console.error(
      "[embedding-probe] ✗ 未配置 TOKENHUB_API_KEY，无法实测真实维度。" +
        "请先在 .env.local 配置 TokenHub API Key" +
        "（创建入口：https://console.cloud.tencent.com/tokenhub/apikey）。"
    );
    process.exit(1);
  }

  // 防伪：密钥在、又非 USE_MOCK，才可能走真实 API；否则后面的 1024 维只是 mock。
  if (embeddingMockActive()) {
    console.error(
      "[embedding-probe] ✗ 当前处于 mock 路径（USE_MOCK=true 或密钥未装载到模块）。" +
        "此时返回的 1024 维是确定性伪向量，不能作为维度闸门依据。"
    );
    process.exit(1);
  }

  const vec = await embedText(sample);
  if (!vec) {
    console.error(
      "[embedding-probe] ✗ 调用失败：embedText 返回 null（见上方 [embedding] 日志）。\n" +
        "  常见原因：\n" +
        "   1) TokenHub Key 无效 / 已过期 → HTTP 401；\n" +
        "   2) 模型 ID 写错或未开通 → TokenHub 返回 error；\n" +
        "   3) 网络不通 / 地域地址选错（广州与新加坡不支持跨地域）。"
    );
    process.exit(1);
  }

  if (vec.length !== EMBEDDING_DIMENSIONS) {
    console.error(
      `[embedding-probe] ✗ 维度漂移：期望 ${EMBEDDING_DIMENSIONS}，实际 ${vec.length}。` +
        "禁止建表（R3 不可逆），请先排查 embedding 模型。"
    );
    process.exit(1);
  }

  console.log(`[embedding-probe] ✓ Embedding 返回维度 === ${vec.length}，与 EMBEDDING_DIMENSIONS 一致。`);
  console.log("[embedding-probe] ✓ 可安全执行 db:setup（建 knowledge_entries vector(1024)）。");
  // 抽样打印前 4 维，便于人工复核是「真向量」而非全 0。
  console.log(`[embedding-probe] 抽样前 4 维：${vec.slice(0, 4).map((n) => n.toFixed(5)).join(", ")}`);
}

main();
