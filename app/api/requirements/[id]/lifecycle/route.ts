// 需求生命周期 API（M5-D1）。
//
// GET  → { lifecycle, available, blockers }：一次返回「当前态 + 可去哪 + 每条路被什么挡着」，
//        前端按钮的禁用态与 tooltip 一次拿全，避免 N 次请求。
// POST → { to, reason?, force? }：checkGate → block 409 → assertTransition 400 → 迁移。
//        to='restore' 特例：解档（清 archived_at，回到最近一次归档前的态）。
//
// 闸门规则只有服务端一份（requirement-status.ts::checkGate）——这是防止
// 「前端复制一份闸门规则后两边漂移」的唯一办法。

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getRequirement } from "@/lib/services/requirements";
import { getProject } from "@/lib/services/projects";
import { getSteps } from "@/lib/services/steps";
import {
  assertTransition,
  availableTransitions,
  LifecycleReasonRequiredError,
  LifecycleTransitionError,
  type RequirementLifecycle,
} from "@/lib/requirement-lifecycle";
import {
  checkGate,
  getLifecycle,
  restoreFromArchive,
  transitionLifecycle,
  type GateBlocker,
} from "@/lib/services/requirement-status";

/** 归属校验：需求存在 + 所属项目属于当前会话用户（与其余 requirement 路由同模式）。 */
async function authorize(requirementId: string) {
  const user = await getSession();
  if (!user) return { error: "unauthorized" as const, uid: "" };
  const req = await getRequirement(requirementId);
  if (!req) return { error: "not_found" as const, uid: "" };
  const projectId = (req as unknown as Record<string, unknown>).projectId as string;
  const project = await getProject(projectId);
  if (!project || project.ownerId !== user.uid) {
    return { error: "not_found" as const, uid: "" };
  }
  return { error: null, uid: user.uid };
}

function errorResponse(auth: { error: "unauthorized" | "not_found" }) {
  return NextResponse.json(
    { ok: false, error: auth.error },
    { status: auth.error === "unauthorized" ? 401 : 404 }
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authorize(params.id);
  if (auth.error) return errorResponse(auth);

  const lifecycle = await getLifecycle(params.id);
  const available = availableTransitions(lifecycle);
  const blockers: Partial<Record<RequirementLifecycle, GateBlocker[]>> = {};
  for (const to of available) {
    blockers[to] = await checkGate(params.id, to);
  }

  return NextResponse.json({
    ok: true,
    data: { lifecycle, available, blockers, steps: await getSteps(params.id) },
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authorize(params.id);
  if (auth.error) return errorResponse(auth);

  const body = await req.json().catch(() => null);
  const to = body?.to as string;
  const reason = typeof body?.reason === "string" ? body.reason : undefined;
  const force = body?.force === true;

  // 解档特例：清 archived_at，回到归档前的态（archived 在邻接表里仍是形式终态）。
  if (to === "restore") {
    try {
      const lifecycle = await restoreFromArchive(params.id, auth.uid);
      return NextResponse.json({
        ok: true,
        data: { lifecycle, steps: await getSteps(params.id) },
      });
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: "bad_request", message: (e as Error).message },
        { status: 400 }
      );
    }
  }

  if (
    !["created", "dialoguing", "designing", "review", "completed", "archived"].includes(to)
  ) {
    return NextResponse.json(
      { ok: false, error: "invalid_input", message: "未知的目标生命周期" },
      { status: 400 }
    );
  }
  const target = to as RequirementLifecycle;

  // 顺序不可颠倒：【合法性】先于【闸门】。
  //   created → completed 这类路径在邻接表里根本不存在，是 400（客户端错误）；
  //   若先跑 checkGate，会因为「步骤未完成」被误判为 409（语义是"路径合法但条件不满足"）。
  // 读到的当前态透传给 transitionLifecycle，避免为同一次校验多付一次跨网关往返。
  const current = await getLifecycle(params.id);
  try {
    assertTransition(current, target);
  } catch (e) {
    if (e instanceof LifecycleTransitionError) {
      return NextResponse.json(
        { ok: false, error: "invalid_transition", message: e.message },
        { status: 400 }
      );
    }
    throw e;
  }

  // 闸门：block 级未 force → 409 带全部 blockers（warn 级只提示不拦截）。
  const blockers = await checkGate(params.id, target);
  const blocking = blockers.filter((b) => b.severity === "block");
  if (blocking.length > 0 && !force) {
    return NextResponse.json(
      { ok: false, error: "blocked", data: { blockers } },
      { status: 409 }
    );
  }

  try {
    const lifecycle = await transitionLifecycle(params.id, target, {
      actor: auth.uid,
      reason,
      from: current,
    });
    return NextResponse.json({
      ok: true,
      data: { lifecycle, blockers, steps: await getSteps(params.id) },
    });
  } catch (e) {
    if (e instanceof LifecycleTransitionError) {
      // 非法迁移：400 + 允许列表（message 已含）
      return NextResponse.json(
        { ok: false, error: "invalid_transition", message: e.message },
        { status: 400 }
      );
    }
    if (e instanceof LifecycleReasonRequiredError) {
      // 缺 reason 是用户输入问题（UI 会弹输入框），必须是 400 而非 500
      return NextResponse.json(
        { ok: false, error: "reason_required", message: e.message },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { ok: false, error: "server_error", message: (e as Error).message },
      { status: 500 }
    );
  }
}
