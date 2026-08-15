"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import useSWR, { mutate as globalMutate } from "swr";
import { ChevronRight, ChevronDown, PanelRightOpen } from "lucide-react";
import {
  UserContext,
  type ShellUser,
} from "@/components/layout/dashboard-shell";
import { OutputSidebar } from "@/components/requirements/output-sidebar";
import { OutputViewer } from "@/components/requirements/output-viewer";
import { DevContextPanel } from "@/components/requirements/devcontext-panel";
import StepNavigator from "@/components/requirements/step-navigator";
import { WorkflowContext, type WorkflowState, type PendingPrompt, type ChangeTask } from "@/components/requirements/workflow-context";
import type { OutputMeta, OutputType } from "@/lib/services/outputs";
import { nextStepOf } from "@/lib/steps-meta";
import type { RequirementStatus, RequirementStep, StepName } from "@/types";
import { STAGE_LABELS, proceedReplyText } from "@/lib/stage-meta";
import { cn } from "@/lib/utils";
import { EVT, pendingGenMessages, pendingChangeComplete } from "@/lib/events";
// 注意：DevContext 后台生成的 abort 由后端 route（conversation/prd）在
// req.signal.aborted 时自动调用 abortDcGen；客户端只需 abort 当前 SSE 流，
// 因此此处不再 import 服务端模块（依赖 @cloudbase/node-sdk 与 fs）。
import { requirementStatusMeta } from "@/lib/display";
import {
  requestPermission,
  notifyOutputComplete,
  notifyChangeComplete,
} from "@/lib/notification";

// 步骤 → 通知中展示的输出物名称（card 不通知，映射为空）
const OUTPUT_NOTIFY_LABEL: Record<StepName, string> = {
  dialoguing: "",
  research_analysis: "调研报告",
  design: "方案文档",
  prd_writing: "需求文档",
};

const STATUS_LABEL: Record<RequirementStatus, string> = {
  dialoguing: "需求确认",
  researching: "调研分析",
  designing: "方案设计",
  prd_writing: "需求文档",
  completed: "已完成",
  archived: "已归档",
}

interface RequirementInfo {
  id: string;
  title: string;
  status: RequirementStatus;
  projectId: string;
}

const reqFetcher = async (url: string) => {
  const res = await fetch(url);
  const d = await res.json();
  return d.ok ? d.data : null;
};
const listFetcher = async (url: string) => {
  const res = await fetch(url);
  const d = await res.json();
  return d.ok ? d.data : [];
};

// 步骤 → 输出物类型映射
const STEP_TO_OUTPUT: Record<StepName, OutputType> = {
  dialoguing: "card",
  research_analysis: "research_analysis",
  design: "design",
  prd_writing: "prd",
};

// 步骤 → 生成 API 路径
const STEP_TO_API: Record<StepName, string> = {
  dialoguing: "",
  research_analysis: "/api/requirements/$id/research-analysis",
  design: "/api/requirements/$id/design",
  prd_writing: "/api/requirements/$id/prd",
};

const STEP_LABELS: Record<StepName, string> = {
  dialoguing: "需求确认",
  research_analysis: "调研分析",
  design: "方案设计",
  prd_writing: "需求文档",
};

/**
 * 需求内部壳：替换全局顶栏 + 全局左侧导航。
 * v2：加入 WorkflowContext，统一编排生成流程（对话→输出物→进度条联动）。
 */
