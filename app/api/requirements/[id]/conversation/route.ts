import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listConversations, addMessage } from "@/lib/services/conversations";
import { streamDialogue, finalizeDialogue } from "@/lib/ai/orchestrator";
import { maybeAutoTitle, touchRequirement, getRequirement, extractCardFromConversation, EMPTY_CARD } from "@/lib/services/requirements";
import { applyCardChange } from "@/lib/services/card";
import {
  getSteps,
  markStepInProgress,
  markStepPendingUpdate,
  setAwaitingConfirm,
  nextStepOf,
} from "@/lib/services/steps";
import { analyzeChanges } from "@/lib/services/change-analyzer";
import { db } from "@/lib/db";
import { isTransientSqlError } from "@/lib/db/cloudbase";
import type { RequirementStep, StepName, RequirementCard } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 对话历史接口：用于退出需求页再进入时完整回显会话记录（前端挂载即经 SWR 拉取）。
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const rows = await listConversations(params.id);
  return NextResponse.json({ ok: true, data: rows });
}

// 计算下一步骤：始终按标准流程（调研分析 → 方案设计 → 需求文档）推进。
// 复杂度仅影响 prompt 深度，不跳阶段——AI 分类 simple/standard/complex 不可靠，
// 跳过阶段应由用户主动操作（如点击"跳过"按钮），而非 AI 自动决定。
function computeNextStep(steps: RequirementStep[]): StepName | null {
  const order: StepName[] = ["research_analysis", "design", "prd_writing"];
  for (const s of order) {
    const st = steps.find((x) => x.step === s);
    if (st && st.state !== "done") return s;
  }
  return null;
}

// 输出物类型 → 步骤名
function outputToStep(output: string): StepName | null {
  const map: Record<string, StepName> = {
    card: "dialoguing",
    research_analysis: "research_analysis",
    design: "design",
    prd: "prd_writing",
  };
  return map[output] ?? null;
}

// 步骤中文标签（用于确认闸门话术）
const STAGE_LABELS: Record<string, string> = {
  dialoguing: "需求确认",
  research_analysis: "调研分析",
  design: "方案设计",
  prd_writing: "需求文档",
};

const OUTPUT_LABELS: Record<string, string> = {
  card: "需求卡片",
  research_analysis: "调研分析",
  design: "方案设计",
  prd: "需求文档",
};

// 识别「导航/确认/跳过」类指令（如"进入下一步""好的""跳过"）。
// 命中则跳过变更分析；若存在就绪阶段，进一步走 AUTO 早返回分支直接推进（省去一次 AI 调用）。
function isNavCommand(text: string): boolean {
  const t = (text || "").trim();
  if (!t || t.length > 25) return false; // 仅短指令判定，较长/描述性消息仍走变更分析
  // 含明显修改意图词的，不视为导航指令，仍走变更分析
  if (/修改|改(动|变)?|变更|调整|新增|增加|删(除|掉)|去掉|补充|更新|替换|重新写|重写|优化|细化/i.test(t))
    return false;
  return [
    /进入下一(步|阶段|环节)/,
    /确认进入|确认开始/,
    // 进入特定子阶段（如"进入原型设计"/"进入原型"/"进入调研分析"/"进入方案设计"/"进入需求文档"）
    // ——用户明确指定子阶段意图，必须走 AUTO 子阶段判定逻辑，否则 STREAM 把 AI 弄糊涂。
    /进入(原型设计|原型|调研分析|调研|方案设计|方案|需求文档|prd|调研报告)/i,
    /(开始|进行|做|生成|重新生成|继续).*(调研|分析|报告|方案|设计|原型|prd|需求文档)/i,
    /^(好的|好滴|可以|行|没问题|确认|确定|是的|对|ok|yes)/i,
    /^(跳过|下一步|继续)/i,
    /(完成|结束).*(调研|分析|报告|方案|设计|原型|prd)/i,
  ].some((re) => re.test(t));
}

