// 变更点分析服务：调用 AI 分析用户修改请求，识别受影响输出物。
// v2：引入「候选窗口 + 真实产物内容 + 级联规则」——
// 只比对已生成（done/in_progress）的输出物，AI 依据各产物真实内容判定波及范围。
import { callAI } from "@/lib/ai/client";
import { getRequirement } from "./requirements";
import { listConversations } from "./conversations";
import { db } from "@/lib/db";

export interface ChangeAnalysis {
  affectedOutputs: string[]; // ["card", "research_analysis", "design", "prd"]
  changes: Array<{
    output: string;
    field: string;
    description: string;
  }>;
  summary: string;
}

const OUTPUT_LABELS: Record<string, string> = {
  card: "需求卡片",
  research_analysis: "调研分析",
  design: "方案设计",
  prd: "需求文档（PRD）",
};

// 依赖顺序（上游 → 下游），级联判定与结果排序都以此为准
const DEP_ORDER = ["card", "research_analysis", "design", "prd"];

// 加载候选输出物的真实内容（截断保护），供 AI 做内容级比对
async function loadCandidateContents(
  requirementId: string,
  candidates: string[],
  card?: Record<string, unknown>
): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};

  if (candidates.includes("card") && card) {
    contents["card"] = JSON.stringify(card, null, 2).slice(0, 3000);
  }

  if (candidates.includes("research_analysis")) {
    const ra = await db.get("research_analysis", requirementId, "requirement_id");
    if (ra) {
      const row = ra as Record<string, unknown>;
      const parts: string[] = [];
      if (row.report) parts.push((row.report as string).slice(0, 3000));
      if (row.user_stories)
        parts.push("## 用户故事\n" + JSON.stringify(row.user_stories).slice(0, 1500));
      if (row.features)
        parts.push("## 功能清单\n" + JSON.stringify(row.features).slice(0, 1500));
      if (parts.length) contents["research_analysis"] = parts.join("\n\n");
    }
  }

  if (candidates.includes("design")) {
    const sol = await db.get("solutions", requirementId, "requirement_id");
    const doc = (sol as Record<string, unknown> | undefined)?.doc as string | undefined;
    if (doc) contents["design"] = doc.slice(0, 4000);
  }

  if (candidates.includes("prd")) {
    const prd = await db.get("prds", requirementId, "requirement_id");
    const markdown = (prd as Record<string, unknown> | undefined)?.markdown as
      | string
      | undefined;
    if (markdown) contents["prd"] = markdown.slice(0, 4000);
  }

  return contents;
}

