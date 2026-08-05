// 从需求访谈对话中提炼简短需求标题。
// 注意：本文件生成「标题」，与对话回复无关，绝不能复用对话回复或用户原话作为标题。

import { callAI } from "./client";
import type { ChatMessage } from "./types";

const TITLE_PROMPT = `你是一名资深产品经理助手。下面提供的是「用户在需求访谈中自己说过的话」（不包含助手的回复）。请仅依据用户亲口陈述的内容，提炼为一句简短的需求标题。

要求：
- 长度严格 4–12 个汉字（或 6–18 个英文字符）。
- 只输出标题本身，禁止带引号、书名号、前缀（如"标题："）、标点与换行。
- 只能基于用户明确说过的诉求提炼，禁止添加、推断或补充用户未明确提及的任何功能、细节或信息。
- 不要把助手的话、你的理解或任何对话之外的内容写进标题。
- 允许适度概括以避免照抄原话，但不得凭空发挥；若用户只说了"做个社区"，标题可以是"社区应用"而绝不能加入"打卡""论坛"等用户没说的词。
- 直接输出标题，不要任何思考过程，也不要出现 <think> 等标记。`;

// 口语化前缀：生成兜底标题时先去掉，避免出现"我想做个xxx"这种原话式标题。
const SPOKEN_PREFIXES = [
  "我想做一个", "我想做个", "我想做", "我想开发一个", "我想开发",
  "帮我做一个", "帮我做个", "帮我做", "我想要一个", "我想要",
  "我需要做一个", "我需要一个", "我需要", "我打算做一个", "我打算",
  "做一个", "开发一个", "开发", "做个",
  "麻烦做一个", "请做一个", "来一个", "整一个",
];

function stripSpokenPrefix(text: string): string {
  let t = text.trim();
  for (const p of SPOKEN_PREFIXES) {
    if (t.startsWith(p)) {
      t = t.slice(p.length).trim();
      break;
    }
  }
  return t;
}

// 兜底标题：去口语前缀 + 清洗 + 截断，尽量贴近"提炼"而非"原文"。
function localTitleFrom(message: string): string | null {
  const stripped = stripSpokenPrefix(message);
  const title = cleanTitle(stripped);
  if (!title) return null;
  return title.length > 16 ? title.slice(0, 16) : title;
}

// 清洗模型输出：剥离思考链标记、代码块、引号、尾部标点。返回 null 表示无有效标题。
function cleanTitle(raw: string): string | null {
  if (!raw) return null;
  let s = raw;
  // 剥离  导入后的多余空行
  s = s.trim();
  // 如果内容包含 JSON 代码块或 markdown 代码块，说明 AI 误输出了对话内容，取第一行有效内容
  if (s.includes("```") || s.includes("[STEP_COMPLETE]") || s.length > 50) {
    // 取第一行非空、非标记的内容
    const firstLine = s.split("\n").find((l) => {
      const t = l.trim();
      return t && !t.startsWith("```") && !t.startsWith("[") && !t.startsWith("##");
    });
    if (firstLine) s = firstLine.trim();
  }
  // 剥离 <think>...</think> 等思考链标记
  s = s.replace(/<think[\s\S]*?<\/think>/gi, "");
  // 剥离残留的 xml 标签
  s = s.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "");
  // 去掉代码块围栏
  s = s.replace(/```[\s\S]*?```/g, "");
  // 去掉首尾反引号/引号
  s = s.replace(/^["'`》】」』]+|["'`《【「『]+$/g, "").trim();
  // 去掉常见前缀
  s = s.replace(/^(标题[:：]|title[:：])\s*/i, "");
  // 去掉尾部标点
  s = s.replace(/[。.！!？?，,、；;：:~～\s]+$/g, "").trim();
  if (!s) return null;
  // 避免把整段对话当标题：超长则截断
  return s.length > 24 ? s.slice(0, 24) : s;
}

export async function summarizeTitle(
  messages: { role: "user" | "assistant"; content: string }[]
): Promise<string | null> {
  // 至少要有 1 条用户消息才尝试生成
  const userMessages = messages.filter((m) => m.role === "user" && m.content.trim());
  if (userMessages.length < 1) return null;

  // 只把「用户自己的发言」作为标题生成的依据，绝不包含助手的回复，
  // 避免助手复述/发挥的内容被模型当成标题素材（导致混入对话中未出现的信息）。
  const userOnlyHistory: ChatMessage[] = [
    { role: "system", content: TITLE_PROMPT },
    ...userMessages.map((m) => ({
      role: "user" as const,
      content: m.content,
    })),
  ];

  const chatHistory = userOnlyHistory;

  try {
    const result = await callAI("title", chatHistory);
    const title = cleanTitle(result.content);
    return title; // 可能为 null（模型未产出有效标题）
  } catch {
    // AI 失败：用本地轻提炼兜底，绝不直接使用用户原话
    return localTitleFrom(userMessages[0].content);
  }
}
