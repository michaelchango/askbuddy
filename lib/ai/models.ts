// AI 任务 → 模型路由表（与 ai-model-strategy.md 一致）
// 所有 AI 调用必须经此表选型，禁止在业务代码硬编码模型名。
//
// 当前 CloudBase 环境(baas_trial 体验版) cloudbase group 实际可用模型为 hy3 / hy3-preview；
// 规则推荐的 deepseek-v4-flash / hunyuan-2.0-instruct-20251111 / glm-5 / kimi-k2.6
// 需要非体验版或 hunyuan-exp/custom-* group 才支持，因此此处统一用 hy3 系列。
//
// 可通过环境变量覆盖默认值，便于后续切换模型而无需改代码：
//   AI_MODEL_DIALOGUING, AI_MODEL_TITLE, AI_MODEL_RESEARCH_ANALYSIS,
//   AI_MODEL_DESIGNING, AI_MODEL_SOLUTION, AI_MODEL_PRD_WRITING,
//   AI_MODEL_PROTOTYPE_GEN, AI_MODEL_PROTOTYPE_EDIT
const DEFAULTS = {
  dialoguing: "hy3", // 对话访谈（需求确认）
  title: "hy3", // 需求标题概括（轻量、弱思考，优先稳定输出）
  research_analysis: "hy3", // 调研分析（合并调研+分析）
  designing: "hy3-preview", // 方案文档生成（需要更强生成能力）
  solution_writing: "hy3", // 方案文档生成
  prd_writing: "hy3-preview", // PRD 长文生成
  devcontext: "hy3-preview", // DevContext 结构化 JSON 生成（长结构、需强指令遵循）
  prototype_gen: "hy3-preview", // 原型 HTML 生成（需要更强生成能力）
  prototype_edit: "hy3-preview", // 原型对话式修改
} as const;

const ENV_KEYS: Record<keyof typeof DEFAULTS, string> = {
  dialoguing: "AI_MODEL_DIALOGUING",
  title: "AI_MODEL_TITLE",
  research_analysis: "AI_MODEL_RESEARCH_ANALYSIS",
  designing: "AI_MODEL_DESIGNING",
  solution_writing: "AI_MODEL_SOLUTION",
  prd_writing: "AI_MODEL_PRD_WRITING",
  devcontext: "AI_MODEL_DEVCONTEXT",
  prototype_gen: "AI_MODEL_PROTOTYPE_GEN",
  prototype_edit: "AI_MODEL_PROTOTYPE_EDIT",
};

const modelCache: Partial<Record<keyof typeof DEFAULTS, string>> = {};

function resolveModel(task: keyof typeof DEFAULTS): string {
  const cached = modelCache[task];
  if (cached) return cached;
  const env = process.env[ENV_KEYS[task]];
  const model = env && env.trim() !== "" ? env.trim() : DEFAULTS[task];
  modelCache[task] = model;
  return model;
}

// 运行时导出（每个任务读一次 env，便于后续切换模型而无需改代码）。
export const AI_TASK_MODEL: { [K in keyof typeof DEFAULTS]: string } = new Proxy(
  {} as { [K in keyof typeof DEFAULTS]: string },
  {
    get: (_t, k: string) => resolveModel(k as keyof typeof DEFAULTS),
  }
);

export type AITaskType = keyof typeof DEFAULTS;
