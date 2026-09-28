// 变更分析 mock 夹具（M5-D3）。
//
// 这个夹具的存在意义是让 Phase 4 的变更链路可被精确驱动，因此它必须做两件事：
//   1. 从 prompt 里读**候选窗口**（真实 prompt 会把候选清单写进去）——这样
//      「LLM 越窗口返回」与「路由兜底过滤」两条路径都能被测到；
//   2. 无修改意图时返回空数组（锁死 prompt 规则 1 的行为：不许保守地标 card）。

import { hashTag } from "../hash";

/** prompt 里定位候选窗口的那一行（见 change-analyzer.ts 的 systemPrompt）。 */
const CANDIDATE_LINE = /候选窗口）只有：([^\n]+)/;

/** 从 prompt 解析候选输出物清单。 */
export function parseCandidates(systemPrompt: string): string[] {
  const m = systemPrompt.match(CANDIDATE_LINE);
  if (!m) return [];
  const out: string[] = [];
  const re = /([a-z_]+)（/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(m[1])) !== null) out.push(hit[1]);
  return out;
}

/** 是否含「修改意图」关键词（与 prompt 规则 1 的判据保持一致）。 */
const CHANGE_INTENT =
  /改|新增|调整|去掉|删除|换成|补充|修改|变更|更新|替换|增加|减少|支持|优化|拆分|合并/;

export function changeAnalysisFixture(
  systemPrompt: string,
  userMessage: string,
  scenario: string
): string {
  const candidates = parseCandidates(systemPrompt);
  const tag = hashTag(`${systemPrompt}\u0000${userMessage}`);

  // 场景驱动（e2e / 单测用来精确命中分支）
  if (scenario === "no-change") {
    return json({ affectedOutputs: [], changes: [], summary: "未检测到修改意图。" });
  }
  if (scenario === "over-window") {
    // 故意返回窗口外的 prd，验证路由侧的候选窗口兜底过滤确实生效
    return json({
      affectedOutputs: ["card", "prd"],
      changes: [{ output: "card", field: "scope", description: `越窗口用例〔mock-${tag}〕` }],
      summary: "越窗口用例：故意列出未生成的输出物。",
    });
  }
  if (scenario === "change-request") {
    return json({
      affectedOutputs: candidates,
      changes: candidates.map((o) => ({
        output: o,
        field: o === "card" ? "scope" : "content",
        description: `${o} 需随变更同步更新〔mock-${tag}〕`,
      })),
      summary: "全量级联用例：候选窗口内的输出物全部受影响。",
    });
  }

  // 默认：无修改意图 → 空数组（这是 prompt 规则 1 的硬行为，必须锁死）
  if (!CHANGE_INTENT.test(userMessage)) {
    return json({ affectedOutputs: [], changes: [], summary: "未检测到修改意图。" });
  }

  // 默认：只标卡片（最精确的路径，e2e「改 constraints 只影响业务规则链」依赖它）
  const primary = candidates.includes("card") ? "card" : (candidates[0] ?? "card");
  return json({
    affectedOutputs: [primary],
    changes: [
      {
        output: primary,
        field: primary === "card" ? "constraints" : "content",
        description: `按用户请求更新〔mock-${tag}〕`,
      },
    ],
    summary: `已识别变更，需更新 ${primary}。`,
  });
}

function json(v: unknown): string {
  return "```json\n" + JSON.stringify(v, null, 2) + "\n```";
}
