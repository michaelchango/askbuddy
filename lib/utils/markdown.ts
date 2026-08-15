// AI 生成 Markdown 的防御性规范化工具（前后端共用）。
// 目标：在落库 / 渲染前自动修复模型常见格式错误，避免整篇文档被识别成代码块、
// 标题无法渲染，或 mermaid 代码块未闭合导致后续正文被吞进黑底代码块。

const MERMAID_KEYWORDS = [
  "flowchart",
  "graph",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "erDiagram",
  "gantt",
  "journey",
  "pie",
  "mindmap",
  "timeline",
  "gitGraph",
  "requirementDiagram",
];

// 图内部语法特征（节点定义 / 连线 / 子图 / class 等），用于判定非起始行是否属于图体。
const MERMAID_BODY_RE =
  /(-->)|\->>|(-{2,})|(\. -)|(===)|(-\|)|(==>)|subgraph|^end$|class |style |click |participant|note |direction|actor |state |fork|^\s*[A-Za-z0-9_]+\[[A-Za-z0-9_]+\]|^\s*[A-Za-z0-9_]+\([A-Za-z0-9_]+\)/;

// mermaid 图起始声明
const MERMAID_START_RE =
  /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|journey|pie|mindmap|timeline|gitGraph|requirementDiagram)\b/i;

// 普通 Markdown 块级结构特征：遇到这些行时，未闭合的 mermaid 围栏应当先闭合，
// 避免把正文吞进 mermaid 代码块。
const MARKDOWN_BLOCK_RE =
  /^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|!\[|\[|={3,}|-{3,}|\*{3,}|:\s|```)/;

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
  if (t.startsWith("%%")) return true; // mermaid 注释行
  return MERMAID_BODY_RE.test(t);
}

function isLikelyMermaidLine(line: string): boolean {
  const t = line.trim();
  if (t === "") return true; // mermaid 块内允许空行
  if (t.startsWith("%%")) return true; // mermaid 注释行
  // 普通 Markdown 结构不属于 mermaid
  if (MARKDOWN_BLOCK_RE.test(t)) return false;
  return MERMAID_BODY_RE.test(t) || MERMAID_START_RE.test(t);
}

/**
 * 去除模型可能在外围包裹的 markdown 代码围栏（```markdown / ```md / ```），
 * 避免整篇文档被识别为代码块。
 *
 * 使用栈扫描匹配外层围栏，避免简单取 first/last ``` 导致误伤内部代码块（如 mermaid）。
 */
export function unwrapMarkdownFence(content: string): string {
  const lines = content.split("\n");
  if (lines.length === 0) return content;

  const first = lines[0].trim();
  if (!first.startsWith("```")) return content;

  const lang = first.slice(3).trim().toLowerCase();
  if (lang !== "" && lang !== "markdown" && lang !== "md") return content;

  let depth = 1; // 已进入外层围栏
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith("```")) continue;

    if (t === "```") {
      depth--;
    } else {
      // ```lang：开启新的内部围栏
      depth++;
    }

    if (depth === 0) {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) return content;
  return lines.slice(1, endIndex).join("\n").trim();
}

