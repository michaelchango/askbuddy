// AI 调用管理层：统一经路由表选型，支持 mock 开关、超时、流式、preview→hy3 降级。
// 真实模式基于 @cloudbase/node-sdk 的 createModel("cloudbase")（见 ai-model-nodejs 规则）。
import { getCloudAI } from "@/lib/cloudbase/app";
import { AI_TASK_MODEL, type AITaskType } from "./models";
import type { AIResult, ChatMessage } from "./types";

// AI 是否走 mock：优先 AI_MOCK，其次整体 USE_MOCK。保留真实 DB 的同时可单独让 AI 走占位，
// 便于在尚未启用 CloudBase AI 模型时演示全链路；启用真实模型后将 AI_MOCK 置 false 即可。
function aiUseMock(): boolean {
  if (process.env.AI_MOCK === "true") return true;
  if (process.env.USE_MOCK === "true") return true;
  return false;
}

// 降级映射：preview 失败时回退到 hy3，保证核心生成不中断。
const DEGRADE: Partial<Record<AITaskType, AITaskType>> = {
  designing: "research_analysis",
  prd_writing: "research_analysis",
};

function pickModel(taskType: AITaskType): string {
  return AI_TASK_MODEL[taskType];
}

// ---------- 真实模式（CloudBase Node SDK） ----------
// 通过流式 textStream 聚合文本：思考模型的推理链由 SDK 单独处理，textStream 仅返回最终答案，
// 避免 generateText().text 把 <think> 思考链混入正文（标题/PRD 等生成结果）。
async function streamToText(taskType: AITaskType, messages: ChatMessage[]): Promise<AIResult> {
  const ai = getCloudAI();
  const model = ai.createModel("cloudbase");
  const modelName = pickModel(taskType);
  try {
    const res = await model.streamText({ model: modelName, messages });
    let text = "";
    for await (const chunk of res.textStream) {
      if (chunk) text += chunk;
    }
    return { model: modelName, content: text };
  } catch (e) {
    const alt = DEGRADE[taskType];
    if (alt) {
      const altName = pickModel(alt);
      const res2 = await model.streamText({ model: altName, messages });
      let text = "";
      for await (const chunk of res2.textStream) {
        if (chunk) text += chunk;
      }
      return { model: altName, content: text };
    }
    throw e;
  }
}

async function realGenerate(taskType: AITaskType, messages: ChatMessage[]): Promise<AIResult> {
  return streamToText(taskType, messages);
}

async function* realStream(taskType: AITaskType, messages: ChatMessage[]): AsyncGenerator<string> {
  const ai = getCloudAI();
  const model = ai.createModel("cloudbase");
  const res = await model.streamText({ model: pickModel(taskType), messages });
  for await (const chunk of res.textStream) {
    if (chunk) yield chunk;
  }
}

// ---------- Mock 模式（结构化占位，保证本地全链路可演示） ----------
function mockDialogueText(userMessage: string): string {
  const card = {
    background: userMessage.slice(0, 200),
    targetUsers: "（示例）注重效率的职场用户",
    painPoints: "（待补充）",
    scope: "（待补充）",
    nonFunctional: "（待补充）",
    constraints: "（待补充）",
  };
  const reply =
    "收到，我已经记下你的初步想法。为了把这条需求打磨清楚，我想先确认几个关键点：\n" +
    "1. 这个需求的用户是谁？他们最核心的痛点是什么？\n" +
    "2. 你期望的第一版范围大概包含哪些功能？\n" +
    "3. 有没有必须遵循的约束（技术栈 / 合规 / 时间）？\n" +
    "你可以随意补充，我会边聊边把信息沉淀到右侧的需求卡片里。";
  return `${reply}\n\n\`\`\`json\n${JSON.stringify(card, null, 2)}\n\`\`\`\n`;
}

function mockResearchAnalysis(userMessage: string): string {
  return `## 市场/用户洞察

目标用户为有社交休闲需求的年轻群体，偏好即点即玩的轻量体验。核心画像：习惯手机浏览器打开，反感下载安装；对触屏操作手感敏感，偏好简洁直观的交互反馈。痛点并非功能缺失，而是现有方案操作门槛高、视觉反馈单调、社交分享链路冗长。

## 竞品/行业参考

现有同类产品普遍采用虚拟方向键或复杂手势，误触率高；视觉多为扁平设计，缺乏暗环境下的沉浸感。可参考的优化方向：单指滑动转向、自动吸附网格、炫酷击杀特效与慢镜头回放。

## 核心结论

1. 零门槛入口是关键——链接分享即玩，无需注册/下载
2. 操作极简但反馈强烈——单指滑动转向，击杀有慢镜头+特效
3. 社交裂变是增长引擎——群内排名、实时观战、一键分享
4. 视觉风格需在"简洁"与"炫酷"间平衡，暗色模式为必选

\`\`\`json
{
  "userStories": [
    {"role":"玩家","goal":"打开链接即进入游戏","reason":"零门槛快速开始"},
    {"role":"玩家","goal":"单指滑动控制蛇的移动","reason":"降低操作误触"},
    {"role":"玩家","goal":"击杀对手时获得炫酷视觉反馈","reason":"增强成就感"},
    {"role":"群主","goal":"一键分享房间到群聊","reason":"快速拉人开局"},
    {"role":"玩家","goal":"查看群内实时排名","reason":"激发竞争欲"}
  ],
  "features": [
    {"name":"即点即玩","desc":"链接打开直接进入游戏，无需注册","priority":"P0","module":"入口"},
    {"name":"单指转向","desc":"单指滑动控制蛇头方向，自动吸附网格","priority":"P0","module":"操作"},
    {"name":"击杀特效","desc":"击杀时慢镜头+粒子特效+震动反馈","priority":"P0","module":"反馈"},
    {"name":"房间分享","desc":"生成房间链接，支持微信/QQ一键分享","priority":"P1","module":"社交"},
    {"name":"实时排名","desc":"房间/群内实时击杀排行榜","priority":"P1","module":"社交"},
    {"name":"暗色模式","desc":"支持暗色主题，夜间护眼","priority":"P2","module":"视觉"}
  ]
}
\`\`\``;
}

function mockText(taskType: AITaskType, messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (taskType === "dialoguing") return mockDialogueText(lastUser?.content ?? "");
  if (taskType === "research_analysis") return mockResearchAnalysis(lastUser?.content ?? "");
  return `[MOCK:${pickModel(taskType)}] 占位输出：${(lastUser?.content ?? "").slice(0, 40)}`;
}

async function* mockStream(taskType: AITaskType, messages: ChatMessage[]): AsyncGenerator<string> {
  const text = mockText(taskType, messages);
  const chunks = text.match(/[\s\S]{1,8}/g) ?? [text];
  for (const c of chunks) {
    await new Promise((r) => setTimeout(r, 12));
    yield c;
  }
}

// ---------- 对外接口 ----------
export async function callAI(taskType: AITaskType, messages: ChatMessage[]): Promise<AIResult> {
  if (aiUseMock()) return { model: pickModel(taskType), content: mockText(taskType, messages) };
  return realGenerate(taskType, messages);
}

// 流式生成：返回文本块流（ReadableStream<string>），供 SSE 边生成边推送。
export function streamAI(taskType: AITaskType, messages: ChatMessage[]): ReadableStream<string> {
  const gen = aiUseMock() ? mockStream(taskType, messages) : realStream(taskType, messages);
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