// 找出可推进的「就绪阶段」：优先 awaitingConfirm（模型/上一轮已判定达标），其次 in_progress。
// 返回 { step, nextStep, awaiting }；若没有任何就绪阶段（如 dialoguing 尚未开始）返回 null，避免误推进。
function computeCurrentReadyStep(
  steps: RequirementStep[]
): { step: StepName; nextStep: StepName | null; awaiting: boolean } | null {
  const awaiting = steps.find((s) => s.awaitingConfirm && s.state !== "done");
  if (awaiting)
    return { step: awaiting.step, nextStep: nextStepOf(awaiting.step), awaiting: true };
  const inProgress = steps.find((s) => s.state === "in_progress");
  if (inProgress)
    return { step: inProgress.step, nextStep: nextStepOf(inProgress.step), awaiting: false };
  return null;
}

// 弱确认词：好的/可以/确认/没问题/明白了/OK 等。这类词仅在阶段已就绪（awaitingConfirm）时才推进，
// 避免对话中途一句"好的"误跳过需求采集等阶段。
const weakConfirmPattern = /^(好的|好滴|可以|行|没问题|确认|确定|是的|对|明白|了解|ok|yes)/i;

// 用户主动确认推进时的合成回复话术（保证非空，修复气泡消失）
function proceedReplyText(step: StepName, nextStep: StepName | null): string {
  if (!nextStep) return `好的，${STAGE_LABELS[step] ?? ""}已完成，已为您标记完成。`;
  return `好的，${STAGE_LABELS[step] ?? ""}已确认。正在为您推进到「${STAGE_LABELS[nextStep]}」…`;
}

// 步骤名 → 输出物类型（outputToStep 的逆映射）
const STEP_TO_OUTPUT: Record<string, string> = {
  research_analysis: "research_analysis",
  design: "design",
  prd_writing: "prd",
};

// 变更边界窗口：候选 = 需求卡片 + 所有已生成（done/in_progress）的输出物。
// 【未开始】的下游一律排除——变更时绝不生成尚未开始的文档。
function computeCandidates(steps: RequirementStep[]): string[] {
  const out = ["card"];
  for (const s of steps) {
    if (s.step === "dialoguing") continue;
    if (s.state === "done" || s.state === "in_progress") {
      const o = STEP_TO_OUTPUT[s.step];
      if (o) out.push(o);
    }
  }
  return out;
}

// 统计需求卡片中「已填写实质内容」的字段数（占位式"（…）"视为未填）。
// 与下方渐进抽取后的卡片完备度判定共用，决定是否需要再触发一次 AI 抽取、以及需求确认是否达标。
function countFilled(card?: RequirementCard): number {
  if (!card) return 0;
  return Object.values(card).filter(
    (v) => typeof v === "string" && v.trim().length >= 3 && !v.startsWith("（")
  ).length;
}