/** 规范化 AI 常见标题格式错误：#1. 标题 → # 1. 标题；## #2. 标题 → ## 2. 标题 */
export function normalizeHeadings(content: string): string {
  return content.replace(/^(#{1,6})\s*#?\s*(\d+\..*)$/gm, "$1 $2");
}

/**
 * 补全 / 归一 mermaid 围栏：
 * 1. 已正确闭合的 ```mermaid 块：原样透传。
 * 2. 未闭合的 ```mermaid 块：遇到明显非 mermaid 的 Markdown 结构时自动闭合，
 *    避免后续正文被吞进 mermaid 代码块渲染成黑底。
 * 3. 裸写的 mermaid 语法：自动补 ```mermaid 围栏。
 */
export function ensureMermaidFences(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];

  enum State {
    Normal,
    InMermaidFence,
    InOtherFence,
    InRawMermaid,
  }
  let state = State.Normal;
  let block: string[] = [];

  const flushMermaid = () => {
    if (block.length) {
      result.push("```mermaid");
      result.push(...block);
      result.push("```");
      block = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    switch (state) {
      case State.Normal:
        if (trimmed.startsWith("```mermaid")) {
          state = State.InMermaidFence;
          block = [];
        } else if (trimmed.startsWith("```")) {
          state = State.InOtherFence;
          result.push(line);
        } else if (isMermaidStart(line)) {
          state = State.InRawMermaid;
          block = [line];
        } else {
          result.push(line);
        }
        break;

      case State.InOtherFence:
        result.push(line);
        if (trimmed === "```") {
          state = State.Normal;
        }
        break;

      case State.InMermaidFence:
        if (trimmed === "```") {
          flushMermaid();
          state = State.Normal;
        } else if (trimmed.startsWith("```")) {
          // 嵌套 fence（罕见）：先闭合当前 mermaid，再处理新 fence
          flushMermaid();
          if (trimmed.startsWith("```mermaid")) {
            state = State.InMermaidFence;
            block = [];
          } else {
            state = State.InOtherFence;
            result.push(line);
          }
        } else if (block.length > 0 && !isLikelyMermaidLine(trimmed)) {
          // 该行明显不属于 mermaid：提前闭合，避免吞掉正文
          flushMermaid();
          state = State.Normal;
          result.push(line);
        } else {
          block.push(line);
        }
        break;

      case State.InRawMermaid:
        if (trimmed === "" || trimmed.startsWith("#") || !looksLikeMermaidBody(line)) {
          flushMermaid();
          state = State.Normal;
          result.push(line);
        } else {
          block.push(line);
        }
        break;
    }
  }

  // 文档结束：若还有未闭合的 mermaid，强制闭合
  if (state === State.InMermaidFence || state === State.InRawMermaid) {
    flushMermaid();
  }

  return result.join("\n").trim();
}

// 把节点文本里的英文双引号 " 成对替换为中文引号 “ ”。
function fixQuotesInNodeText(code: string): string {
  let open = true;
  return code.replace(/"/g, () => {
    const ch = open ? "\u201C" : "\u201D"; // “ 或 ”
    open = !open;
    return ch;
  });
}

/**
 * 清洗文档中所有 mermaid 代码块里的英文双引号（节点文本用）。
 * mermaid 把 " 视为字符串定界符，模型偶发用英文引号包裹强调词会导致语法断裂。
 */
export function sanitizeMermaidQuotes(text: string): string {
  return text.replace(/```mermaid\s*\n([\s\S]*?)```/gi, (whole, code: string) => {
    return "```mermaid\n" + fixQuotesInNodeText(code) + "```";
  });
}

// 把模型偶发的单反引号 mermaid 围栏（`mermaid ... `）归一为三反引号围栏。
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
    if (trimmed.startsWith("```")) {
      flush();
      out.push(line);
      continue;
    }
    if (trimmed.startsWith("`") && /^`mermaid(\s.*)?$/.test(trimmed)) {
      if (!block) block = [];
      continue;
    }
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
function repairMermaidBody(body: string): string {
  let code = body;

  // 中文全角箭头 → 不被 mermaid 支持，移除
  code = code.replace(/→/g, "");

  // 奇数个英文双引号：按奇偶替换成中文引号，避免未闭合字符串
  const quoteCount = (code.match(/"/g) || []).length;
  if (quoteCount % 2 === 1) {
    let open = true;
    code = code.replace(/"/g, () => {
      const ch = open ? "\u201C" : "\u201D";
      open = !open;
      return ch;
    });
  }

  // 句末残留裸英文分号清理
  code = code.replace(/;\s*$/gm, "");

  return code;
}

// 轻量 mermaid 语法校验：判定一个图体是否「很可能」合法。
function looksValidMermaid(body: string): boolean {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  if (!MERMAID_START_RE.test(lines[0])) return false;
  const quoteCount = (body.match(/"/g) || []).length;
  if (quoteCount % 2 === 1) return false;
  if (body.includes("→")) return false;
  return true;
}

/**
 * 落库前对文档内所有 mermaid 代码块做「围栏归一 + 语法校验/修复」。
 * 已是正确三反引号且语法合法的文档原样返回；无法安全修复时保留原块，绝不清空内容。
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
    return emit(body);
  });
}

/**
 * 前端 / 后端统一入口：对 AI 原始 Markdown 做完整防御性规范化。
 */
export function normalizeMarkdown(content: string): string {
  let out = unwrapMarkdownFence(content);
  out = normalizeHeadings(out);
  out = ensureMermaidFences(out);
  out = sanitizeMermaidQuotes(out);
  out = validateMermaidBlocks(out);
  return out.trim();
}
