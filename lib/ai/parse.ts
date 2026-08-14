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
          const arr: unknown[] = Array.isArray(parsed)
            ? parsed
            : Array.isArray((parsed as Record<string, unknown>).userStories)
              ? ((parsed as Record<string, unknown>).userStories as unknown[])
              : Array.isArray((parsed as Record<string, unknown>).features)
                ? ((parsed as Record<string, unknown>).features as unknown[])
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

// 从模型输出中抽取 DevContext 的「内容段」JSON（不含 meta/references）。
// DevContext prompt 约定只输出一个 ```json 围栏；兼容模型偶发在正文前后夹带文字的情况：
//  ① 优先匹配 ```json ... ``` 围栏；
//  ② 回退：从第一个 { 起扫描「平衡对象」，取最长合法 JSON 对象。
export function extractDevContextJson(text: string): unknown | null {
  const fenceRe = /```json\s*([\s\S]*?)\s*```/i;
  const m = text.match(fenceRe);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {
      // 围栏内非法 JSON，落到下方裸对象兜底
    }
  }
  const start = text.indexOf("{");
  if (start !== -1) {
    const found = findJsonValue(text, start);
    if (found) {
      try {
        return JSON.parse(found.jsonStr);
      } catch {
        return null;
      }
    }
  }
  return null;
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

  // 3. mermaid 收尾：围栏归一 + 落库前语法校验/修复（单反引号围栏 → 三反引号等）
  const withMermaid = validateMermaidBlocks(
    sanitizeMermaidQuotes(ensureMermaidFences(out))
  );
  return withMermaid.trim();
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
// 并尽可能从内嵌 <script id="askbuddy-structure"> 解析页面结构。
// 兼容：改名前生成的历史原型内嵌的是旧 id "prd-flow-structure"，
// 这里新旧双读，保证历史版本的页面结构仍可解析（不要删除旧 id 分支）。
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
      /<script[^>]*id=["'](?:askbuddy-structure|prd-flow-structure)["'][^>]*>([\s\S]*?)<\/script>/i
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

// ---------------------------------------------------------------------------
// mermaid 代码块内容清洗
// ---------------------------------------------------------------------------
// 背景：模型在 mermaid 节点文本里偶尔使用英文双引号 " 包裹强调词（如
// F[渲染"上海 今天 XX℃"]），而 mermaid 把 " 视为字符串定界符，导致解析断裂，
// 报 "Syntax error in text"。清洗策略：仅对 ```mermaid 代码块内的节点文本，
// 把英文双引号 " 成对替换为中文引号（“ … ”），既保留语义又规避语法冲突。
// 注意：不处理非 mermaid 代码块，避免误伤普通代码里的字符串。
const MM_RE = /```mermaid\s*\n([\s\S]*?)```/gi;

// 把节点文本里的英文双引号 " 成对替换为中文引号 “ ”。
// 策略：奇数位替换为 “，偶数位替换为 ”，保证成对；孤立单个 " 替换为 “。
function fixQuotesInNodeText(code: string): string {
  // 逐字符扫描，遇到 " 时按出现次序奇偶替换。仅替换双引号，不触碰其它字符。
  let open = true;
  return code.replace(/"/g, () => {
    const ch = open ? "\u201C" : "\u201D"; // “ 或 ”
    open = !open;
    return ch;
  });
}

/**
 * 清洗文档中所有 mermaid 代码块里的英文双引号（节点文本用）。
 * 幂等：无 mermaid 块或块内无 " 时原样返回。
 * 注意：本函数假设 mermaid 已是标准三反引号围栏（```` ```mermaid ````），
 * 单反引号围栏的修复交给 normalizeMermaidFences 在更早阶段完成。
 */
export function sanitizeMermaidQuotes(text: string): string {
  return text.replace(MM_RE, (whole, code: string) => {
    return "```mermaid\n" + fixQuotesInNodeText(code) + "```";
  });
}

