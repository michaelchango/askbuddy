// 结构化解析：从模型输出中抽取「自然语言回复」与「需求卡片」。
// 约定（见 prompts/dialoguing）：模型先输出自然语言，最后以 ```json ... ``` 输出卡片。
import { RequirementCardSchema, type RequirementCardData, type ResearchAnalysisOutput } from "./types";

export interface ReplyAndCard {
  reply: string;
  card: Partial<RequirementCardData>;
}

export function extractReplyAndCard(text: string): ReplyAndCard {
  const fenceRe = /```json\s*([\s\S]*?)\s*```/i;
  const m = text.match(fenceRe);
  if (!m) {
    return { reply: text.trim(), card: {} };
  }
  const reply = text.slice(0, m.index).trim();
  const jsonStr = m[1];
  let card: Partial<RequirementCardData> = {};
  try {
    const parsed = JSON.parse(jsonStr);
    const result = RequirementCardSchema.partial().safeParse(parsed);
    if (result.success) card = result.data;
  } catch {
    card = {};
  }
  return { reply, card };
}

// 通用结构化解析（供非对话任务复用）。
export function parseStructured<T>(
  text: string,
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }
): { ok: boolean; data?: T } {
  try {
    const parsed = JSON.parse(text);
    const r = schema.safeParse(parsed);
    return r.success ? { ok: true, data: r.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

// ---------- v2 步骤输出解析 ----------

// 从 start 位置扫描一个「平衡」的 JSON 对象，返回其结尾 } 的下标；找不到返回 -1。
// 处理字符串转义与嵌套大括号，避免正文里孤立的 { } 误判。
function scanBalancedObject(text: string, start: number): number {
  if (text[start] !== "{") return -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 扫描平衡 JSON 数组，返回结尾 ] 的下标（-1 表示无）。
function scanBalancedArray(text: string, start: number): number {
  if (text[start] !== "[") return -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 从 start 位置尝试解析一个 JSON 值（对象或数组），返回片段与结束下标。
function findJsonValue(text: string, start: number): { jsonStr: string; end: number } | null {
  const ch = text[start];
  if (ch === "{") {
    const end = scanBalancedObject(text, start);
    if (end !== -1) return { jsonStr: text.slice(start, end + 1), end };
  } else if (ch === "[") {
    const end = scanBalancedArray(text, start);
    if (end !== -1) return { jsonStr: text.slice(start, end + 1), end };
  }
  return null;
}

// 从报告正文中抽取内联的「## 用户故事 / ## 功能清单」裸 JSON 小节。
// 这些小节是模型在格式跑偏时把结构化数据内联进正文导致的，需要剥离并转为结构化字段。
function extractInlineSections(reportText: string): {
  report: string;
  stories: unknown[];
  features: unknown[];
} {
  let text = reportText;
  const stories: unknown[] = [];
  const features: unknown[] = [];

  const sectionRe = /^##\s*(用户故事|功能清单)\s*(?:\n([\s\S]*?))?(?=\n##\s|\n#\s|$)/m;
  let guard = 0;
  while (guard++ < 12) {
    const mm = text.match(sectionRe);
    if (!mm) break;
    const label = mm[1];
    const body = (mm[2] ?? "").trim();
    const arrStart = body.search(/\[|\{/);
    if (arrStart !== -1) {
      const found = findJsonValue(body, arrStart);
      if (found) {
        try {
          const parsed = JSON.parse(found.jsonStr);
          const arr = Array.isArray(parsed)
            ? parsed
            : Array.isArray((parsed as Record<string, unknown>).userStories)
              ? (parsed as Record<string, unknown>).userStories!
              : Array.isArray((parsed as Record<string, unknown>).features)
                ? (parsed as Record<string, unknown>).features!
                : [];
          if (label === "用户故事") stories.push(...arr);
          else features.push(...arr);
        } catch { /* 非合法 JSON，忽略 */ }
      }
    }
    const idx = mm.index ?? 0;
    text = (text.slice(0, idx) + text.slice(idx + mm[0].length)).trim();
  }

  return { report: text, stories, features };
}

// 从模型输出中抽取「调研分析报告」+「结构化数据」。
// 兼容多种输出形态：
//  ① report 在前（markdown），最后以 ```json 围栏包裹结构化数据（最规范，优先）
//  ② report 在前（markdown），最后直接跟裸 JSON 对象/数组（含 userStories/features）
//  ③ report 正文内混入了「## 用户故事 / ## 功能清单」+ 裸 JSON 小节（格式跑偏的兜底）
// 无论哪种，report 落库都只保留纯 Markdown，不再混入 JSON。
export function extractResearchAnalysis(text: string): ResearchAnalysisOutput {
  const fenceRe = /```json\s*([\s\S]*?)\s*```/i;
  const m = text.match(fenceRe);

  let report = text;
  let jsonStr: string | null = null;

  if (m) {
    // ① 优先处理 ```json 围栏
    report = text.slice(0, m.index).trim();
    jsonStr = m[1];
  } else {
    // ② 回退：查找裸 JSON（对象或数组）。仅当其确含结构化字段时才剥离，
    //    避免把正文里偶然出现的大括号误判为 JSON。
    const start = text.search(/[[{]/);
    if (start !== -1) {
      const found = findJsonValue(text, start);
      if (found) {
        try {
          const probe = JSON.parse(found.jsonStr);
          const looksLikeStruct =
            Array.isArray((probe as Record<string, unknown>).userStories) ||
            Array.isArray((probe as Record<string, unknown>).features) ||
            typeof (probe as Record<string, unknown>).report === "string";
          if (looksLikeStruct) {
            report = (text.slice(0, start) + text.slice(found.end + 1)).trim();
            jsonStr = found.jsonStr;
          }
        } catch { /* 不是合法 JSON，保留整段作为 report */ }
      }
    }
  }

  // ③ 兜底：从 report 中剥离内联的「## 用户故事 / ## 功能清单」裸 JSON 小节。
  const inline = extractInlineSections(report);
  if (inline.stories.length || inline.features.length) {
    report = inline.report;
  }

  let userStories: ResearchAnalysisOutput["userStories"] = [];
  let features: ResearchAnalysisOutput["features"] = [];

  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed.userStories)) userStories = parsed.userStories;
      if (Array.isArray(parsed.features)) features = parsed.features;
      // 兼容模型把 report 一并放进 json 的情况
      if (typeof parsed.report === "string" && parsed.report.trim()) {
        report = parsed.report.trim();
      }
    } catch { /* JSON 解析失败，保留已剥离的 report 与空结构 */ }
  }

  // 内联小节抽取到的数据优先合并（覆盖模型偶发空 json 围栏的情况）。
  if (inline.stories.length) {
    userStories = inline.stories as ResearchAnalysisOutput["userStories"];
  }
  if (inline.features.length) {
    features = inline.features as ResearchAnalysisOutput["features"];
  }

  return { report, userStories, features };
}

// 纯文本提取（方案文档 / PRD 无 JSON 结构，整段即为内容）。
// 兜底：若模型误带 JSON（尾部 ```json 围栏或尾部裸 JSON 对象），剥离后再返回纯 Markdown，
// 确保文档类产物一律为 md 格式。仅剥离「结尾」的 JSON，避免误伤正文中的代码示例。
export function extractMarkdown(text: string): string {
  let out = text.trim();
  if (!out) return out;

  // 1. 剥离尾部 ```json ... ``` 围栏
  out = out.replace(/```json\s*[\s\S]*?\s*```\s*$/i, "").trim();
  if (!out) return out;

  // 2. 剥离尾部裸 JSON 对象（必须以 } 收尾，否则视为正文不处理）
  const start = out.lastIndexOf("{");
  if (start !== -1) {
    const end = scanBalancedObject(out, start);
    if (end === out.length - 1) {
      try {
        JSON.parse(out.slice(start));
        out = out.slice(0, start).trim();
      } catch { /* 非法 JSON，原样保留 */ }
    }
  }

  return ensureMermaidFences(out).trim();
}

// ---------- 原型 HTML 解析 ----------
export interface PrototypeStructure {
  pages: Array<{ id: string; title: string; path?: string }>;
}

export interface PrototypeParseResult {
  html: string;
  structure: PrototypeStructure | null;
}

// 从模型输出中抽取自包含 HTML 原型。兼容：
//  ① 直接给出完整 <!doctype html>…</html> 或 <html>…</html>
//  ② 包裹在 ```html 代码围栏中
// 并尽可能从内嵌 <script id="prd-flow-structure"> 解析页面结构。
export function extractPrototype(text: string): PrototypeParseResult {
  let html = "";
  const docRe = /<!doctype\s+html[^>]*>[\s\S]*?<\/html>/i;
  const htmlRe = /<html[^>]*>[\s\S]*?<\/html>/i;
  const m = text.match(docRe) || text.match(htmlRe);
  if (m) {
    html = m[0];
  } else {
    const fence = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
    if (fence) html = fence[1].trim();
  }

  let structure: PrototypeStructure | null = null;
  if (html) {
    const sm = html.match(
      /<script[^>]*id=["']prd-flow-structure["'][^>]*>([\s\S]*?)<\/script>/i
    );
    if (sm) {
      try {
        const parsed = JSON.parse(sm[1]);
        if (parsed && Array.isArray(parsed.pages)) {
          structure = { pages: parsed.pages };
        }
      } catch {
        structure = null;
      }
    }
  }

  return { html, structure };
}

// 补全未被 ```mermaid 围栏包裹的 mermaid 图块（幂等）。
// 仅对"不在任何代码块内、且以 mermaid 起始关键字开头"的行块自动补围栏；
// 已正确围栏或普通代码块一律跳过，避免重复包裹或误伤正文。
const MERMAID_KEYWORDS = [
  "flowchart", "graph", "sequenceDiagram", "classDiagram",
  "stateDiagram", "erDiagram", "gantt", "journey", "pie",
  "mindmap", "timeline", "gitGraph", "requirementDiagram",
];

// 图内部语法特征（节点定义 / 连线 / 子图等），用于判定非起始行是否属于图体。
const MERMAID_BODY_RE =
  /(-->)|\->>|(-{2,})|(\.-)|(===)|(-\|)|(==>)|subgraph|^end$|class |style |click |participant|note |direction|actor |state |fork|^[\t ]*[A-Za-z0-9_]+[[][A-Za-z0-9_]+|^[\t ]*[A-Za-z0-9_]+[(][A-Za-z0-9_]+/;

function isMermaidStart(line: string): boolean {
  const t = line.trim();
  if (t.startsWith("```")) return false;
  return MERMAID_KEYWORDS.some(
    (kw) => t === kw || t.startsWith(kw + " ") || t.startsWith(kw + "\t")
  );
}

function looksLikeMermaidBody(line: string): boolean {
  const t = line.trim();
  if (t === "") return false;
  return MERMAID_BODY_RE.test(t);
}

export function ensureMermaidFences(text: string): string {
  const lines = text.split("\n");
  let inFence = false;
  const result: string[] = [];
  let block: string[] | null = null;

  const flushBlock = () => {
    if (block && block.length) {
      result.push("```mermaid");
      result.push(...block);
      result.push("```");
    }
    block = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // 处理代码围栏（无论语言），透传即可
    if (trimmed.startsWith("```")) {
      flushBlock();
      inFence = !inFence;
      result.push(line);
      continue;
    }
    if (inFence) {
      result.push(line);
      continue;
    }

    // 不在任何代码块内
    if (isMermaidStart(line)) {
      if (!block) block = [];
      block.push(line);
    } else if (block) {
      if (trimmed === "" || trimmed.startsWith("#")) {
        // 空行或新标题：闭合图块
        flushBlock();
        result.push(line);
      } else if (looksLikeMermaidBody(line)) {
        // 图内部行：继续并入图块
        block.push(line);
      } else {
        // 非图文字：闭合图块后作为普通行
        flushBlock();
        result.push(line);
      }
    } else {
      result.push(line);
    }
  }
  flushBlock();

  return result.join("\n").trim();
}
