// 定向重算 API（M5-D2 · P2-5）。
//
// POST { sections?: DevContextSection[], mode?: 'targeted' | 'full', changeNote? }
//   - 缺省 sections → 读 dev_contexts.stale_sections（即「重算全部已标记过期的段」）
//   - mode='full'   → 逃生舱：全量重算（用户不信任定向结果时可用）
//
// 返回 SSE，**沿用既有事件契约**（gen_message / change_update / done / error），
// 不新增事件类型：前端 conversation-panel 与 requirement-shell 已有完整的监听链路，
// 新增事件 = 新增一组必须成对修改的耦合点，收益为零。
//
// 并发保护：同一 requirementId 重算期间，后来者 409。进程内 Map 即可——
// 当前是单实例 SSR，上分布式锁要引 Redis，收益为负。
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getRequirement } from "@/lib/services/requirements";
import { getProject } from "@/lib/services/projects";
import { clearStale, getDevContext } from "@/lib/services/devcontext";
import { invalidateDcCache } from "@/lib/services/devcontext-cache";
import {
  regenerateSections,
  runDevContextGeneration,
} from "@/lib/ai/steps/devcontext";
import {
  ALL_SECTIONS,
  isDevContextSection,
  type DevContextSection,
} from "@/lib/services/devcontext-impact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 在飞重算任务（值不用，只作占位；存在即代表该需求正在重算）。 */
const inFlight = new Map<string, Promise<void>>();

async function authorize(id: string) {
  const user = await getSession();
  if (!user) {
    return { error: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  }
  const req = await getRequirement(id);
  if (!req) {
    return { error: NextResponse.json({ ok: false, error: "not_found" }, { status: 404 }) };
  }
  const project = await getProject(req.projectId);
  if (!project || project.ownerId !== user.uid) {
    return { error: NextResponse.json({ ok: false, error: "not_found" }, { status: 404 }) };
  }
  return { error: null as NextResponse | null };
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authorize(params.id);
  if (auth.error) return auth.error;
  const requirementId = params.id;

  const parsed = await req.json().catch(() => ({}));

  // 「标记为无需更新」：承认确定性映射表会有**误报**（多标）。
  // 没有这个出口，用户面对自己认为无关的 stale 标记只能被迫花 token 重算——
  // 这与「宁可多算不可漏算」的 fail-safe 方向是配套的：多算的代价必须有人工出口。
  if (parsed?.mode === "dismiss") {
    const dismiss = Array.isArray(parsed?.sections)
      ? (parsed.sections as unknown[]).filter(isDevContextSection)
      : undefined;
    await clearStale(requirementId, dismiss as DevContextSection[] | undefined);
    invalidateDcCache(requirementId);
    return NextResponse.json({ ok: true, data: { dismissed: dismiss ?? "all" } });
  }

  if (inFlight.has(requirementId)) {
    return NextResponse.json(
      {
        ok: false,
        error: "REGENERATION_IN_PROGRESS",
        message: "该需求正在重算 DevContext，请等待本次完成后再试。",
      },
      { status: 409 }
    );
  }

  const body = parsed;
  const mode = body?.mode === "full" ? "full" : "targeted";
  const changeNote = typeof body?.changeNote === "string" ? body.changeNote : undefined;

  // 目标段：显式传入优先，否则取库里已标记过期的段
  let targets: DevContextSection[] = [];
  if (mode === "targeted") {
    const explicit = Array.isArray(body?.sections)
      ? (body.sections as unknown[]).filter(isDevContextSection)
      : [];
    if (explicit.length > 0) {
      targets = explicit as DevContextSection[];
    } else {
      const rec = await getDevContext(requirementId);
      if (!rec) {
        return NextResponse.json(
          { ok: false, error: "NO_DEVCONTEXT", message: "该需求还没有 DevContext，请先生成。" },
          { status: 400 }
        );
      }
      const stale = Array.isArray(rec.stale_sections) ? rec.stale_sections : [];
      targets = stale.filter(isDevContextSection) as DevContextSection[];
      if (targets.length === 0) {
        return NextResponse.json(
          {
            ok: false,
            error: "NO_STALE_SECTIONS",
            message: "当前没有标记为过期的段落；如需强制重算请用 mode:'full'。",
          },
          { status: 400 }
        );
      }
    }
  }

  // 同步占位锁：必须在返回 Response 之前写入，否则并发请求会在 start() 之前双双通过检查
  let release!: () => void;
  inFlight.set(requirementId, new Promise<void>((r) => { release = r; }));
  const releaseLock = () => {
    inFlight.delete(requirementId);
    release?.();
  };

  const encoder = new TextEncoder();
  const sse = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* 客户端已断开时 controller 可能已关闭，忽略 */
        }
      };
      try {
        if (mode === "full") {
          send("gen_message", { content: "正在全量重算 DevContext…" });
          const version = await runDevContextGeneration(requirementId, {
            trigger: "change_analysis",
            changeNote,
          });
          send("change_update", {
            devContext: {
              version,
              changed: ALL_SECTIONS,
              unchanged: [],
              escalated: false,
              mode: "full",
            },
          });
          send("done", { version });
        } else {
          send("gen_message", { content: `正在重算 ${targets.length} 段：${targets.join("、")}…` });
          const result = await regenerateSections(requirementId, targets, {
            trigger: "change_analysis",
            changeNote,
          });
          send("change_update", {
            devContext: {
              version: result.version,
              changed: result.changed,
              unchanged: result.unchanged,
              escalated: result.escalated,
              status: result.status,
              mode: "targeted",
            },
          });
          send("done", { version: result.version });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[dc-refresh] 重算失败:", message);
        send("error", { message });
      } finally {
        // 内容已变 → 让读取端立刻看到新快照（否则面板最多 5s 内读到旧 JSON）
        invalidateDcCache(requirementId);
        releaseLock();
        controller.close();
      }
    },
    cancel() {
      // 客户端提前断开也要放锁，否则该需求会被永久锁死
      releaseLock();
    },
  });

  return new Response(sse, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
