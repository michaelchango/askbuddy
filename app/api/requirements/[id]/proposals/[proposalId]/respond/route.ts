import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { getRequirement } from "@/lib/services/requirements";
import { getProject } from "@/lib/services/projects";
import {
  respondProposal,
  buildProceedPrompt,
  type ProposalPayload,
} from "@/lib/services/proposals";
import { setAwaitingConfirm } from "@/lib/services/steps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const respondSchema = z.object({
  decision: z.enum(["accept", "edit", "ignore"]),
  editedPayload: z.unknown().optional(),
});

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

// POST：响应单条建议（accept / edit / ignore）。
// 阶段闸门（AD-4）：当该阶段所有建议都决策后，打开 awaitingConfirm，
// 并返回 proceed_prompt 供前端弹出确认双按钮。
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; proposalId: string } }
) {
  const auth = await authorize(params.id);
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => ({}));
  const parsed = respondSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  try {
    const result = await respondProposal({
      suggestionId: params.proposalId,
      decision: parsed.data.decision,
      editedPayload: parsed.data.editedPayload as ProposalPayload | undefined,
    });

    let proceedPrompt = null as ReturnType<typeof buildProceedPrompt> | null;
    if (result.stageResolved) {
      await setAwaitingConfirm(params.id, result.step as Parameters<typeof setAwaitingConfirm>[1], true).catch(() => {});
      proceedPrompt = buildProceedPrompt(result.targetType, result.version);
    }

    return NextResponse.json({
      ok: true,
      data: {
        action: result.action,
        targetType: result.targetType,
        version: result.version,
        decisionId: result.decisionId,
        stageResolved: result.stageResolved,
        step: result.step,
        proceedPrompt,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
