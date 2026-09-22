// 上下文构建（harness 的「记忆/上下文」）：v2 增加 step-aware 跨步骤积累式记忆。
import { db } from "@/lib/db";
import { listConversations } from "@/lib/services/conversations";
import { getRequirement } from "@/lib/services/requirements";
import { retrieveRelevantKnowledge } from "@/lib/services/knowledge";
import type { KnowledgeRef } from "@/lib/schemas/knowledge";
import type { AITaskType } from "../models";
import type { TaskContext, RequirementCardData, ChatMessage } from "../types";
import { assertNoPrdUpstream } from "./ad2";

// 步骤上下文（积累式）：按 step 加载上游输出物注入 prompt。
export interface StepContext {
  requirementId: string;
  taskType: AITaskType;
  step: string; // StepName
  card?: Partial<RequirementCardData>;
  history: ChatMessage[];
  upstream: Record<string, string>;
  // 变更模式：当前步骤已生成的文档内容（用于"基于现有文档精准修改"）
  existingDoc?: string;
  // M4 知识复利：检索到的相关知识（注入 prompt 并溯源）
  knowledge: KnowledgeRef[];
}

// 基础上下文（v1 兼容，对话访谈等无上游场景使用）。
export async function buildTaskContext(
  requirementId: string,
  taskType: AITaskType,
  vars: Record<string, unknown>
): Promise<TaskContext> {
  const [req, convs] = await Promise.all([
    getRequirement(requirementId),
    listConversations(requirementId),
  ]);
  const history = convs
    .filter((c) => c.role !== "system")
    .map((c) => ({ role: c.role, content: c.content }));
  return {
    requirementId,
    taskType,
    vars,
    history,
    card: req?.card as Partial<RequirementCardData> | undefined,
  };
}

// v2 步骤上下文：按任务类型加载上游步骤的输出物，实现积累式跨步骤记忆。
export async function buildStepContext(
  requirementId: string,
  taskType: AITaskType,
  input?: Record<string, unknown>
): Promise<StepContext> {
  const [req, convs] = await Promise.all([
    getRequirement(requirementId),
    listConversations(requirementId),
  ]);

  const history = convs
    .filter((c) => c.role !== "system")
    .map((c) => ({ role: c.role, content: c.content }));

  const card = req?.card as Partial<RequirementCardData> | undefined;
  const upstream = await buildUpstream(requirementId, taskType, card);

  // 步骤→taskType 映射
  const stepMap: Record<string, string> = {
    dialoguing: "dialoguing",
    research_analysis: "research_analysis",
    solution_writing: "design",
    prd_writing: "prd_writing",
    devcontext: "prd_writing", // DevContext 归属于第 4 步，便于日志与状态归因
  };

  // 变更模式：读取当前步骤已生成的文档，供 prompt 做"现有文档 + 修改点"的精准修改
  let existingDoc: string | undefined;
  if (input?.changeNote) {
    existingDoc = await loadExistingDoc(requirementId, taskType);
  }

  // M4 知识复利：并行召回相关知识（失败返回 []，不阻断主流程）。
  // query = 用户本轮消息 + 卡片标题/目标/范围 + 步骤名，截断 500 字符。
  const queryText = buildKnowledgeQuery(input, card, taskType);
  const knowledge = await retrieveRelevantKnowledge(
    req?.projectId ?? "",
    queryText
  );

  return {
    requirementId,
    taskType,
    step: stepMap[taskType] ?? "dialoguing",
    card,
    history,
    upstream,
    existingDoc,
    knowledge,
  };
}

/** 拼知识检索 query：用户消息 + 卡片关键字段 + 步骤名（截断 500）。 */
function buildKnowledgeQuery(
  input: Record<string, unknown> | undefined,
  card: Partial<RequirementCardData> | undefined,
  taskType: AITaskType
): string {
  const parts: string[] = [];
  const msg = (input?.message as string) ?? (input?.changeNote as string) ?? "";
  if (msg.trim()) parts.push(msg.trim());
  if (card) {
    const c = card as Record<string, unknown>;
    for (const k of ["title", "background", "scope", "targetUsers", "painPoints"]) {
      const v = c[k];
      if (typeof v === "string" && v.trim()) parts.push(v.trim());
    }
  }
  parts.push(`步骤:${taskType}`);
  return parts.join(" ").slice(0, 500);
}