// 对话流式接口
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const message = body?.message ?? "";
  const references = body?.references ?? [];

  const requirementId = params.id;
  const stepsBefore: RequirementStep[] = await getSteps(requirementId);

  await addMessage(requirementId, "user", message);
  // 任何一次对话（正常对话 / 变更请求 / 导航确认）都刷新需求的「最近更新」时间，
  // 覆盖后续三个分支（变更分析、导航推进、正常对话），确保需求卡片时间准确。
  await touchRequirement(requirementId).catch(() => {});

  // ===== 变更点预分析 =====
  // 是否已有【已完成】或【进行中】的输出物（有则可能是变更请求）。
  // 修复：刚生成但未确认的输出物状态是 in_progress，也必须纳入变更检测，
  // 否则用户提出修改时变更分析整段被跳过，只能更新卡片而漏掉已生成的文档。
  const hasExistingOutputs = stepsBefore.some(
    (s) => (s.state === "done" || s.state === "in_progress") && s.step !== "dialoguing"
  );

  if (hasExistingOutputs && !isNavCommand(message)) {
    // P1 边界窗口：候选 = card + 已生成（done/in_progress）输出物，not_started 排除
    const candidates = computeCandidates(stepsBefore);
    // P2 比对判定：把候选输出物的真实内容交给 AI 做级联判定
    const changes = await analyzeChanges(requirementId, message, { candidates });
    if (changes && changes.affectedOutputs.length > 0) {
      // 后端兜底过滤：AI 判定结果必须是候选窗口子集；
      // 文档类还需再核对步骤状态（done/in_progress），避免越级首次生成。
      const affectedOutputs = changes.affectedOutputs.filter((o) => {
        if (!candidates.includes(o)) return false;
        if (o === "card") return true;
        const s = outputToStep(o);
        if (!s || s === "dialoguing") return false;
        const st = stepsBefore.find((x) => x.step === s);
        return st?.state === "done" || st?.state === "in_progress";
      });
      if (affectedOutputs.length === 0) {
        // 全部被窗口过滤掉 → 不构成有效变更，走正常对话
      } else {
      const encoder = new TextEncoder();
      const sse = new ReadableStream({
        async start(controller) {
          try {
            const affectedList = affectedOutputs
              .map((o) => `- ${OUTPUT_LABELS[o] ?? o}`)
              .join("\n");

            const changeReply = `收到！我检测到你的修改涉及以下内容：\n\n${affectedList}\n\n${changes.summary}\n\n正在为你自动更新…`;
            await addMessage(requirementId, "assistant", changeReply);
            controller.enqueue(
              encoder.encode(`event: delta\ndata: ${JSON.stringify(changeReply)}\n\n`)
            );

            // P3-1 卡片受影响：同步聚焦合并（不进重生成队列），
            // 保证后续下游重生成读到的是更新后的新卡片。
            if (affectedOutputs.includes("card")) {
              const cardChangeText = [
                `用户变更请求：${message}`,
                ...changes.changes
                  .filter((c) => c.output === "card")
                  .map((c) => `- ${c.field}: ${c.description}`),
              ].join("\n");
              // 第三参为版本 note：变更定版时写入 card_versions.note 形成变更记录
              await applyCardChange(requirementId, cardChangeText, changes.summary).catch(() => {});
              // 通知前端刷新卡片
              const reqNow = await getRequirement(requirementId).catch(() => null);
              if (reqNow?.card) {
                controller.enqueue(
                  encoder.encode(`event: card\ndata: ${JSON.stringify(reqNow.card)}\n\n`)
                );
              }
            }

            // P3-2 受影响的文档步骤置为【待更新】，由前端按依赖顺序串行重生成
            const affectedSteps = affectedOutputs
              .map((o) => outputToStep(o))
              .filter((s): s is StepName => s !== null && s !== "dialoguing");
            for (const s of affectedSteps) {
              await markStepPendingUpdate(requirementId, s);
            }

            const steps = await getSteps(requirementId);
            controller.enqueue(
              encoder.encode(`event: step_update\ndata: ${JSON.stringify(steps)}\n\n`)
            );

            controller.enqueue(
              encoder.encode(
                `event: change_update\ndata: ${JSON.stringify({
                  affectedOutputs,
                  changes: changes.changes,
                  summary: changes.summary,
                })}\n\n`
              )
            );

            controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`));
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            controller.enqueue(
              encoder.encode(`event: error\ndata: ${JSON.stringify({ message: m })}\n\n`)
            );
          } finally {
            controller.close();
          }
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
    }
  }

  // ===== 用户主动推进（AUTO 分支，早返回）=====
  // 用户主动发送确认/导航短指令（强指令+弱确认词）且存在就绪阶段时，
  // 直接走与右上角按钮相同的 handleProceed 调度：合成非空回复 + emit proceed_prompt{auto:true}，
  // 省去一次 AI 调用，并修复「气泡消失/聊天不推进」问题。
  if (isNavCommand(message)) {
    const ready = computeCurrentReadyStep(stepsBefore);
    if (ready) {
      const isWeak = weakConfirmPattern.test(message.trim());
      // 弱确认词仅在模型已标记阶段就绪（awaitingConfirm）时推进，避免中途误跳阶段；
      // 强指令（进入下一阶段/开始调研等）只要有就绪阶段即推进。
      if (isWeak && !ready.awaiting) {
        // 落空：交给下方正常对话流程，让模型继续澄清需求
      } else {
      const { step } = ready;
      // design 步骤含「方案文档 → 原型设计」两个子阶段：若原型尚未生成，
      // 确认后应先进原型设计子阶段（subPhase=prototype），而非直接跳到需求文档，
      // 与右上角按钮（design/route.ts 下发 subPhase）行为保持一致。
      let subPhase: "prototype" | undefined;
      let effectiveNextStep: StepName | null = ready.nextStep;
      if (step === "design" && ready.nextStep) {
        const proto = await db
          .get<{ current_version?: number }>("prototypes", requirementId, "requirement_id")
          .catch(() => null);
        const protoExists = !!proto && (proto.current_version ?? 0) > 0;
        if (!protoExists) {
          subPhase = "prototype";
          effectiveNextStep = null;
        }
      }
      const encoder = new TextEncoder();
      const replyText =
        subPhase === "prototype"
          ? `✅ 已确认「${STAGE_LABELS[step] ?? ""}」的方案文档，正在为您进入『原型设计（交互原型）』…`
          : proceedReplyText(step, effectiveNextStep);
      await addMessage(requirementId, "assistant", replyText);
      // 置为待确认（若后续因竞态未自动推进，仍保留开门状态）
      await setAwaitingConfirm(requirementId, step, true).catch(() => {});
      const finalSteps = await getSteps(requirementId);
      const sse = new ReadableStream({
        async start(controller) {
          try {
            controller.enqueue(
              encoder.encode(`event: reply\ndata: ${JSON.stringify(replyText)}\n\n`)
            );
            controller.enqueue(
              encoder.encode(`event: step_update\ndata: ${JSON.stringify(finalSteps)}\n\n`)
            );
            // 末阶段（effectiveNextStep 为 null 且无原型子阶段）不自动推进，改为开门等用户确认完成；
            // 原型子阶段虽 effectiveNextStep 为 null，但需以 auto 自动进入原型设计。
            const auto = subPhase === "prototype" ? true : !!effectiveNextStep;
            controller.enqueue(
              encoder.encode(
                `event: proceed_prompt\ndata: ${JSON.stringify({
                  step,
                  nextStep: effectiveNextStep,
                  subPhase,
                  canSkip: false,
                  message: auto
                    ? `${STAGE_LABELS[step] ?? ""}${
                        subPhase === "prototype"
                          ? "的方案文档已确认，正在进入原型设计…"
                          : "已确认，正在推进到下一阶段…"
                      }`
                    : `${STAGE_LABELS[step] ?? ""}已完成，请确认。`,
                  auto,
                })}\n\n`
              )
            );
            controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`));
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            controller.enqueue(
              encoder.encode(`event: error\ndata: ${JSON.stringify({ message: m })}\n\n`)
            );
          } finally {
            controller.close();
          }
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
  }
  }

  // ===== 正常对话流程 =====
  const stream = await streamDialogue(requirementId, message, references);
  const encoder = new TextEncoder();
  let full = "";

  const sse = new ReadableStream({
    async start(controller) {
      // 回复是否已通过 SSE 下发给用户。一旦为 true，后续任何瞬时 DB 故障都不再致命
      // （用户已拿到 AI 回复，仅本轮卡片/落库可能延迟，下轮补齐），而是降级为可恢复错误 + done。
      let replySent = false;
      try {
        const reader = stream.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          full += value;
          controller.enqueue(
            encoder.encode(`event: delta\ndata: ${JSON.stringify(value)}\n\n`)
          );
        }

        // finalizeDialogue 内部要读历史消息（DB）。连接池瞬时耗尽时不该让整轮致命：
        // 失败则退化为「请重试」提示，仍完整走完 reply/done，避免对话流断裂。
        let reply = "";
        try {
          const r = await finalizeDialogue(requirementId, full);
          reply = r.reply;
        } catch (e) {
          console.error(
            "[conversation] finalizeDialogue 失败（降级为重试提示）:",
            e instanceof Error ? e.message : String(e)
          );
          reply = "抱歉，刚才网络有点波动，没能生成回复。请再发一次，或稍等片刻重试～";
        }

        // [STEP_COMPLETE]/[COMPLEXITY] 按 prompt 约定位于 json 围栏之后，
        // 而 reply 只截取围栏之前文本——必须从完整流 full 检测，否则永远读不到标记
        let stepReady = /\[STEP_COMPLETE\]/.test(full);
        const complexityMatch = full.match(/\[COMPLEXITY:\s*(simple|standard|complex)\s*\]/i);
        const complexity = complexityMatch?.[1]?.toLowerCase();

        const cleanReply = reply
          .replace(/\[STEP_COMPLETE\]/g, "")
          .replace(/\[COMPLEXITY:\s*\w+\s*\]/gi, "")
          .trim();

        // 需求确认阶段的状态判断
        const dialoguingStep = stepsBefore.find((s) => s.step === "dialoguing");
        const dialoguingAlreadyDone = dialoguingStep?.state === "done";

        // 对话气泡始终展示 AI 的真实回复，不再用后端模板覆盖模型输出。
        // 阶段切换提示统一由 proceed_prompt 事件在顶栏阶段条呈现（双按钮闸门）。
        const finalReply = cleanReply;

        // 助手回复落库：回复已通过 SSE 发给用户，落库失败仅影响历史持久化，属可恢复，
        // 不应阻断本轮（下轮对话会重新抽取/补齐）。
        try {
          await addMessage(requirementId, "assistant", finalReply);
        } catch (e) {
          console.error(
            "[conversation] 助手消息落库失败（非致命）:",
            e instanceof Error ? e.message : String(e)
          );
        }

        // 渐进抽取需求卡片：独立于「模型是否在回复里夹带 JSON 卡片块」，把整段对话
        // 交给专门的 extract-card prompt 压缩为结构化卡片，再增量合并写回。
        // mergeRequirementCard 只填非空、覆盖已有值，故支持逐步完善与对话中纠正。
        // 仅当合并后字段仍不足 4 个时触发一次额外 AI 调用，避免每轮都多一次模型请求。
        // 卡片抽取依赖一次 getRequirement（SELECT requirements）。该读可能因连接池瞬时
        // 耗尽 (EMAXCONNSESSION) 抛错——若在此硬失败，reply/card 都来不及下发，整轮对话
        // 直接炸成致命错误横幅且无法自动消除。故整段包进 try/catch：读/抽失败仅跳过本次
        // 卡片更新，reply 照常下发、done 照常结束；卡片稍后由前端 SWR 重新拉取或在下一轮补齐。
        let liveCard: RequirementCard | null = null;
        try {
          // 【测试钩子，仅 FORCE_CONV_CARD_FAIL=1 时生效，生产无此变量即零副作用】
          // 确定性复现「对话轮卡片抽取读库(SELECT requirements)瞬时失败」：在此处抛错，
          // 验证整轮仍能下发 reply/done、前端错误横幅不再残留（这正是用户报的卡死场景）。
          if (process.env.FORCE_CONV_CARD_FAIL === "1") {
            throw new Error(
              'exec-pgsql HTTP 400: {"code":"DATABASE_XX000","message":"(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 10"}'
            );
          }
          const cur = await getRequirement(requirementId);
          const base = cur?.card ?? { ...EMPTY_CARD };
          if (countFilled(base) < 4) {
            liveCard = await extractCardFromConversation(requirementId).catch(() => base);
          } else {
            liveCard = base;
          }
          const filledFields = Object.values(liveCard).filter(
            (v) => typeof v === "string" && v.trim().length >= 3 && !v.startsWith("（")
          ).length;
          if (filledFields >= 4) stepReady = true;
        } catch (e) {
          console.error(
            "[conversation] 卡片抽取跳过（瞬时 DB 故障，不影响本轮 AI 回复）:",
            e instanceof Error ? e.message : String(e)
          );
        }

        // 修复空回复：模型可能仅输出卡片 JSON 无正文（reply 为空），
        // 落库的 finalReply 从未流式发出。此处以 reply 事件补发清理后的正式回复，
        // 前端 done 时优先使用它渲染气泡。
        controller.enqueue(
          encoder.encode(`event: reply\ndata: ${JSON.stringify(finalReply)}\n\n`)
        );

        // 卡片抽取成功才下发 card 事件；失败则不发，避免把右侧面板已填好的卡片清空。
        if (liveCard) {
          controller.enqueue(encoder.encode(`event: card\ndata: ${JSON.stringify(liveCard)}\n\n`));
        }

        // 写库兜底：autoTitle / 阶段状态写入为非必要副作用，连接池耗尽(EMAXCONNSESSION)等
        // 瞬时故障不应让整条 SSE 流断裂。reply/card 已先发出，此处失败仅「阶段闸门未自动
        // 打开」，发 recoverable 错误事件并照常 done，使高并发下的第三个用户软降级而非硬 500。
        try {
        const autoTitle = await maybeAutoTitle(requirementId);
        if (autoTitle) {
          controller.enqueue(
            encoder.encode(`event: title\ndata: ${JSON.stringify({ title: autoTitle })}\n\n`)
          );
        }

        if (stepReady && !dialoguingAlreadyDone) {
          // 需求确认达标：不自动推进。需求确认保持【进行中】并打开确认闸门，
          // 等待用户在阶段栏点击【确认并进入下一阶段】后才置【已完成】并生成下一节点。
          // 注意：严禁在此把 research_analysis / prd_writing 提前置【进行中】，
          // 否则会出现"调研先于需求确认变进行中"的顺序错乱。
          // 复杂度标记不再用于跳过阶段，仅作为 prompt 深度提示保留在 card/req 元数据中。

          await setAwaitingConfirm(requirementId, "dialoguing", true);

          const steps = await getSteps(requirementId);
          controller.enqueue(
            encoder.encode(`event: step_update\ndata: ${JSON.stringify(steps)}\n\n`)
          );

          const nextStep = computeNextStep(steps);
          controller.enqueue(
            encoder.encode(
              `event: proceed_prompt\ndata: ${JSON.stringify({
                step: "dialoguing",
                nextStep,
                canSkip: false,
                message: "需求确认已完成，请确认后进入下一阶段。",
              })}\n\n`
            )
          );
        } else {
          // 普通对话轮次：仅当需求确认尚未开始时置为【进行中】；
          // 若已完成则保持不动（避免从【已完成】回退到【进行中】）。
          if (dialoguingStep?.state === "not_started") {
            await markStepInProgress(requirementId, "dialoguing");
          }
          const steps = await getSteps(requirementId);
          controller.enqueue(
            encoder.encode(`event: step_update\ndata: ${JSON.stringify(steps)}\n\n`)
          );
        }
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({
                message: "阶段状态保存失败：AI 回复与卡片已更新，请稍后点击重试",
                recoverable: true,
                detail: m.slice(0, 200),
              })}\n\n`
            )
          );
        }

        controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`));
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        // 回复已下发后的瞬时 DB 故障（连接池耗尽等）：降级为可恢复错误并照常 done，
        // 不让整条对话流变成致命横幅——用户已收到 AI 回复，仅本轮卡片/落库可能延迟，下轮补齐。
        if (replySent && isTransientSqlError(e)) {
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({
                message: "网络波动，本轮内容已生成，部分保存可能稍延迟，可继续对话",
                recoverable: true,
              })}\n\n`
            )
          );
          controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`));
        } else {
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify({ message: m })}\n\n`)
          );
        }
      } finally {
        controller.close();
      }
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
