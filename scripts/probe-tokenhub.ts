/**
 * TokenHub 向量接口探针（一次性，不动生产代码）。
 *
 * 用法（凭据不入文件，只走环境变量）：
 *   $env:TOKENHUB_API_KEY="sk-..."
 *   $env:TOKENHUB_EMBED_MODEL="kinfra-text-embedding-0.6b"   # 可省，默认值
 *   npx tsx scripts/probe-tokenhub.ts
 */
const BASE = process.env.TOKENHUB_BASE ?? "https://tokenhub.tencentmaas.com/v1";
const KEY = process.env.TOKENHUB_API_KEY ?? "";
const MODEL = process.env.TOKENHUB_EMBED_MODEL ?? "kinfra-text-embedding-0.6b";

if (!KEY) {
  console.error("✗ 缺少 TOKENHUB_API_KEY（设环境变量后再运行）。");
  process.exit(2);
}
console.log(`[probe] BASE=${BASE}  MODEL=${MODEL}  KEY=${KEY.slice(0, 6)}…${KEY.slice(-4)}`);

async function main() {
  // 1) 凭据通：列模型
  const r0 = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  console.log(`[probe] GET /models  HTTP ${r0.status}`);
  if (r0.ok) {
    const j = (await r0.json()) as { data?: Array<{ id: string; name?: string }> };
    const hit = (j.data ?? []).find((m) => m.id === MODEL);
    console.log(`[probe] /models 中 ${MODEL} 存在 = ${!!hit}` +
      (hit ? ` (name=${hit.name})` : "") + ` | 共 ${j.data?.length ?? 0} 个模型`);
  } else {
    console.log(`[probe] /models 鉴权失败 body=${(await r0.text()).slice(0, 200)}`);
  }

  // 2) 单条 embedding
  const payload = JSON.stringify({ model: MODEL, input: "游标分页规范如何落地？", encoding_format: "float" });
  const r1 = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: payload,
  });
  const text = await r1.text();
  console.log(`[probe] POST /embeddings (1 条) HTTP ${r1.status}`);
  if (!r1.ok) {
    console.log(`[probe] body=${text.slice(0, 300)}`);
    process.exit(1);
  }
  const j = JSON.parse(text);
  const v0: number[] = j.data?.[0]?.embedding ?? [];
  const dim = v0.length;
  console.log(`[probe] 向量维度 = ${dim} | 模型实际返回 = ${j.model} | usage = ${JSON.stringify(j.usage)}`);
  console.log(`[probe] 前 4 维：${v0.slice(0, 4).map((n) => n.toFixed(5)).join(", ")}`);
  console.log(`[probe] 首尾两维度差异：min=${Math.min(...v0).toFixed(4)} max=${Math.max(...v0).toFixed(4)}`);

  // 3) 批量：同输入两次，验证稳定性（理想情况下向量应近似一致）
  const payload2 = JSON.stringify({ model: MODEL, input: ["游标分页规范如何落地？", "用户数据禁止物理删除"], encoding_format: "float" });
  const r2 = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: payload2,
  });
  const j2 = JSON.parse(await r2.text());
  const vList: number[][] = j2.data?.map((d: any) => d.embedding as number[]) ?? [];
  console.log(`[probe] 批量返回条数 = ${vList.length} | 维度 = ${vList.map((v) => v.length).join(",")} | HTTP ${r2.status}`);
  // 与单条结果对比第 1 条
  function cos(a: number[], b: number[]) {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return d / (Math.sqrt(na) * Math.sqrt(nb));
  }
  if (vList[0] && v0.length === vList[0].length) {
    const sim = cos(v0, vList[0]);
    console.log(`[probe] 单条 vs 批量[0]（同输入）余弦相似度 = ${sim.toFixed(6)}`);
  }
  // 第 2 条 vs 第 1 条（不同输入）
  if (vList[0] && vList[1]) {
    const sim = cos(vList[0], vList[1]);
    console.log(`[probe] 批量[0] vs 批量[1]（不同输入）余弦相似度 = ${sim.toFixed(6)}`);
  }
}

main().catch((e) => { console.error("[probe] 异常", e); process.exit(1); });