// 读取当前步骤自身已生成的文档内容（变更模式专用，截断保护）
async function loadExistingDoc(
  requirementId: string,
  taskType: AITaskType
): Promise<string | undefined> {
  try {
    if (taskType === "research_analysis") {
      const ra = await db.get("research_analysis", requirementId);
      if (!ra) return undefined;
      const row = ra as Record<string, unknown>;
      const report = ((row.report as string | undefined) ?? "").slice(0, 6000);
      const userStories = Array.isArray(row.user_stories) ? row.user_stories : [];
      const features = Array.isArray(row.features) ? row.features : [];
      if (!report && !userStories.length && !features.length) return undefined;
      // 与首次生成的规范格式严格一致：报告正文 + 末尾 ```json 围栏包裹 {userStories, features}，
      // 避免把结构化数据以裸 JSON 内联进正文，导致模型在变更模式下复现错误格式。
      const json = "```json\n" +
        JSON.stringify({ userStories, features }, null, 2).slice(0, 4000) +
        "\n```";
      return (report + "\n\n" + json).trim();
    }
    if (taskType === "solution_writing" || taskType === "designing") {
      const sol = await db.get("solutions", requirementId);
      const doc = (sol as Record<string, unknown> | undefined)?.doc as string | undefined;
      return doc ? doc.slice(0, 8000) : undefined;
    }
    if (taskType === "prd_writing") {
      const prd = await db.get("prds", requirementId);
      const markdown = (prd as Record<string, unknown> | undefined)?.markdown as
        | string
        | undefined;
      return markdown ? markdown.slice(0, 8000) : undefined;
    }
    if (taskType === "devcontext") {
      const rec = await db.get("dev_contexts", requirementId, "requirement_id");
      const content = (rec as Record<string, unknown> | undefined)?.content as
        | Record<string, unknown>
        | undefined;
      // 变更模式只回传内容段（meta/references 由系统重算），截断保护。
      if (!content) return undefined;
      const body: Record<string, unknown> = { ...content };
      delete body.meta;
      delete body.references;
      delete body.$schema;
      delete body.schema_version;
      return JSON.stringify(body, null, 2).slice(0, 8000);
    }
  } catch { /* 读取失败退化为全新生成 */ }
  return undefined;
}

// ---- 内部：按任务类型加载上游 ----
//
// 各上游的截断额度（字符）。DevContext 需要比 PRD 更完整的方案原文（方案是 DevContext
// 最密的上游），故单独放宽；其余 taskType 维持原额度，避免回归。
const UPSTREAM_LIMITS: Record<string, { ra: number; sol: number; proto: number }> = {
  research_analysis: { ra: 4000, sol: 4000, proto: 2000 },
  solution_writing: { ra: 4000, sol: 4000, proto: 2000 },
  designing: { ra: 4000, sol: 4000, proto: 2000 },
  prd_writing: { ra: 4000, sol: 4000, proto: 2000 },
  devcontext: { ra: 6000, sol: 8000, proto: 3000 },
};

async function buildUpstream(
  requirementId: string,
  taskType: AITaskType,
  card?: Partial<RequirementCardData>
): Promise<Record<string, string>> {
  const upstream: Record<string, string> = {};
  const limit = UPSTREAM_LIMITS[taskType] ?? { ra: 4000, sol: 4000, proto: 2000 };

  // 需求卡片始终是最基础的上游
  if (card && Object.keys(card).some((k) => {
    const v = (card as Record<string, unknown>)[k];
    return typeof v === "string" && (v as string).trim().length > 0;
  })) {
    upstream["需求卡片"] = JSON.stringify(card, null, 2);
  }

  if (["research_analysis", "solution_writing", "designing", "prd_writing", "devcontext"].includes(taskType)) {
    // 所有非对话任务都尝试加载调研分析结论
    const ra = await db.get("research_analysis", requirementId);
    if (ra) {
      const parts: string[] = [];
      const row = ra as Record<string, unknown>;
      if (row.report) parts.push((row.report as string).slice(0, limit.ra));
      if (row.user_stories) {
        parts.push("## 用户故事\n" + JSON.stringify(row.user_stories, null, 2));
      }
      if (row.features) {
        parts.push("## 功能清单\n" + JSON.stringify(row.features, null, 2));
      }
      if (parts.length) upstream["调研分析结论"] = parts.join("\n\n");
    }
  }

  if (["solution_writing", "designing", "prd_writing", "devcontext"].includes(taskType)) {
    // 方案设计/PRD/DevContext：加载方案文档
    const sol = await db.get("solutions", requirementId);
    if (sol) {
      const doc = (sol as Record<string, unknown>).doc as string | undefined;
      if (doc) upstream["产品方案文档"] = doc.slice(0, limit.sol);
    }
  }

  if (["prd_writing", "devcontext"].includes(taskType)) {
    // PRD / DevContext：额外加载原型信息
    const proto = await db.get<{ structure?: unknown }>("prototypes", requirementId);
    if (proto?.structure) {
      upstream["原型结构"] = JSON.stringify(proto.structure, null, 2).slice(0, limit.proto);
    }
  }

  // AD-2 同源并列：DevContext 与 PRD 平行消费同一组上游，绝不以 PRD 为输入。
  // 若未来有人为 devcontext 分支加载 prds，此断言会在开发期直接抛错。
  assertNoPrdUpstream(upstream, taskType);

  return upstream;
}