export async function analyzeChanges(
  requirementId: string,
  userMessage: string,
  opts?: { candidates?: string[] }
): Promise<ChangeAnalysis | null> {
  const req = await getRequirement(requirementId);
  const convs = await listConversations(requirementId);
  const history = convs
    .filter((c) => c.role !== "system")
    .slice(-10)
    .map((c) => ({ role: c.role, content: c.content }));

  const card = req?.card as Record<string, unknown> | undefined;

  // 候选窗口：调用方（路由）按步骤状态计算传入；缺省兜底为仅卡片
  const candidates = (opts?.candidates?.length ? opts.candidates : ["card"]).filter(
    (c) => DEP_ORDER.includes(c)
  );

  // 加载候选输出物的真实内容，AI 依据内容判断"变更是否涉及该文档"
  const contents = await loadCandidateContents(requirementId, candidates, card);

  const contextParts: string[] = [];
  for (const c of DEP_ORDER) {
    if (!candidates.includes(c)) continue;
    const label = OUTPUT_LABELS[c] ?? c;
    contextParts.push(
      `【已生成：${label}（${c}）】\n${contents[c] ?? "（内容为空）"}`
    );
  }

  const candidateList = candidates
    .map((c) => `${c}（${OUTPUT_LABELS[c] ?? c}）`)
    .join("、");

  const systemPrompt = `你是 PrdFlow 的产品经理 AI 助手。用户提出了一个修改请求，你的任务是把变更内容与所有【已生成输出物】的真实内容逐一比对，判断这个变更会影响哪些输出物。

输出物依赖顺序（上游 → 下游）：card（需求卡片）→ research_analysis（调研分析）→ design（方案设计）→ prd（需求文档）。

本次可参与判定的输出物（候选窗口）只有：${candidateList}。
未列入候选窗口的输出物尚未生成，一律不得出现在结果中。

判定规则：
1. 先判断用户消息是否真的包含【修改意图】：是否要改动需求本身，或更新某个已生成的产物。
   若用户只是确认、推进流程、跳过、致谢、提问或闲聊（例如"进入下一步""好的""确认""继续""跳过""这个报告不错"），必须返回 affectedOutputs: []（空数组），不要保守地标 ["card"]。
2. 【逐文档内容比对】：对候选窗口中的每个输出物，结合其真实内容判断变更是否涉及它——
   变更点在该文档中有对应内容需要改写，或该文档缺失了变更后应包含的内容，即视为受影响。
3. 【正向级联】：若某个上游输出物受影响（内容需要修改），则它在候选窗口内的所有下游输出物通常也受影响，需一并列出。
   例：新增一个功能 → card 的 scope 变 → research_analysis 的功能清单变 → design 变 → prd 变（以候选窗口为界，全部列出）。
4. 【反向克制】：若变更仅发生在某个下游文档的局部细节，且该细节在上游文档中本来就未涉及、也不与上游内容矛盾，则上游【不受影响】，不要向上牵连。
   例：在方案阶段调整一个卡片与调研均未提及的技术实现细节 → 只标 design（及候选窗口内已生成的 prd），不标 card、research_analysis。
5. 【不越窗口】：affectedOutputs 必须是候选窗口的子集，绝不列出未生成的输出物。

输出格式：只输出一个 JSON 代码块，包含以下字段：
- affectedOutputs: string[] — 受影响的输出物类型数组（按依赖顺序排列）
- changes: Array<{output: string, field: string, description: string}> — 每个受影响输出物的具体变更点（description 要具体说明"该文档需要改什么"，将作为重新生成时的修改指令）
- summary: string — 变更的自然语言总结（一段话，说明改了什么、波及哪些文档、哪些文档未涉及无需更新）

示例输出格式：
\`\`\`json
{
  "affectedOutputs": ["card", "research_analysis"],
  "changes": [
    {"output": "card", "field": "scope", "description": "功能范围新增XX功能"},
    {"output": "research_analysis", "field": "features", "description": "功能清单需补充XX功能条目及优先级"}
  ],
  "summary": "本次变更新增了XX功能，需要同步更新需求卡片的功能范围和调研分析的功能清单。"
}
\`\`\`

不要输出其他任何内容。`;

  const userParts: string[] = [];
  if (contextParts.length) userParts.push(contextParts.join("\n\n"));
  userParts.push(
    `【对话历史】\n${history.map((h) => `${h.role === "user" ? "用户" : "助手"}：${h.content.slice(0, 200)}`).join("\n")}`
  );
  userParts.push(`【用户修改请求】\n${userMessage}`);
  userParts.push(
    "请将变更内容与上述已生成输出物逐一比对，按判定规则分析受影响的输出物并列出具体变更点。"
  );

  try {
    const result = await callAI("dialoguing", [
      { role: "system", content: systemPrompt },
      { role: "user", content: userParts.join("\n\n") },
    ]);

    // 剥除思考链标记 + 提取 JSON
    const content = result.content.replace(/<think[\s\S]*?<\/think>/gi, "").trim();

    // 先尝试从 ```json 代码块中提取
    let parsed: any = null;
    const m = content.match(/```json\s*([\s\S]*?)\s*```/i);
    if (m) {
      try { parsed = JSON.parse(m[1]); } catch { /* ignore */ }
    }

    // 如果代码块解析失败，尝试直接找 JSON 对象
    if (!parsed) {
      const objMatch = content.match(/\{[\s\S]*"affectedOutputs"[\s\S]*\}/);
      if (objMatch) {
        try { parsed = JSON.parse(objMatch[0]); } catch { /* ignore */ }
      }
    }

    if (!parsed || !Array.isArray(parsed.affectedOutputs)) return null;

    // 兜底约束：结果 ⊆ 候选窗口，并按依赖顺序排序
    const affected = (parsed.affectedOutputs as unknown[])
      .filter((o): o is string => typeof o === "string" && candidates.includes(o))
      .sort((a, b) => DEP_ORDER.indexOf(a) - DEP_ORDER.indexOf(b));

    const changes = (Array.isArray(parsed.changes) ? parsed.changes : []).filter(
      (c: any) =>
        c && typeof c === "object" && typeof c.output === "string" && affected.includes(c.output)
    );

    return {
      affectedOutputs: affected,
      changes,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
    };
  } catch {
    return null;
  }
}