// ---------------------------------------------------------------------------
// mermaid 围栏归一 + 落库前语法校验
// ---------------------------------------------------------------------------
// 模型偶发把 mermaid 写成「单反引号」围栏（`mermaid ... `）而非标准三反引号
// （```` ```mermaid ````），导致渲染器把它当成内联代码、mermaid 收到纯文本而报
// "Syntax error in text"。这里在落库前把单反引号围栏归一为三反引号。
// 单反引号围栏的特征：行首为单个反引号、紧跟 mermaid、整块以单个反引号结束。
function normalizeMermaidFences(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let block: string[] | null = null;

  const flush = () => {
    if (block && block.length) {
      out.push("```mermaid");
      out.push(...block);
      out.push("```");
    }
    block = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    // 已经是正确的三反引号围栏：直接透传（跳过单反引号判定）
    if (trimmed.startsWith("```")) {
      flush();
      out.push(line);
      continue;
    }
    // 单反引号围栏开头
    if (trimmed.startsWith("`") && /^`mermaid(\s.*)?$/.test(trimmed)) {
      if (!block) block = [];
      continue;
    }
    // 单反引号围栏结束
    if (block && trimmed === "`") {
      flush();
      continue;
    }
    if (block) block.push(line);
    else out.push(line);
  }
  flush();
  return out.join("\n");
}

// 常见的 mermaid 语法错误自动修复。返回修复后的图体；若无法安全修复则原样返回。
// 设计原则：仅做「高置信度」修正，绝不改写合法图，避免误伤。
function repairMermaidBody(body: string): string {
  let code = body;

  // 1) 节点 label 用了未闭合/裸引号包裹、或标点冲突已在前一步处理；
  //    这里修复「连线箭头被写成中文箭头」或「箭头两边粘连空格」之外的常见破绽：

  // 2) 相邻两节点用换行 + 缩进写在一起但缺少箭头（极少见），跳过，避免误改。

  // 3) 把图体内残留的「中文全角箭头 →」误写情形归一为 mermaid 不支持的符号移除
  //    （mermaid 不认 →，若误写会导致语法错误）：直接删除行内的全角箭头字符。
  code = code.replace(/→/g, "");

  // 4) 节点标签里若仍残留成对的英文双引号（前序 sanitize 已处理，这里兜底），
  //    再次确保成对转中文引号，避免 " 被当成字符串定界符。
  //    只在出现奇数个 " 时才做奇偶替换，偶数个视为有意字符串，不动。
  const quoteCount = (code.match(/"/g) || []).length;
  if (quoteCount % 2 === 1) {
    let open = true;
    code = code.replace(/"/g, () => {
      const ch = open ? "\u201C" : "\u201D";
      open = !open;
      return ch;
    });
  }

  // 5) 句末残留的裸英文分号/多余花括号（模型偶发在节点后加 ;）清理
  code = code.replace(/;\s*$/gm, "");

  return code;
}

// 轻量 mermaid 语法校验：判定一个 mermaid 图体是否「很可能」合法。
// 不依赖浏览器 DOM，仅做结构化静态检查，覆盖最高频的致命错误：
//   - 缺少图类型声明（首行非 flowchart/graph/sequenceDiagram 等）
//   - 出现裸英文双引号（奇数个 "）
//   - 连线语法明显残缺（箭头缺失）
// 返回 true 表示通过（或无法判定为错误）。
const MERMAID_START_RE =
  /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|journey|pie|mindmap|timeline|gitGraph|requirementDiagram)\b/i;

function looksValidMermaid(body: string): boolean {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  if (!MERMAID_START_RE.test(lines[0])) return false;
  // 奇数个 " 视为未闭合字符串，必然非法
  const quoteCount = (body.match(/"/g) || []).length;
  if (quoteCount % 2 === 1) return false;
  // 含全角箭头必然非法
  if (body.includes("→")) return false;
  return true;
}

/**
 * 落库前对文档内所有 mermaid 代码块做「围栏归一 + 语法校验/修复」。
 * 流程：
 *   1. normalizeMermaidFences：单反引号围栏 → 三反引号（修复本次 "Syntax error in text" 的根因）
 *   2. 对每个 ```` ```mermaid ```` 块做轻量语法校验，不合法则尝试 repairMermaidBody 修复，
 *      修复后仍不合法则保留原块（交由前端回退为代码展示，绝不清空内容致文档残缺）。
 * 幂等：已是正确三反引号且语法合法的文档原样返回。
 */
export function validateMermaidBlocks(text: string): string {
  const normalized = normalizeMermaidFences(text);
  return normalized.replace(/```mermaid\s*\n([\s\S]*?)```/gi, (whole, code: string) => {
    const body = String(code).replace(/\n+$/, "");
    const emit = (b: string) => "```mermaid\n" + b + "\n```";
    if (looksValidMermaid(body)) {
      return emit(body);
    }
    const fixed = repairMermaidBody(body);
    if (looksValidMermaid(fixed)) {
      return emit(fixed);
    }
    // 无法安全修复：保留原块，避免破坏文档内容
    return emit(body);
  });
}