export function RequirementShell({
  user,
  requirementId,
  children,
}: {
  user: ShellUser;
  requirementId: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [breadOpen, setBreadOpen] = useState(false);
  const [selected, setSelected] = useState<{ type: OutputType; subType?: string } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState(460);
  const skipAutoRef = useRef(false);
  // 记录收起右侧栏前的产物，供窄边"产物"按钮恢复
  const lastSelectedRef = useRef<{ type: OutputType; subType?: string } | null>(null);

  // 生成编排状态
  const [generatingStep, setGeneratingStep] = useState<StepName | null>(null);
  const generatingStepRef = useRef<StepName | null>(null);
  // 当前文档生成流的 AbortController，组件卸载时中止后台 SSE，避免已离开页面仍在派发事件
  const genAbortRef = useRef<AbortController | null>(null);
  // 变更重生成队列的中断信号：用户主动停止时 abort，串行循环每轮开始检查，命中则中断后续任务。
  const queueAbortRef = useRef<AbortController | null>(null);
  const [generationContent, setGenerationContent] = useState("");
  // DevContext 后台异步生成中的标记（PRD done 后置 true，面板轮询命中内容后置 false）。
  const [devContextPending, setDevContextPending] = useState(false);
  const clearDevContextPending = useCallback(() => setDevContextPending(false), []);
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null);
  // 变更更新前快照：进入变更更新队列时记录当时的 pendingPrompt（屏幕上显示的按钮），
  // 待全部更新完成后原样恢复，避免变更期间 steps 变化触发 recoverPendingPrompt 把按钮
  // 重建为「变更后」状态（表现为按钮文案/下一阶段变化，如「原型完成」变「方案文档完成」）。
  const pendingPromptBeforeChangeRef = useRef<PendingPrompt | null>(null);
  // 变更更新过程中最后一个任务下发的 proceed_prompt（优先级高于快照）：
  // 若流程已被推进，应显示新阶段对应的确认闸门，而非恢复旧快照。
  const lastProceedPromptRef = useRef<PendingPrompt | null>(null);
  // 变更更新刚完成、已恢复 pendingPrompt 的标记：用于跳过一次兜底清空检查，
  // 避免 steps 尚未同步时把刚恢复的按钮误清掉。
  const changeJustFinishedRef = useRef(false);
  // 变更更新任务队列
  const [changeTasks, setChangeTasks] = useState<ChangeTask[]>([]);
  // 方案设计子阶段：null=方案文档，"prototype"=原型设计
  const [designSubPhase, setDesignSubPhase] = useState<"prototype" | null>(null);

  const handleClose = () => {
    skipAutoRef.current = true;
    if (selected) lastSelectedRef.current = selected;
    setSelected(null);
    setExpanded(false);
  };

  // 从窄边"产物"按钮恢复右侧栏：优先恢复收起前查看的产物，否则选最新产物
  const handleReopen = () => {
    skipAutoRef.current = true;
    if (lastSelectedRef.current) {
      setSelected(lastSelectedRef.current);
      return;
    }
    const existing = outputs.filter((o) => o.exists);
    if (existing.length > 0) {
      const pick = existing
        .slice()
        .sort((a, b) => {
          const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return tb - ta;
        })[0];
      // design 是组类型，必须落到具体子产物，否则侧边栏会高亮组标题而非「方案文档」/「交互原型」。
      // 默认按 SELECT_ORDER 的视觉顺序挑「方案文档」优先（与默认打开右侧栏的约定一致）。
      const defaultSub: { type: OutputType; subType?: string }[] = [
        { type: pick.type, subType: pick.subOutputs?.find((s) => s.subType === "solution") ? "solution" : undefined },
        { type: pick.type, subType: pick.subOutputs?.find((s) => s.subType === "prototype") ? "prototype" : undefined },
      ];
      const subPick = defaultSub.find((x) => x.subType && pick.subOutputs?.some((s) => s.subType === x.subType));
      setSelected({ type: pick.type, subType: subPick?.subType });
    } else {
      setSelected({ type: "card" });
    }
  };

  const handleSelect = (type: OutputType, subType?: string) => {
    skipAutoRef.current = true;
    // 保留当前扩展状态：扩展模式下切换文档不应自动缩回
    setSelected({ type, subType });
  };

  const { data: req } = useSWR<RequirementInfo | null>(
    `/api/requirements/${requirementId}`,
    reqFetcher
  );
  const projectId = req?.projectId;
  const { data: project } = useSWR<{ name: string } | null>(
    projectId ? `/api/projects/${projectId}` : null,
    reqFetcher
  );
  const { data: siblings = [] } = useSWR<
    { id: string; title: string; status: string }[]
  >(projectId ? `/api/requirements?projectId=${projectId}` : null, listFetcher);
  const { data: outputs = [], mutate: refreshOutputs } = useSWR<OutputMeta[]>(
    `/api/requirements/${requirementId}/outputs`,
    (u: string) => fetch(u).then((r) => r.json()).then((j) => j.data),
    { revalidateOnFocus: false, revalidateOnReconnect: false }
  );
  const { data: steps = [], mutate: refreshSteps } = useSWR<RequirementStep[]>(
    `/api/requirements/${requirementId}/steps`,
    listFetcher,
    { revalidateOnFocus: false }
  );

  // 从持久化步骤派生「正在生成的步骤」（事实源为 requirement_steps.generating）。
  // 与前端内存态 generatingStep 不同：切走/重进页面后内存态丢失，但后端生成仍在继续，
  // 此处从 steps 接口恢复「生成中」信号，用于跨会话恢复左侧栏/查看器的生成态展示。
  // [防御性修复] 若某 step 已 state=done 或 awaitingConfirm=true，说明该 step 已经生成完成
  // 并等待/已结束确认闸门，仅 generating=true 不足以说明「正在生成」——
  // 后端 finally 清理失败（DB 瞬时错误被 .catch 静默吞掉）会让 generating=true 永久残留，
  // 此时右侧栏永久卡在「AI 正在生成...」。这里把这种「事实已完成」的 step 排除，
  // 避免用户在已完成文档上看到「生成中」撕裂态。
  const persistedGeneratingStep = useMemo<StepName | null>(() => {
    const g = steps.find(
      (s) =>
        s.generating === true &&
        s.state !== "done" &&
        !(s.awaitingConfirm === true)
    );
    return g ? g.step : null;
  }, [steps]);

  // 对 steps 做轮询：跨会话（切走/重进）时，后端生成完成后前端需靠轮询感知
  // generating 翻转与 outputs 落库，从而自动刷新左侧栏/查看器/对话。
  // 关键：不能依赖首次 steps 快照是否有 generating 来决定是否轮询 —— SWR 设了
  // revalidateOnFocus:false 且无 refreshInterval，首次数据可能是旧快照（无 generating），
  // 若此时 stepsPollingEnabled=false 就 return，轮询永不启动，persistedGeneratingStep
  // 永远恢复不出来（即"重进详情页不显示生成中状态"的根因）。
  // 因此改为：挂载即低频轮询（5s），检测到生成中时缩短到 2s。
  const stepsPollingEnabled = persistedGeneratingStep !== null || generatingStep !== null;
  useEffect(() => {
    const interval = stepsPollingEnabled ? 2000 : 5000;
    const id = setInterval(() => {
      refreshSteps();
      // 生成中持续轮询 outputs，避免「生成完成瞬间」被 prevPersistedGenRef 重置错过，
      // 导致重新挂载后 outputs 停在旧快照、查看器/侧栏永久显示「生成中」。
      if (stepsPollingEnabled) refreshOutputs();
    }, interval);
    return () => clearInterval(id);
  }, [stepsPollingEnabled, refreshSteps, refreshOutputs]);

  // 生成中步骤发生变化（开始或结束）时，同步刷新 outputs 与对话，
  // 让左侧栏可点击态、查看器成果、对话 AI 回复在生成完成后自动更新。
  const prevPersistedGenRef = useRef<StepName | null>(null);
  useEffect(() => {
    const prev = prevPersistedGenRef.current;
    prevPersistedGenRef.current = persistedGeneratingStep;
    if (prev !== persistedGeneratingStep) {
      refreshOutputs();
      // 对话面板靠 conversation 接口，此处触发其重新拉取
      globalMutate(`/api/requirements/${requirementId}/conversation`);
    }
  }, [persistedGeneratingStep, refreshOutputs, requirementId]);

  // 切换需求时重置
  useEffect(() => {
    setSelected(null);
    setExpanded(false);
    skipAutoRef.current = false;
    lastSelectedRef.current = null;
    setGeneratingStep(null);
    setGenerationContent("");
    setPendingPrompt(null);
    setChangeTasks([]);
    setDesignSubPhase(null);
    // 重新挂载/切换需求后，立即拉取最新 steps 与 outputs，
    // 避免「上一次生成已完成、但 prevPersistedGenRef 已随卸载重置」
    // 导致重新进入详情页时 outputs 停在旧快照、查看器/侧栏永久显示「生成中」。
    refreshSteps();
    refreshOutputs();
  }, [requirementId, refreshSteps, refreshOutputs]);

  // 从持久化步骤派生「design 步骤当前子阶段」。
  // 重进页面时内存态 designSubPhase 已被重置为 null，需从此处恢复。
  // 注意：不能只看 generating，原型生成完成后 generating=false 但 design_sub_phase 仍应为
  // 'prototype'（prototype-sse 已保留），否则左侧栏「交互原型」菜单与 pendingPrompt 文案
  // 会在用户切走再回后错误地回到「方案文档」阶段。
  const persistedDesignSubPhase = useMemo<"prototype" | null>(() => {
    const design = steps.find((s) => s.step === "design");
    return design?.designSubPhase === "prototype" ? "prototype" : null;
  }, [steps]);

  // 生效中的设计子阶段：内存态优先（实时生成路径），持久化兜底（跨会话恢复）。
  const effectiveDesignSubPhase = designSubPhase ?? persistedDesignSubPhase;

  // 从持久化步骤恢复设计子阶段到内存态：仅当内存态为 null（重进页面）且后端明确
  // 标记 design 步骤正在生成原型时同步，避免覆盖实时生成路径的内存态。
  useEffect(() => {
    if (designSubPhase !== null) return;
    if (persistedDesignSubPhase === "prototype") setDesignSubPhase("prototype");
  }, [persistedDesignSubPhase, designSubPhase]);

  // 进入需求后默认展开右侧栏：按设计流程「从下到上」的逆序优先打开已存在的生成物
  // （需求文档 → 交互原型 → 方案文档 → 调研报告 → 需求卡片），即打开最后生成的文档，
  // 后面的文档不存在时才回退展示前一个。
  useEffect(() => {
    if (skipAutoRef.current) return;
    if (selected != null) return;
    if (!outputs || outputs.length === 0) return;

    // 将 design 组拆开为「方案文档」「交互原型」两个独立项，便于按逆序参与默认选择。
    // 顺序数组越靠后表示越「靠下」（越晚生成），优先打开。
    const SELECT_ORDER: { type: OutputType; subType?: string }[] = [
      { type: "card" },
      { type: "research_analysis" },
      { type: "design", subType: "solution" },
      { type: "design", subType: "prototype" },
      { type: "prd" },
    ];

    // 「可选中」= 已落库存在 OR 正在生成（生成中即可点击/高亮，切走重进后仍可恢复）。
    // 生成中的步骤对应的输出物虽未落库（exists=false），但应被视为「可用」并优先选中，
    // 使右侧栏在重进页面后仍能打开「生成中」占位视图。
    const genStep = persistedGeneratingStep ?? generatingStep;
    const existsOf = (item: { type: OutputType; subType?: string }) => {
      const meta = outputs.find((o) => o.type === item.type);
      if (!meta) return false;
      if (item.subType) {
        const sub = meta.subOutputs?.find((s) => s.subType === item.subType);
        // design 步骤拆成 solution/prototype 两个子产物。判断当前处于哪个子阶段：
        // 1) 生成中：generatingStep/designSubPhase 已标识为 prototype/solution；
        // 2) 生成完成/等待确认：effectiveDesignSubPhase 仍保留为 prototype（prototype-sse
        //    完成后不会清为 null），此时该子产物应继续可点击/高亮，避免用户切走再回后
        //    默认选回 solution 文档。
        const inDesignSubPhase =
          genStep === "design" || effectiveDesignSubPhase === "prototype";
        const subActive =
          inDesignSubPhase &&
          ((item.subType === "prototype" && effectiveDesignSubPhase === "prototype") ||
            (item.subType === "solution" && effectiveDesignSubPhase !== "prototype"));
        return !!sub && (sub.exists || subActive);
      }
      // 顶层项：存在 或 该输出物对应步骤正在生成
      const stepOf = STEP_TO_OUTPUT[genStep as StepName];
      const thisGenerating = stepOf === item.type;
      return meta.exists || thisGenerating;
    };

    const pick = [...SELECT_ORDER].reverse().find(existsOf);
    if (pick) {
      setSelected({ type: pick.type, subType: pick.subType });
    } else {
      setSelected({ type: "card" });
    }
  }, [outputs, selected, generatingStep, persistedGeneratingStep, effectiveDesignSubPhase]);

  // ===== 生成编排核心 =====

  // 触发某个步骤的 AI 生成，流式内容直接推送到右侧 OutputViewer
  const handleGenerate = useCallback(
    async (step: StepName, changeMode = false, changeNote = "") => {
      if (step === "dialoguing") return; // 对话确认不走生成管线
      const apiPath = STEP_TO_API[step].replace("$id", requirementId);
      if (!apiPath) return;

      // 借用户点击按钮的手势上下文请求通知权限（浏览器仅在用户手势内弹出授权框）
      void requestPermission();

      setGeneratingStep(step);
      generatingStepRef.current = step;
      setGenerationContent("");
      // 进入文档/重生成流：通知对话面板进入「可终止」态并禁用发送，统一停止按钮体验。
      window.dispatchEvent(new CustomEvent(EVT.DOC_GEN_START));
      // 自动切换右侧栏到对应输出物
      // 注意：design 是组类型，必须落到具体子产物上（"solution"=方案文档），
      // 否则左侧 OutputSidebar 会把「方案设计」组标题错误地标为 active——
      // 组只是个路径目录，应高亮在具体的「方案文档」/「交互原型」上。
      // 原型子阶段由 generatePrototype 单独处理，此处仅管方案文档。
      const outputType = STEP_TO_OUTPUT[step];
      const subType = outputType === "design" ? "solution" : undefined;
      setSelected({ type: outputType, subType });
      skipAutoRef.current = true;

      try {
        const controller = new AbortController();
        genAbortRef.current = controller;
        const res = await fetch(apiPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "",
            mode: changeMode ? "change" : "normal",
            // 变更模式：携带"该文档要改什么"，后端据此做精准修改式重生成
            changeNote: changeMode ? changeNote : "",
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (reader) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // 解析所有 SSE 事件：delta（累积文本）+ step_update（步骤状态）
          let cursor = 0;
          let lastDelta = "";
          while (cursor < buffer.length) {
            const eventHeader = buffer.indexOf("event: ", cursor);
            if (eventHeader === -1) break;
            const lineEnd = buffer.indexOf("\n", eventHeader);
            if (lineEnd === -1) break;
            const eventType = buffer.slice(eventHeader + 7, lineEnd).trim();
            const dataStart = buffer.indexOf("data: ", lineEnd);
            if (dataStart === -1) break;
            const dataEnd = buffer.indexOf("\n\n", dataStart);
            if (dataEnd === -1) break; // 事件未完整接收
            const raw = buffer.slice(dataStart + 6, dataEnd);

            if (eventType === "delta") {
              try { lastDelta = JSON.parse(raw) as string; } catch { /* ignore */ }
            } else if (eventType === "step_update") {
              // 即时更新进度条
              try {
                const steps = JSON.parse(raw);
                globalMutate(`/api/requirements/${requirementId}/steps`, steps, false);
              } catch { /* ignore */ }
            } else if (eventType === "devcontext_update") {
              // PRD 落库后 DevContext 在后台异步生成：置 pending 让面板显示「生成中」，
              // 并立即触发一次面板 refetch（SWR 设了 revalidateOnFocus:false，需显式 mutate）。
              try {
                const payload = JSON.parse(raw) as { version?: number | null; pending?: boolean };
                setDevContextPending(!!payload?.pending && !payload?.version);
              } catch { /* ignore */ }
              globalMutate(`/api/requirements/${requirementId}/dev-context`);
            } else if (eventType === "proceed_prompt") {
              // 后端下发确认闸门：记录待用户确认的当前阶段与下一阶段（仅 normal 模式下发）
              try {
                const data = JSON.parse(raw) as PendingPrompt & {
                  step: StepName;
                  nextStep: StepName | null;
                  version?: number;
                };
                const prompt = {
                  step: data.step,
                  nextStep: data.nextStep ?? null,
                  canSkip: !!data.canSkip,
                  message: data.message ?? "",
                  version: data.version,
                  subPhase: data.subPhase,
                };
                setPendingPrompt(prompt);
                lastProceedPromptRef.current = prompt;
              } catch { /* ignore */ }
            } else if (eventType === "gen_message") {
              // 后端合成消息（已落库）：
              // 1) 派事件给对话面板即时追加；
              // 2) 同时刷新 conversation SWR 做兜底；
              // 3) 再用 pendingGenMessages 缓存兜底，避免 panel 未 ready 时事件静默丢失。
              try {
                const data = JSON.parse(raw) as { content: string };
                const list = pendingGenMessages.get(requirementId) || [];
                list.push(data.content);
                pendingGenMessages.set(requirementId, list);
                window.dispatchEvent(
                  new CustomEvent(EVT.GEN_MESSAGE, { detail: { content: data.content, requirementId } })
                );
                globalMutate(`/api/requirements/${requirementId}/conversation`);
              } catch { /* ignore */ }
            } else if (eventType === "gen_stopped") {
              // 用户主动点「终止」：后端 AI 调用已停止，full 为终止时刻内容并已落库。
              // 主动刷新 steps/outputs，使右侧栏与 SWR 缓存都拿到「停在半途」的文档内容
              // （文档保留不消失），同时退出「可终止」态、恢复可发送由 DOC_GEN_END 负责。
              try {
                const payload = JSON.parse(raw) as { step?: string; version?: number };
                void payload;
              } catch { /* ignore */ }
              globalMutate(`/api/requirements/${requirementId}/steps`);
              globalMutate(`/api/requirements/${requirementId}/outputs`);
            } else if (eventType === "error") {
              // 后端生成流水线异常（如 EMAXCONNSESSION）：中断 SSE 读取，抛错给外层 catch
              let msg = "服务端生成异常";
              try {
                const edata = JSON.parse(raw) as { message?: string };
                if (edata.message) msg = edata.message;
              } catch { /* parse 失败用默认 msg */ }
              throw new Error(msg);
            }
            cursor = dataEnd + 2;
          }
          if (lastDelta) setGenerationContent(lastDelta);
        }

        // 生成完成 → 直接拉取最新数据并注入 SWR 缓存（即时更新进度条）
        try {
          const stepsRes = await fetch(`/api/requirements/${requirementId}/steps`);
          const stepsJson = await stepsRes.json();
          if (stepsJson.ok) {
            globalMutate(`/api/requirements/${requirementId}/steps`, stepsJson.data, false);
          }
          const outputsRes = await fetch(`/api/requirements/${requirementId}/outputs`);
          const outputsJson = await outputsRes.json();
          if (outputsJson.ok) {
            globalMutate(`/api/requirements/${requirementId}/outputs`, outputsJson.data, false);
          }
        } catch {
          // 回退到 revalidate
          await refreshSteps();
          await refreshOutputs();
        }

        // 注：聊天面板中"X 已生成/已更新"的合成消息由后端经 gen_message 事件实时推送，
        // 确认闸门由后端经 proceed_prompt 事件设置 pendingPrompt；此处不再重复处理。

        // 输出物完成通知：排除需求卡片，且页面非活跃时才弹出
        const label = OUTPUT_NOTIFY_LABEL[step];
        if (label) {
          notifyOutputComplete(req?.title ?? "", label, requirementId);
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          // 用户主动点「终止」：前端读取流被中断。generationContent 已停在终止时刻内容，
          // 此处主动刷新 outputs/steps，确保右侧栏与 SWR 缓存都拿到「用户点停时已生成」的
          // 文档（后端已落库），文档保留不消失、不继续往前生成。
          // 后端因 req.signal.aborted 落库终止内容存在网络异步延迟，稍后二次刷新兜底。
          try {
            await refreshOutputs();
            await refreshSteps();
            await new Promise((r) => setTimeout(r, 600));
            await refreshOutputs();
            await refreshSteps();
          } catch {
            /* ignore */
          }
        } else {
          console.error("生成失败:", e);
        }
        // re-throw 让调用方（handleProceed / processChangeQueue）能捕获并做降级/重试入口
        throw e;
      } finally {
        genAbortRef.current = null;
        setGeneratingStep(null);
        generatingStepRef.current = null;
        // 文档流结束（含被用户停止）：通知对话面板退出「可终止」态，恢复可发送。
        window.dispatchEvent(new CustomEvent(EVT.DOC_GEN_END));
      }
    },
    [req, requirementId, refreshSteps, refreshOutputs]
  );

  // ===== 变更更新队列：按依赖顺序串行重生成所有受影响的输出物 =====
  // card 已由后端在派发 change_update 前同步合并完成，此处只处理文档类输出物；
  // 每个文档重生成时携带其对应的变更点描述（changeNote），实现精准修改而非盲重生成。
  const processChangeQueue = useCallback(
    async (
      affectedOutputs: string[],
      changes: Array<{ output: string; field: string; description: string }> = [],
      dcRegen: boolean = false
    ) => {
      // 输出物类型 → 步骤名映射
      const outputToStep: Record<string, StepName> = {
        card: "dialoguing",
        research_analysis: "research_analysis",
        design: "design",
        prd: "prd_writing",
      };
      // 依赖顺序（上游 → 下游），确保下游重生成时能读到上游最新内容
      const DEP_ORDER = ["research_analysis", "design", "prd"];
      const docsToRegen = DEP_ORDER.filter((o) => affectedOutputs.includes(o));
      const stepsToRegen = docsToRegen
        .map((o) => ({ output: o, step: outputToStep[o] }))
        .filter((x): x is { output: string; step: StepName } => !!x.step);

      // 原型子阶段：若设计方案受变更影响且原型已存在，则在方案文档重生成后
      // 追加原型重生成任务（原型是方案的派生产物，应随方案同步更新）。
      // 注意：客户端组件不可直接 import 服务端 service（会引入 node-sdk/fs），
      // 故通过浏览器可用的 outputs 接口判断原型是否已存在（version 非空即存在）。
      let prototypeExists = false;
      try {
        const res = await fetch(
          `/api/requirements/${requirementId}/outputs/design?subType=prototype`
        );
        const json = await res.json();
        prototypeExists = !!(json?.data?.version != null);
      } catch {
        prototypeExists = false;
      }
      const hasPrototypeTask =
        prototypeExists && stepsToRegen.some((x) => x.output === "design");

      // 统一任务队列：文档步骤 + （可选）原型重生成。
      // 【M2 修】原型任务必须紧跟 design 之后、prd 之前插入，而非 push 到队尾。
      // 原因：prd 重生成完成时会以 prd_writing 触发 DevContext 后台生成（重 ~60~120s，
      // 占满 hy3-preview 配额 + DB 连接）。若原型在 prd 之后才跑，DC 会与原型同时抢资源
      // 直接 500（被队列兜底重试才最终成功）。首次生成顺序本就是 design→原型→prd，
      // 这里对齐首次路径，让 prd 触发 DC 时原型已经跑完，DC 独占资源。
      type QueueItem = { output: string; isPrototype: boolean };
      const queue: QueueItem[] = [];
      for (const x of stepsToRegen) {
        queue.push({ output: x.output, isPrototype: false });
        if (hasPrototypeTask && x.output === "design") {
          queue.push({ output: "prototype", isPrototype: true });
        }
      }

      // 初始化任务队列（用于展示）
      const tasks: ChangeTask[] = queue.map((q) => ({
        output: q.output,
        status: "pending" as const,
      }));
      setChangeTasks(tasks);

      // 快照变更前的 pendingPrompt（屏幕上显示的按钮），并在更新期间隐藏。
      // 恢复逻辑在下方「全部完成」分支，避免 changeTasks 期间 steps 变化触发
      // recoverPendingPrompt 把按钮重建为「变更后」状态（表现：按钮文案变化）。
      pendingPromptBeforeChangeRef.current = pendingPrompt;
      lastProceedPromptRef.current = null;
      setPendingPrompt(null);

      // 变更队列中断信号：用户主动停止时 abort，串行循环每轮开始检查，
      // 命中则中断后续任务、保留已落库部分、剩余标记为 cancelled。
      const queueCtrl = new AbortController();
      queueAbortRef.current = queueCtrl;
      // 进入变更重生成队列：通知对话面板进入「可终止」态，使停止按钮可中断队列。
      window.dispatchEvent(new CustomEvent(EVT.DOC_GEN_START));

      // 串行执行（上游完成后再重生成下游）
      let hasChangeError = false;
      let queueAborted = false;
      for (let i = 0; i < queue.length; i++) {
        // 用户主动停止 → 中断后续任务，保留已完成的落库部分
        if (queueCtrl.signal.aborted) {
          queueAborted = true;
          break;
        }
        const item = queue[i];
        // 标记当前任务为生成中
        setChangeTasks((prev) =>
          prev.map((t, idx) => (idx === i ? { ...t, status: "generating" } : t))
        );

        // 该文档对应的变更点描述 → changeNote
        let changeNote = changes
          .filter((c) => c.output === item.output)
          .map((c) => `- ${c.field}：${c.description}`)
          .join("\n");

        if (item.isPrototype) {
          // 原型是方案设计的派生产物：优先取 design 的变更点作为精准修改指令。
          // —— 但 change-analyzer 的输出物只有 card/research_analysis/design/prd，
          //   从不产出 prototype，所以第一行的过滤永远是空。
          // —— 更糟的是：change-analyzer 可能返回 affectedOutputs 含 design 但 changes
          //   为空（AI 没给具体变更点），那时仅靠 design 过滤也是空 → changeNote 仍是空串
          //   → prototype-sse 的 isEdit=false → 按钮翻、文案"已生成"。
          // —— 必须**始终**保证原型任务的 changeNote 非空，否则 isEdit 永远判定为 false，
          //   把"变更/编辑"误判成"首次生成"，推进闸门照发。
          const designChanges = changes.filter((c) => c.output === "design");
          if (designChanges.length > 0) {
            changeNote = designChanges
              .map((c) => `- ${c.field}：${c.description}`)
              .join("\n");
          } else {
            changeNote = `同步更新原型以反映${affectedOutputs.join("、")}的最新内容`;
          }
        }

        try {
          if (item.isPrototype) {
            // 原型重生成：进入原型子阶段并复用生成管线（携带变更点）
            setDesignSubPhase("prototype");
            setSelected({ type: "design", subType: "prototype" });
            await generatePrototypeRef.current?.(changeNote);
          } else {
            const step = outputToStep[item.output];
            if (step) await handleGenerate(step, true, changeNote);
          }
          // 标记完成
          setChangeTasks((prev) =>
            prev.map((t, idx) => (idx === i ? { ...t, status: "done" } : t))
          );
        } catch {
          hasChangeError = true;
          setChangeTasks((prev) =>
            prev.map((t, idx) => (idx === i ? { ...t, status: "error" } : t))
          );
        }
      }

      // M2：变更波及 DC 上游（不含 prd）时，前端在重生成队列（含 prototype）排空后再触发
      // DC 再生成（change_analysis），避免 DC 与 design/prototype 重生成同时抢 hy3-preview
      // 配额 + DB 连接导致 500（与首次生成路径一致：design→原型→prd 之后 DC 才独占资源）。
      if (dcRegen) {
        try {
          await fetch(`/api/requirements/${requirementId}/dev-context`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trigger: "change_analysis" }),
          });
        } catch (e) {
          console.error(`[devcontext] requirement=${requirementId} change_analysis 前端触发失败：`, e);
        }
      }

      // 全部完成或被用户中断 → 处理队列清理与按钮恢复
      if (queueAborted) {
        // 被中断：保留已落库部分，把尚未开始的剩余任务标记为 cancelled，不发送总结、
        // 不通知、立即恢复 pendingPrompt（不延迟 1.5s），让用户可立即继续操作。
        setChangeTasks((prev) =>
          prev.map((t) =>
            t.status === "pending" || t.status === "generating"
              ? { ...t, status: "cancelled" }
              : t
          )
        );
        // 立即恢复按钮（不延迟），使停止后可马上再发/再变更
        const restorePrompt = pendingPromptBeforeChangeRef.current;
        setPendingPrompt(restorePrompt);
        lastProceedPromptRef.current = null;
        pendingPromptBeforeChangeRef.current = null;
        changeJustFinishedRef.current = true;
        setTimeout(() => setChangeTasks([]), 1200);
      } else {
        // 全部完成 → 延迟 1.5s 后清空队列并恢复按钮，让用户体验到"全部完成"
        setTimeout(() => {
          setChangeTasks([]);
          // 恢复逻辑：优先使用本次更新最后一个任务下发的 proceed_prompt（流程已推进），
          // 否则回退到变更前快照，确保按钮不会错误地"变化"或消失。
          const restorePrompt =
            lastProceedPromptRef.current ?? pendingPromptBeforeChangeRef.current;
          setPendingPrompt(restorePrompt);
          lastProceedPromptRef.current = null;
          pendingPromptBeforeChangeRef.current = null;
          changeJustFinishedRef.current = true;
        }, 1500);
        }

        // 变更队列结束（含被用户主动中断）：清理中断信号并通知对话面板退出「可终止」态。
        queueAbortRef.current = null;
        window.dispatchEvent(new CustomEvent(EVT.DOC_GEN_END));

        // 需求变更通知：整次变更作为整体，仅在所有输出物均成功完成后通知一次
      const allDone = !queueAborted && tasks.length > 0 && !hasChangeError;
      if (allDone) {
        notifyChangeComplete(req?.title ?? "", requirementId);

        // [问题3深度修复] 变更流程完成后，对「应已完成的步骤」主动 PATCH state=done。
        // 后端 research-analysis 路由按 isFrontierStep 决定标 done：下游只要不是
        // not_started 就算非 frontier、应 markStepDone。但实测发现两个稳定 bug：
        //   (1) 时序竞争 / 版本号提交失败 → markStepDone 静默吞掉（catch(()=>{})）
        //   (2) 第二次变更时前一步骤可能仍是 pending_update，但下游是 in_progress
        //       → markStepDone 仍应工作，但偶发卡在 in_progress。
        // 这里额外兜底 PATCH：受影响 step 全部置 done。design/prd 步骤**保持当前
        // 状态**（不强制 done）—— design 需要 prototype 完成才整体 done，prd 同理。
        // 但 research_analysis 作为上游变更产物，每次变更完成后必须变 done。
        if (affectedOutputs.includes("research_analysis")) {
          try {
            await fetch(`/api/requirements/${requirementId}/steps`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ step: "research_analysis", state: "done" }),
            });
          } catch {
            /* 兜底失败不影响后续总结消息 */
          }
        }
        // 强制重拉一次 steps，确保前端步骤条立刻反映最新 DB 状态
        // （之前仅靠后端 SSE step_update 在 strict mode 双调用下可能被覆盖）。
        await refreshSteps();
      }

      // 发送完成总结消息（含 card 等全部受影响输出物，供总结展示）
      // 交互原型是方案文档的派生产物：方案受影响且原型已存在时，一并列入总结。
      // 依赖顺序位于方案文档之后、需求文档之前。
      const OUTPUT_ORDER = ["card", "research_analysis", "design", "prototype", "prd"];
      const completeOutputs = [...affectedOutputs].sort(
        (a, b) => OUTPUT_ORDER.indexOf(a) - OUTPUT_ORDER.indexOf(b)
      );
      if (hasPrototypeTask && !completeOutputs.includes("prototype")) {
        const idx = completeOutputs.indexOf("prd");
        if (idx >= 0) completeOutputs.splice(idx, 0, "prototype");
        else completeOutputs.push("prototype");
      }
      // [问题1修复] 先写 pendingChangeComplete 兜底缓存（避免 panel 监听器 rid 仍
      // 为 null 时事件被 `if (!rid) return` 直接丢弃），再派发事件。
      const pendingList = pendingChangeComplete.get(requirementId) ?? [];
      pendingList.push(...completeOutputs);
      pendingChangeComplete.set(requirementId, pendingList);
      window.dispatchEvent(
        new CustomEvent(EVT.CHANGE_COMPLETE, {
          detail: {
            requirementId,
            affectedOutputs: completeOutputs,
          },
        })
      );
    },
    [handleGenerate, req, requirementId, pendingPrompt]
  );

  // 监听对话面板的 change_update 事件（AI 检测到变更点）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        requirementId: string;
        affectedOutputs: string[];
        changes: Array<{ output: string; field: string; description: string }>;
        summary: string;
        dcRegen?: boolean;
      };
      if (detail.requirementId !== requirementId) return;
      // 自动开始变更更新流程（携带各文档变更点，用于精准重生成；dcRegen 表示队列排空后触发 DC）
      processChangeQueue(detail.affectedOutputs, detail.changes ?? [], detail.dcRegen === true);
    };
    window.addEventListener(EVT.CHANGE_UPDATE, handler);
    return () => window.removeEventListener(EVT.CHANGE_UPDATE, handler);
  }, [requirementId, processChangeQueue]);

  // 原型生成函数引用（定义于下方，用 ref 避免初始化顺序导致的 TDZ）
  const generatePrototypeRef = useRef<((changeNote?: string) => Promise<void>) | null>(null);

  // 用户点击【确认并进入下一阶段】或系统自动推进：先把当前节点置【已完成】，再生成下一节点
  // promptArg: 当由自动推进触发时传入（避免依赖 state 中的 pendingPrompt）
  // silent: 为 true 时（对话自动推进路径）不在此额外追加对话提示——该话术已由后端
  //   conversation/route.ts 落库并经 gen_message 事件推送，避免对话出现重复提示。
  //   为 false 时（按钮手动进入下一阶段路径）：本组件负责把推进话术落库并推送到对话面板，
  //   与对话路径保持一致，否则点按钮进入下一阶段时对话面板毫无反馈。
  const handleProceed = useCallback(
    async (promptArg?: PendingPrompt | null, silent = false) => {
      const prompt = promptArg || pendingPrompt;
      if (!prompt) return;
      const { step, nextStep, version, subPhase } = prompt;
      // 按钮手动进入下一阶段：补一条与对话自动推进一致的推进提示（自动推进已由后端落库，跳过）
      // 推送顺序：先 dispatch 同步事件（让对话面板即时显示），再 fetch 后端端点 addMessage 落库
      // （刷新后仍可见）。fetch 失败仅控制台报错，不影响即时反馈。
      // 注意：addMessage 依赖服务端 db，客户端不能直接 import @/lib/services/conversations，
      // 故走 POST /api/requirements/[id]/conversation/system 端点间接落库。
      const emitProceedTip = async (step: StepName, nextStep: StepName | null, subPhase: string | undefined) => {
        if (silent) return;
        const content = proceedReplyText(step, nextStep, subPhase as "prototype" | undefined);
        if (!content) return;
        // 即时显示通道 1：专用事件 PROCEED_TIP（panel 无 rid 守卫必收，绕过 GEN_MESSAGE
        // 因 rid/requirementId 类型/双 mount 时序不一致导致的静默失效）。
        window.dispatchEvent(
          new CustomEvent(EVT.PROCEED_TIP, {
            detail: { content, requirementId },
          })
        );
        // 即时显示通道 2：原有 GEN_MESSAGE 路径（保持兼容，供给其它潜在监听者）。
        window.dispatchEvent(
          new CustomEvent(EVT.GEN_MESSAGE, {
            detail: { content, requirementId },
          })
        );
        // 持久化：后端 addMessage 落库（失败仅登日志，不影响 UI 已显示的提示）。
        // 落库完成后 mutate 让 SWR 重新拉取，把新消息带回对话面板（兜底同步）。
        fetch(`/api/requirements/${requirementId}/conversation/system`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ step, nextStep, subPhase }),
        })
          .then(() => {
            globalMutate(`/api/requirements/${requirementId}/conversation`);
          })
          .catch((e) => {
            console.error("[handleProceed] 推进提示持久化失败", e);
          });
      };
      // 子阶段分支：方案文档确认后进入原型设计（方案设计保持【进行中】，不标记完成）
      if (subPhase === "prototype") {
        // 关键：必须先把 design 步骤的 awaitingConfirm 关掉。
        // 旧实现只 setPendingPrompt(null)，但 design 步骤的 awaitingConfirm 仍是 true，
        // 进入原型子阶段后，prototype-sse 完成时虽然会再次 setAwaitingConfirm(true) 打开
        // 新的"原型→PRD"闸门，但如果 prototype-sse 在该闸门打开前发生任何异常/中断，
        // 设计阶段仍处于 awaitingConfirm=true；useEffect「恢复 pendingPrompt」的逻辑就会
        // 立即重新渲染旧的"方案文档已生成，请在下方确认后进入原型设计"按钮，导致
        // 输入框上方的「进入下一阶段」按钮在原型已生成的情况下依旧残留（用户截图反馈）。
        //
        // 顺序很重要：必须先 PATCH 关闸门 + 等 refreshSteps 把 steps state 更新成
        // awaitingConfirm=false 后，才能 setPendingPrompt(null)。否则中间会有一个
        // React render tick 在 steps 仍是旧数据时跑 useEffect recover，把按钮再次拉回。
        try {
          await fetch(`/api/requirements/${requirementId}/steps`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              step,
              state: "in_progress",
              awaitingConfirm: false,
              outputVersion: version,
              // 进入原型子阶段：持久化子阶段标识，重进页面后可恢复「原型生成中」而非误判为方案文档
              designSubPhase: "prototype",
              // 同时把 generating=true 持久化：用户点击按钮后立即退出到项目页，
              // 列表页 derivedStatus 与详情页 persistedDesignSubPhase 都能立刻看到「原型生成中」，
              // 弥补「等待 prototype-sse 起流」这段几百毫秒的空窗。
              // 后续 prototype-sse 的 setStepGenerating(rid, "design", true, "prototype") 是幂等兜底。
              generating: true,
            }),
          });
          await refreshSteps();
        } catch {
          /* ignore — 即便 PATCH 失败，原型子阶段本身仍可推进；旧按钮残留问题由 prototype-sse 的闸门开关覆盖 */
        }
        // 此时 steps 数据已包含 awaitingConfirm=false，再清 pendingPrompt 即可彻底避免
        // useEffect 把旧"方案文档已确认"按钮鬼影恢复出来。
        setPendingPrompt(null);
        setDesignSubPhase("prototype");
        setSelected({ type: "design", subType: "prototype" });
        // 与对话路径一致：进入原型设计时在对话里给一句反馈
        void emitProceedTip(step, nextStep, "prototype");
        // 自动根据方案设计生成原型（需 await + catch：原型生成失败时回退 pendingPrompt 供重试）
        try {
          await generatePrototypeRef.current?.();
        } catch (e) {
        // AbortError = 用户主动中止，不设重试入口
        if (e instanceof DOMException && e.name === "AbortError") return;
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error("原型自动生成失败:", errMsg);
        // 失败后退化为 pendingPrompt（携带 subPhase:"prototype"），让用户通过顶部按钮重试
        setPendingPrompt({
          step,
          nextStep,
          canSkip: false,
          message: `原型生成失败（${errMsg.slice(0, 80)}），请点击上方按钮重试。`,
          version,
          subPhase,
        });
        window.dispatchEvent(
          new CustomEvent(EVT.GEN_ERROR, {
            detail: { requirementId, step: "prototype" as StepName, message: errMsg },
          })
        );
      }
      return;
    }
    // 进入推进流程后，先收起输入框上方的"可进入下一阶段"按钮。
    // 失败分支的 catch 块会重新设置 pendingPrompt 提示用户重试，
    // 此处统一清空，不再区分手动 / 自动触发。
    setPendingPrompt(null);
    // 离开方案设计步骤时退出原型子阶段
    if (step === "design") setDesignSubPhase(null);
    // 与对话路径一致：进入下一阶段时在对话里给一句推进反馈（自动推进已由后端落库，跳过）
    void emitProceedTip(step, nextStep, subPhase);
    // 先置当前节点【已完成】并清除确认闸门；同时把下一节点置【进行中 + 生成中】，
    // 真正把"等待 SSE 起流"这段空窗吸进持久化层 —— 用户点击后立即退出到项目页，
    // 列表页 derivedStatus(r.generatingStep) 与详情页 persistedGeneratingStep 都能立刻反映「生成中」，
    // 不再出现「方案文档已完成，等跑完之后突然变生成中」的撕裂感。
    // 后端 SSE / prototype-sse 自身的 setStepGenerating 调用仍是幂等兜底。
    try {
      const doneBody = JSON.stringify({
        step,
        state: "done",
        awaitingConfirm: false,
        outputVersion: version,
        // 推进离开 design 步骤时清空子阶段标识（回到方案文档阶段语义）
        designSubPhase: step === "design" ? null : undefined,
      });
      const nextBody =
        nextStep &&
        JSON.stringify({
          step: nextStep,
          state: "in_progress",
          awaitingConfirm: false,
          // 注意：此处【不】预置 generating:true。
          // 旧实现会在「等待 SSE 真正起流」的空窗里先持久化 generating=true，但后端
          // /design POST 只有在 getSession 之后才 setStepGenerating(design, true, null)，
          // 二者之间存在时间窗。若用户在此期间切走页面导致浏览器取消 POST 请求
          // （连接尚未建立 / 服务端尚未执行 setStepGenerating），则 design.generating
          // 会永久卡在 pre-PATCH 写入的 true，而没有任何后端任务会把它清 0 —— 表现为
          // 「生成中切走再回 → 右侧栏永久 AI 正在生成」。
          // 改为：generating 完全由后端 SSE 的 setStepGenerating(true/false) 负责，
          // POST 不阻塞（streamAI 立即返回），setStepGenerating 在 getSession 后即刻执行，
          // 因此「切走后项目页显示生成中」的体验基本无损，但彻底消除了孤立 generating=true。
        });
      const patches: Promise<unknown>[] = [
        fetch(`/api/requirements/${requirementId}/steps`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: doneBody,
        }),
      ];
      if (nextBody) {
        patches.push(
          fetch(`/api/requirements/${requirementId}/steps`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: nextBody,
          })
        );
      }
      await Promise.all(patches).catch(() => {
        /* ignore — 任一 PATCH 失败不阻塞后续 generate，外层 try/catch 覆盖错误路径 */
      });
      await refreshSteps();
    } catch {
      /* ignore */
    }
    // 再生成下一节点（最后一步仅置 done，不再生成）
    // 注意：此处必须 await，不然生成失败会被静默吞掉（fire-and-forget），
    // 表现为「自动推进时 AI 回复了但报告没生成，顶部按钮却能正常走」。
    if (nextStep) {
      try {
        await handleGenerate(nextStep);
      } catch (e) {
        // AbortError = 用户主动中止（切换页面/取消生成），不设重试入口
        if (e instanceof DOMException && e.name === "AbortError") return;
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error("自动推进生成失败:", errMsg);
        // 失败后退化为 pendingPrompt，让用户可通过顶部按钮重试（与正常 proceed_prompt 行为一致）
        setPendingPrompt({
          step,
          nextStep,
          canSkip: false,
          message: `生成失败（${errMsg.slice(0, 80)}），请点击上方按钮重试。`,
          version,
        });
        // 同时通知对话面板，替换残留空回复气泡为错误提示并清除横幅
        window.dispatchEvent(
          new CustomEvent(EVT.GEN_ERROR, {
            detail: { requirementId, step: nextStep, message: errMsg },
          })
        );
      }
    }
  }, [pendingPrompt, handleGenerate, requirementId, refreshSteps]);

  // 用户点击【返回修改】：在对话输入框填入默认修改文案（通用文案，不指明具体对象）
  const handleReturnToModify = useCallback(() => {
    const defaultText = "请帮我修改：\n";
    window.dispatchEvent(
      new CustomEvent(EVT.REQUEST_MODIFY, { detail: { defaultText } })
    );
  }, [pendingPrompt]);

  // 进入原型子阶段后自动根据方案设计生成可交互原型（复用与 handleGenerate 相同的 SSE 解析）
  // 参数 changeNote：变更模式下携带"该文档要改什么"，后端据此做精准修改而非盲重生成；
  // 普通模式调用方不传，保持 isEdit=false → 走正常的"生成原型 + 推进闸门"流程。
  const generatePrototype = useCallback(
    async (changeNote = "") => {
      // 借用户点击按钮的手势上下文请求通知权限
      void requestPermission();

      const apiPath = `/api/requirements/${requirementId}/prototype`;
      setGeneratingStep("design");
      generatingStepRef.current = "design";
      setGenerationContent("");
      // 自动将右侧栏切到原型子产物
      setSelected({ type: "design", subType: "prototype" });
      skipAutoRef.current = true;
      // [问题4修复] 原型生成也属于"产出文档"范畴，让对话面板把按钮切到停止方块，
      // 避免用户在原型还在生成时发送下一条对话消息。
      window.dispatchEvent(new CustomEvent(EVT.DOC_GEN_START));
      try {
        const controller = new AbortController();
        genAbortRef.current = controller;
        const res = await fetch(apiPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "", changeNote }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let lastDelta = "";
        while (reader) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let cursor = 0;
          while (cursor < buffer.length) {
            const eventHeader = buffer.indexOf("event: ", cursor);
            if (eventHeader === -1) break;
            const lineEnd = buffer.indexOf("\n", eventHeader);
            if (lineEnd === -1) break;
            const eventType = buffer.slice(eventHeader + 7, lineEnd).trim();
            const dataStart = buffer.indexOf("data: ", lineEnd);
            if (dataStart === -1) break;
            const dataEnd = buffer.indexOf("\n\n", dataStart);
            if (dataEnd === -1) break;
            const raw = buffer.slice(dataStart + 6, dataEnd);

            if (eventType === "delta") {
              try {
                lastDelta = JSON.parse(raw) as string;
              } catch {
                /* ignore */
              }
            } else if (eventType === "step_update") {
              try {
                globalMutate(
                  `/api/requirements/${requirementId}/steps`,
                  JSON.parse(raw),
                  false
                );
              } catch {
                /* ignore */
              }
            } else if (eventType === "proceed_prompt") {
              try {
                const data = JSON.parse(raw) as {
                  step: StepName;
                  nextStep: StepName | null;
                  canSkip: boolean;
                  message: string;
                  version?: number;
                };
                setPendingPrompt({
                  step: data.step,
                  nextStep: data.nextStep ?? null,
                  canSkip: !!data.canSkip,
                  message: data.message ?? "",
                  version: data.version,
                });
              } catch {
                /* ignore */
              }
            } else if (eventType === "gen_message") {
              try {
                const data = JSON.parse(raw) as { content: string };
                const list = pendingGenMessages.get(requirementId) || [];
                list.push(data.content);
                pendingGenMessages.set(requirementId, list);
                window.dispatchEvent(
                  new CustomEvent(EVT.GEN_MESSAGE, { detail: { content: data.content, requirementId } })
                );
                globalMutate(`/api/requirements/${requirementId}/conversation`);
              } catch {
                /* ignore */
              }
            } else if (eventType === "error") {
              // 后端原型流水线异常：中断 SSE 读取，抛错给外层 catch
              let msg = "原型生成异常";
              try {
                const edata = JSON.parse(raw) as { message?: string };
                if (edata.message) msg = edata.message;
              } catch { /* parse 失败用默认 msg */ }
              throw new Error(msg);
            }
            cursor = dataEnd + 2;
          }
          if (lastDelta) setGenerationContent(lastDelta);
        }

        // 生成完成：刷新步骤与产物
        try {
          const stepsRes = await fetch(`/api/requirements/${requirementId}/steps`);
          const stepsJson = await stepsRes.json();
          if (stepsJson.ok) {
            globalMutate(`/api/requirements/${requirementId}/steps`, stepsJson.data, false);
          }
          const outputsRes = await fetch(`/api/requirements/${requirementId}/outputs`);
          const outputsJson = await outputsRes.json();
          if (outputsJson.ok) {
            globalMutate(`/api/requirements/${requirementId}/outputs`, outputsJson.data, false);
          }
        } catch {
          await refreshSteps();
          await refreshOutputs();
        }

        // 交互原型完成通知（仅在页面非活跃时弹出）
        notifyOutputComplete(req?.title ?? "", "交互原型", requirementId);
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          console.error("原型生成失败:", e);
        }
        // re-throw 让调用方（handleProceed / processChangeQueue）能捕获并设重试入口
        throw e;
      } finally {
        genAbortRef.current = null;
        setGeneratingStep(null);
        generatingStepRef.current = null;
        // [问题4修复] 原型生成结束：同步 DOC_GEN_END 让对话面板按钮恢复可发送。
        window.dispatchEvent(new CustomEvent(EVT.DOC_GEN_END));
      }
    },
    [req, requirementId, refreshSteps, refreshOutputs]
  );
  // 将原型生成函数挂到 ref，供 handleProceed 在运行时调用（规避 TDZ）
  generatePrototypeRef.current = generatePrototype;

  // 组件卸载（如切走需求页 / 切到项目页）时【不】主动 abort 当前生成请求。
  //
  // 服务端 SSE 流由 runGeneration 在进程内独立产出，客户端连接断开并不影响其自身
  // reader.read() 继续读取与 finally 清 0（已在 design/route.ts、prototype-sse.ts 验证）。
  // 因此「卸载时 abort」不仅无助于服务端清 0，反而会：
  //   1. 让前端 fetch 的 reader.read() 抛 AbortError，handleGenerate 走 catch→throw→
  //      handleProceed 直接 return，丢失「生成完成」事件；
  //   2. 重进详情页是全新 mount，不再触发生成，完全依赖 SWR 轮询 /steps。若轮询在
  //      生成完成的瞬间未命中 done 态，UI 就会永久停在「AI 正在生成…」。
  //
  // 不 abort 时：前端 handleGenerate 的 while 循环会一直读到服务端 done，并在第 439 行
  // 主动拉最新 steps/outputs 注入 SWR；即便切走后组件卸载，服务端仍会跑完 finally 清 0，
  // 重进页面时 SWR 直接拉到已完成态。服务端侧另有 5 分钟超时保险作为兜底。
  //
  // 注：genAbortRef 仍保留供 handleGenerate 自身在异常时使用，但卸载清理不再调用 abort。
  useEffect(() => {
    return () => {
      // 故意不调用 genAbortRef.current?.abort()：避免打断服务端独立生成流。
    };
  }, []);

  // 监听对话面板的 proceed_prompt 事件（AI 提示进入下一步）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as PendingPrompt & {
        requirementId: string;
        nextStep?: StepName | null;
        version?: number;
        auto?: boolean;
      };
      if (detail.requirementId !== requirementId) return;
      // auto=true：用户主动发送确认词 → 自动推进，不走按钮渲染
      if (detail.auto) {
        // 进入推进流程前先清掉对话框上方的旧按钮（即便本轮推进失败，catch 路径也会恢复）。
        // 旧实现仅在 handleProceed 内部清空，对自动推进路径传入 promptArg 时不生效，
        // 导致对话里说"好的"后输入框上方的"可进入下一阶段"按钮持续残留。
        setPendingPrompt(null);
        // 若正在生成中，避免并发重生成：降级为开门等用户点击
        if (generatingStepRef.current) {
          setPendingPrompt({
            step: detail.step,
            nextStep: detail.nextStep ?? null,
            canSkip: detail.canSkip,
            message: detail.message ?? `是否进入「${STEP_LABELS[detail.step]}」阶段？`,
            version: detail.version,
            subPhase: detail.subPhase,
          });
          return;
        }
        handleProceed({
          step: detail.step,
          nextStep: detail.nextStep ?? null,
          canSkip: detail.canSkip,
          message: detail.message ?? "",
          version: detail.version,
          // 透传 subPhase：否则 handleProceed 会误把设计步骤当作普通 PATCH done 处理，
          // 跳过原型子阶段直接标 design=done（不调 generatePrototype）
          subPhase: detail.subPhase,
        }, true); // silent=true：对话话术已由后端 conversation/route.ts 落库，此处不再重复追加
        return;
      }
      // auto=false 或未设置：模型主动判定 → 渲染双按钮等用户点击
      setPendingPrompt({
        step: detail.step,
        nextStep: detail.nextStep ?? null,
        canSkip: detail.canSkip,
        message: detail.message ?? `是否进入「${STEP_LABELS[detail.step]}」阶段？`,
        version: detail.version,
        subPhase: detail.subPhase,
      });
    };
    window.addEventListener(EVT.PROCEED_PROMPT, handler);
    return () => window.removeEventListener(EVT.PROCEED_PROMPT, handler);
  }, [requirementId, handleProceed]);

  // 退出重进会话后，从持久化的步骤状态恢复确认闸门：
  // 若存在 awaitingConfirm === true 的步骤，还原 pendingPrompt（双按钮），避免流程卡死。
  // 【M3 修复】必须在 steps 变化时反复检查 awaiting：①初次 steps 数据可能已被后端清除
  // （后台生成失败/异常码跳转等），②后续 steps 轮询可能把 awaiting=true 拉回来；
  // 用「当前是否有 pendingPrompt」做幂等闸门即可，不必靠 ref 记一次性（之前的
  // restordReqRef 在 awaiting 暂未到时被设置成 requirementId，后续 steps 拉到 awaiting=true
  // 也跳过恢复，导致方案文档生成后退页面再进入时按钮"消失"）。
  useEffect(() => {
    if (changeTasks.length > 0) return; // 变更更新进行中：冻结，避免把按钮重建为「变更后」状态
    if (!steps || steps.length === 0) return; // 等待 steps 数据加载完成
    if (pendingPrompt) return; // 当前已有 pendingPrompt（实时事件已下发），无需重新恢复
    const awaiting = steps.find((s) => s.awaitingConfirm);
    if (!awaiting) return;
    // 设计阶段的确认闸门含义特殊：方案文档确认后实际上是进入原型子阶段
    // （subPhase="prototype"），由 nextStep=null + subPhase 标记。
    // 原型确认后再进入 prd_writing（normal 模式的 subPhase 为空）。
    // 恢复时必须把这个 subPhase 也带上，否则点按钮会被 handleProceed 当作普通
    // PATCH done 路径处理，跳过原型直接推进到 PRD。
    // 区分依据：优先用持久化的 designSubPhase 字段判断当前处于哪个子阶段；
    // 若旧数据无该字段，则 fallback 到 outputs 中 prototype 子产物是否存在。
    const designStep = steps.find((s) => s.step === "design");
    const designMeta = outputs.find((o) => o.type === "design");
    const prototypeMeta = designMeta?.subOutputs?.find((s) => s.subType === "prototype");
    const isAwaitingEnterPrototype =
      awaiting.step === "design" &&
      (designStep?.designSubPhase
        ? designStep.designSubPhase !== "prototype"
        : !prototypeMeta?.exists);
    const nextStep = isAwaitingEnterPrototype
      ? null
      : nextStepOf(awaiting.step);
    const subPhase =
      awaiting.step === "design" && isAwaitingEnterPrototype
        ? "prototype"
        : undefined;
    const message =
      awaiting.step === "dialoguing"
        ? "需求确认已完成，请确认后进入下一阶段。"
        : awaiting.step === "design"
          ? isAwaitingEnterPrototype
            ? "方案文档已生成，请确认后进入原型设计。"
            : "原型已生成，请确认后进入下一阶段。"
          : awaiting.step === "prd_writing"
            ? "需求文档已生成，请确认后完成定版。"
            : `${STEP_LABELS[awaiting.step] ?? ""}已生成，请确认后进入下一阶段。`;
    setPendingPrompt({
      step: awaiting.step,
      nextStep,
      subPhase,
      canSkip: false,
      message,
      version: awaiting.outputVersion,
    });
  }, [steps, pendingPrompt, requirementId]);

  // 兜底：若 pendingPrompt 对应的 step 已不在 awaitingConfirm 状态（即已被推进/已关闭闸门），
  // 强制清空 pendingPrompt，避免「输入框上方按钮残留」。
  // 注意：只看 awaitingConfirm，不能看 state —— 阶段进行中（in_progress）正是等待确认的常态。
  useEffect(() => {
    if (changeTasks.length > 0) return; // 变更更新进行中：冻结，避免误清空变更前快照的按钮
    if (changeJustFinishedRef.current) {
      // 变更刚完成时 steps 可能尚未同步，跳过本次检查，避免把刚恢复的按钮误清掉
      changeJustFinishedRef.current = false;
      return;
    }
    if (!pendingPrompt || !steps || steps.length === 0) return;
    const step = pendingPrompt.step;
    const row = steps.find((s) => s.step === step);
    if (!row) return;
    if (!row.awaitingConfirm) {
      setPendingPrompt(null);
    }
  }, [steps, pendingPrompt]);

  // ===== 上下文值 =====
  const workflowState: WorkflowState = {
    generatingStep,
    generationContent,
    pendingPrompt,
    onProceed: handleProceed,
    onReturnToModify: handleReturnToModify,
    changeTasks,
    designSubPhase: effectiveDesignSubPhase,
  };

  const dragging = useRef(false);
  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    dragging.current = true;
    const move = (ev: PointerEvent) => {
      if (!dragging.current) return;
      const delta = startX - ev.clientX;
      setWidth(Math.min(900, Math.max(320, startW + delta)));
    };
    const up = () => {
      dragging.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // 用户主动停止当前所有流：对话流由 conversation-panel 自身 abort；此处统一负责
  // 文档生成流（genAbortRef）、变更重生成队列（queueAbortRef）。
  // DevContext 后台生成：客户端不直接调用 abortDcGen（避免拉入服务端 cloudbase/fs 依赖），
  // 而是 abort 当前 SSE 流让后端 req.signal 触发 route 内的 abortDcGen 调用。
  useEffect(() => {
    const onStop = () => {
      // 文档/重生成 SSE 流
      genAbortRef.current?.abort();
      genAbortRef.current = null;
      // 变更重生成队列（串行循环每轮检查 aborted）
      queueAbortRef.current?.abort();
      queueAbortRef.current = null;
      // DevContext：依赖上述 SSE abort 由后端自动触发（见 conversation/prd route）。
    };
    window.addEventListener(EVT.STOP_FLOW, onStop);
    return () => window.removeEventListener(EVT.STOP_FLOW, onStop);
  }, []);

  const rightOpen = selected != null;

  return (
    <UserContext.Provider value={user}>
      <WorkflowContext.Provider value={workflowState}>
        <div className="flex h-screen flex-col overflow-hidden font-[Plus_Jakarta_Sans]">
          {/* ===== 顶部栏 ===== */}
          <header className="flex h-[63px] shrink-0 items-center justify-between border-b border-[#1111111a] bg-white px-7">
            <div className="flex items-center gap-3">
              <Link href="/dashboard" className="flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/logo-orange.png" alt="AskBuddy" className="h-[40px] w-auto" />
                <span className="text-[22px] font-bold text-[#111111]">AskBuddy</span>
              </Link>
              <span className="h-[22px] w-px bg-[#1111111a]" />
              <nav className="flex items-center gap-1.5 text-[15.75px]">
                {projectId ? (
                  <Link
                    href={`/dashboard/projects/${projectId}`}
                    className="rounded-md px-1.5 py-1 font-medium text-[#78746C] hover:bg-[#F2F0EB] hover:text-slate-900"
                  >
                    {project?.name ?? "项目"}
                  </Link>
                ) : (
                  <span className="rounded-md px-1.5 py-1 font-medium text-[#78746C]">项目</span>
                )}
                <ChevronRight className="h-4 w-4 text-slate-300" />
                <div className="relative">
                  <button
                    onClick={() => setBreadOpen((v) => !v)}
                    className="flex items-center gap-1 rounded-md px-1.5 py-1 font-semibold text-[#111111] hover:bg-[#F2F0EB]"
                  >
                    {req?.title ? req.title : "Untitled"}
                    <ChevronDown className="h-4 w-4 text-slate-400" />
                  </button>
                  {breadOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => setBreadOpen(false)}
                        aria-hidden
                      />
                      <div className="absolute left-0 top-[42px] z-50 w-[280px] overflow-hidden rounded-[12px] border border-[#1111111a] bg-white shadow-[0_12px_32px_rgba(0,0,0,0.14)]">
                        <div className="max-h-[min(70vh,360px)] overflow-y-auto p-1">
                          {(siblings ?? []).map((s) => {
                            const meta = requirementStatusMeta(
                              (s.status as RequirementStatus) ?? "dialoguing"
                            );
                            return (
                              <button
                                key={s.id}
                                type="button"
                                onClick={() => {
                                  setBreadOpen(false);
                                  if (s.id !== requirementId)
                                    router.push(`/dashboard/requirements/${s.id}`);
                                }}
                                className={cn(
                                  "flex w-full items-center justify-between gap-2 rounded-[6px] px-[14px] py-[9px] text-left text-[14px] transition-colors hover:bg-[#F2F0EB]",
                                  s.id === requirementId ? "font-semibold text-[#f66612]" : "text-[#111111]"
                                )}
                              >
                                <span className="truncate">{s.title || "Untitled"}</span>
                                <span
                                  className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
                                  style={{ backgroundColor: meta.bg, color: meta.text }}
                                >
                                  {meta.label}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                        {projectId && (
                          <div className="border-t border-[#1111111a]">
                            <Link
                              href={`/dashboard/projects/${projectId}`}
                              onClick={() => setBreadOpen(false)}
                              className="flex w-full items-center justify-between gap-2 rounded-b-[11px] px-[14px] py-[10px] text-left text-[14px] font-medium text-[#78746C] transition-colors hover:bg-[#F2F0EB]"
                            >
                              <span>管理所有需求</span>
                              <ChevronRight className="h-4 w-4 text-slate-400" />
                            </Link>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </nav>
            </div>

            <div className="flex items-center gap-2">
              <button type="button" aria-label="通知" className="flex h-9 w-9 items-center justify-center rounded-[9px] hover:bg-[#F2F0EB]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/figma-dash/2.svg" alt="" className="h-[18px] w-[18px]" />
              </button>
              <button type="button" aria-label="帮助" className="flex h-9 w-9 items-center justify-center rounded-[9px] hover:bg-[#F2F0EB]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/figma-dash/3.svg" alt="" className="h-[18px] w-[18px]" />
              </button>
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#f6661233] text-[13.5px] font-bold text-[#f66612]">
                {user.initial}
              </span>
            </div>
          </header>

          {/* ===== 主体 ===== */}
          <div className="relative flex min-h-0 flex-1">
            <OutputSidebar
              outputs={outputs}
              selected={selected}
              onSelect={handleSelect}
              generatingStep={persistedGeneratingStep ?? generatingStep}
              generatingSubType={
                // 只要当前处于 design 步骤的 prototype 子阶段（生成中或生成完成等待确认），
                // 左侧栏都应把「交互原型」子产物视为可点击/高亮，而不是 disabled。
                effectiveDesignSubPhase === "prototype" ? "prototype" : null
              }
            />

            <main className="flex min-w-0 flex-1 flex-col bg-white">
              {/* 步骤导航（纯展示 + pendingPrompt 时的操作按钮） */}
              <div className="px-4 pt-3">
                <StepNavigator
                  requirementId={requirementId}
                  steps={steps}
                  currentStatus={req?.status}
                />
              </div>
              <div className="flex-1 overflow-auto px-0 pt-3 pb-0">
                {children}
              </div>
            </main>

            {rightOpen && selected && (
              <div
                style={expanded ? undefined : { width }}
                className={cn(
                  "bg-white",
                  expanded
                    ? "absolute bottom-0 left-[252px] right-0 top-0 z-20 flex flex-col shadow-xl"
                    : "relative z-10 flex shrink-0 flex-col border-l border-black/10"
                )}
              >
                {!expanded && (
                  <div
                    onPointerDown={startResize}
                    className="absolute left-0 top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize bg-transparent hover:bg-[#f6661233]"
                  />
                )}
                <div className="min-h-0 flex-1">
                  <OutputViewer
                    requirementId={requirementId}
                    outputType={selected.type}
                    subType={selected.subType}
                    expanded={expanded}
                    onToggleExpand={() => setExpanded((v) => !v)}
                    onClose={handleClose}
                    generating={
                      // 本会话内存生成态 OR 跨会话持久化生成态（切走重进后仍显示「生成中」占位）
                      (generatingStep !== null && generatingStep === stepFromOutput(selected.type)) ||
                      (persistedGeneratingStep !== null && persistedGeneratingStep === stepFromOutput(selected.type))
                    }
                    liveContent={
                      generatingStep !== null && generatingStep === stepFromOutput(selected.type)
                        ? generationContent
                        : ""
                    }
                    liveHtml={
                      generatingStep === "design" && designSubPhase === "prototype"
                        ? generationContent
                        : undefined
                    }
                  />
                </div>
                {/* M2：PRD 视图底部挂载「开发上下文」折叠面板 */}
                {selected.type === "prd" && (
                  <DevContextPanel
                    requirementId={requirementId}
                    pending={devContextPending}
                    onReady={clearDevContextPending}
                  />
                )}
              </div>
            )}

            {/* 完全收起时：最右侧窄边「产物」入口 */}
            {!rightOpen && (
              <button
                type="button"
                onClick={handleReopen}
                title="展开产物面板"
                className="flex w-11 shrink-0 border-l border-[#1111111a] bg-white text-[#78746C] transition-colors hover:bg-[#F2F0EB] hover:text-[#f66612]"
              >
                <div className="flex w-full flex-col items-center gap-1.5 pt-4">
                  <PanelRightOpen className="h-5 w-5 shrink-0" />
                  <span className="w-full text-center text-[13px] font-semibold leading-none">产<br />物</span>
                </div>
              </button>
            )}
          </div>
        </div>
      </WorkflowContext.Provider>
    </UserContext.Provider>
  );
}

// 输出物类型 → 步骤名（用于判断是否正在生成）
function stepFromOutput(type: OutputType): StepName | null {
  const map: Partial<Record<OutputType, StepName>> = {
    research_analysis: "research_analysis",
    design: "design",
    prd: "prd_writing",
  };
  return map[type] ?? null;
}
