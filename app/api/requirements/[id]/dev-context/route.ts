import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getRequirement } from "@/lib/services/requirements";
import { getProject } from "@/lib/services/projects";
import { getDevContext, listDevContextVersions } from "@/lib/services/devcontext";
import { buildHints, type CompletenessReport } from "@/lib/services/devcontext-validate";
import { runDevContextGeneration, type DevContextTrigger } from "@/lib/ai/steps/devcontext";
import type { SectionKey } from "@/lib/schemas/devcontext";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// 服务端内存缓存：DevContext 数据仅在 POST（重新生成）时变化，
// GET 读取完全可以短时缓存以减少对 CloudBase PG 连接池的压打。
//
// 同一 requirementId 在 TTL 内的重复 GET 直接返回缓存 JSON，
// 不消耗任何 DB 连接。POST 成功后主动失效对应 key。
// ---------------------------------------------------------------------------
const DC_CACHE_TTL_MS = 5000; // 5 秒——面板轮询基础间隔也是 5s，刚好 1:1 去重

interface DcCacheEntry {
  json: string;
  ts: number;
}
const dcCache = new Map<string, DcCacheEntry>();

function getCached(id: string): NextResponse<unknown> | null {
  const entry = dcCache.get(id);
  if (!entry) return null;
  if (Date.now() - entry.ts > DC_CACHE_TTL_MS) { dcCache.delete(id); return null; }
  return new NextResponse(entry.json, {
    status: 200,
    headers: { "Content-Type": "application/json", "X-Cache": "hit" },
  });
}

function setCached(id: string, data: unknown): void {
  dcCache.set(id, { json: JSON.stringify(data), ts: Date.now() });
}

function invalidateCache(id: string): void {
  dcCache.delete(id);
}

// 鉴权 + 归属校验（与 requirements/[id]/route.ts 同例）。
async function authorize(id: string) {
  const user = await getSession();
  if (!user) return { error: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  const req = await getRequirement(id);
  if (!req) return { error: NextResponse.json({ ok: false, error: "not_found" }, { status: 404 }) };
  const project = await getProject(req.projectId);
  if (!project || project.ownerId !== user.uid) {
    return { error: NextResponse.json({ ok: false, error: "not_found" }, { status: 404 }) };
  }
  return { error: null as NextResponse | null, user };
}

// GET：读取当前 DevContext（含评分与提示），无则返回 null。
// 服务端缓存 5s：面板轮询 5s 一次，刚好去重；POST 后主动失效。
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authorize(params.id);
  if (auth.error) return auth.error;

  // 缓存命中 → 零 DB 连接直接返回
  const hit = getCached(params.id);
  if (hit) return hit;

  const rec = await getDevContext(params.id);
  if (!rec) return NextResponse.json({ ok: true, data: null });

  const meta = (rec.content as Record<string, unknown>).meta as
    | { applicable_sections?: SectionKey[]; present_sections?: SectionKey[]; consistency_issues?: CompletenessReport["checks"] }
    | undefined;
  const applicable = (meta?.applicable_sections ?? []) as SectionKey[];
  const present = (meta?.present_sections ?? []) as SectionKey[];
  const issues = ((meta?.consistency_issues as unknown[]) ?? []) as Parameters<typeof buildHints>[1];

  const report: CompletenessReport = {
    score: rec.completeness_score,
    applicable,
    present,
    missing: applicable.filter((k) => !present.includes(k)),
    checks: [],
  };
  const hints = buildHints(report, issues);

  const versions = await listDevContextVersions(params.id).catch(() => []);

  const body = {
    ok: true,
    data: {
      content: rec.content,
      status: rec.status,
      completeness_score: rec.completeness_score,
      applicable_count: rec.applicable_count,
      present_count: rec.present_count,
      version: rec.current_version,
      updated_at: rec.updated_at,
      hints,
      versions,
    },
  };

  // 写入缓存（下次 GET 直接复用）
  setCached(params.id, body);

  return NextResponse.json(body);
}

// POST：手动重生成 DevContext（与 PRD 生成同源并列，独立非流式）。
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authorize(params.id);
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => ({}));
  const trigger = (body?.trigger ?? "manual") as DevContextTrigger;
  const changeNote = typeof body?.changeNote === "string" ? body.changeNote : undefined;

  try {
    const version = await runDevContextGeneration(params.id, {
      trigger,
      changeNote,
      // 超时由函数内部默认值（180s）或 DEVCONTEXT_TIMEOUT_MS 环境变量控制
    });
    // 重新生成成功 → 立即失效缓存，下次 GET 拉最新数据
    invalidateCache(params.id);
    return NextResponse.json({ ok: true, data: { version } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
