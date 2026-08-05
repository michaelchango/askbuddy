"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import useSWR, { mutate as globalMutate } from "swr";
import { ChevronRight, ChevronDown } from "lucide-react";
import {
  UserContext,
  type ShellUser,
} from "@/components/layout/dashboard-shell";
import { OutputSidebar } from "@/components/requirements/output-sidebar";
import { OutputViewer } from "@/components/requirements/output-viewer";
import StepNavigator from "@/components/requirements/step-navigator";
import { WorkflowContext, type WorkflowState, type PendingPrompt, type ChangeTask } from "@/components/requirements/workflow-context";
import type { OutputMeta, OutputType } from "@/lib/services/outputs";
import { nextStepOf } from "@/lib/steps-meta";
import type { RequirementStatus, RequirementStep, StepName } from "@/types";
import { cn } from "@/lib/utils";
import { EVT } from "@/lib/events";
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

  // 生成编排状态
  const [generatingStep, setGeneratingStep] = useState<StepName | null>(null);
  const generatingStepRef = useRef<StepName | null>(null);
  // 当前文档生成流的 AbortController，组件卸载时中止后台 SSE，避免已离开页面仍在派发事件
  const genAbortRef = useRef<AbortController | null>(null);
  const [generationContent, setGenerationContent] = useState("");
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null);
  // 变更更新任务队列
  const [changeTasks, setChangeTasks] = useState<ChangeTask[]>([]);
  // 方案设计子阶段：null=方案文档，"prototype"=原型设计
  const [designSubPhase, setDesignSubPhase] = useState<"prototype" | null>(null);

  const handleClose = () => {
    skipAutoRef.current = true;
    setSelected(null);
    setExpanded(false);
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

  // 切换需求时重置
  useEffect(() => {
    setSelected(null);
    setExpanded(false);
    skipAutoRef.current = false;
    setGeneratingStep(null);
    setGenerationContent("");
    setPendingPrompt(null);
    setChangeTasks([]);
    setDesignSubPhase(null);
  }, [requirementId]);

  // 进入需求后默认展开右侧栏
  useEffect(() => {
    if (skipAutoRef.current) return;
    if (selected != null) return;
    if (!outputs || outputs.length === 0) return;
    if (generatingStep) return; // 生成中不自动切换
    const existing = outputs.filter((o) => o.exists);
    if (existing.length > 0) {
      const pick = existing
        .slice()
        .sort((a, b) => {
          const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return tb - ta;
        })[0];
      setSelected({ type: pick.type });
    } else {
      setSelected({ type: "card" });
    }
  }, [outputs, selected, generatingStep]);

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
      // 自动切换右侧栏到对应输出物
      const outputType = STEP_TO_OUTPUT[step];
      setSelected({ type: outputType });
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
            } else if (eventType === "proceed_prompt") {
              // 后端下发确认闸门：记录待用户确认的当前阶段与下一阶段（仅 normal 模式下发）
              try {
                const data = JSON.parse(raw) as PendingPrompt & {
                  step: StepName;
                  nextStep: StepName | null;
                  version?: number;
                };
                setPendingPrompt({
                  step: data.step,
                  nextStep: data.nextStep ?? null,
                  canSkip: !!data.canSkip,
                  message: data.message ?? "",
                  version: data.version,
                  subPhase: data.subPhase,
                });
              } catch { /* ignore */ }
            } else if (eventType === "gen_message") {
              // 后端合成消息（已落库）：转发给对话面板实时追加
              try {
                const data = JSON.parse(raw) as { content: string };
                window.dispatchEvent(
                  new CustomEvent(EVT.GEN_MESSAGE, { detail: { content: data.content, requirementId } })
                );
              } catch { /* ignore */ }
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
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          console.error("生成失败:", e);
        }
      } finally {
        genAbortRef.current = null;
        setGeneratingStep(null);
        generatingStepRef.current = null;
      }
    },
    [requirementId, refreshSteps, refreshOutputs]
  );

  // ===== 变更更新队列：按依赖顺序串行重生成所有受影响的输出物 =====
  // card 已由后端在派发 change_update 前同步合并完成，此处只处理文档类输出物；
  // 每个文档重生成时携带其对应的变更点描述（changeNote），实现精准修改而非盲重生成。
  const processChangeQueue = useCallback(
    async (
      affectedOutputs: string[],
      changes: Array<{ output: string; field: string; description: string }> = []
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

      // 统一任务队列：文档步骤 + （可选）原型重生成
      type QueueItem = { output: string; isPrototype: boolean };
      const queue: QueueItem[] = stepsToRegen.map((x) => ({
        output: x.output,
        isPrototype: false,
      }));
      if (hasPrototypeTask) {
        queue.push({ output: "prototype", isPrototype: true });
      }

      // 初始化任务队列（用于展示）
      const tasks: ChangeTask[] = queue.map((q) => ({
        output: q.output,
        status: "pending" as const,
      }));
      setChangeTasks(tasks);

      // 串行执行（上游完成后再重生成下游）
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        // 标记当前任务为生成中
        setChangeTasks((prev) =>
          prev.map((t, idx) => (idx === i ? { ...t, status: "generating" } : t))
        );

        // 该文档对应的变更点描述 → changeNote
        const changeNote = changes
          .filter((c) => c.output === item.output)
          .map((c) => `- ${c.field}：${c.description}`)
          .join("\n");

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
          setChangeTasks((prev) =>
            prev.map((t, idx) => (idx === i ? { ...t, status: "error" } : t))
          );
        }
      }

      // 全部完成 → 延迟 1.5s 后清空队列，让用户体验到"全部完成"
      setTimeout(() => setChangeTasks([]), 1500);

      // 需求变更通知：整次变更作为整体，仅在所有输出物均成功完成后通知一次
      const allDone = tasks.length > 0 && tasks.every((t) => t.status === "done");
      if (allDone) {
        notifyChangeComplete(req?.title ?? "", requirementId);
      }

      // 发送完成总结消息（含 card 等全部受影响输出物，供总结展示）
      window.dispatchEvent(
        new CustomEvent(EVT.CHANGE_COMPLETE, {
          detail: {
            requirementId,
            affectedOutputs,
          },
        })
      );
    },
    [handleGenerate, requirementId]
  );

  // 监听对话面板的 change_update 事件（AI 检测到变更点）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        requirementId: string;
        affectedOutputs: string[];
        changes: Array<{ output: string; field: string; description: string }>;
        summary: string;
      };
      if (detail.requirementId !== requirementId) return;
      // 自动开始变更更新流程（携带各文档变更点，用于精准重生成）
      processChangeQueue(detail.affectedOutputs, detail.changes ?? []);
    };
    window.addEventListener(EVT.CHANGE_UPDATE, handler);
    return () => window.removeEventListener(EVT.CHANGE_UPDATE, handler);
  }, [requirementId, processChangeQueue]);

  // 原型生成函数引用（定义于下方，用 ref 避免初始化顺序导致的 TDZ）
  const generatePrototypeRef = useRef<((message?: string) => Promise<void>) | null>(null);

  // 用户点击【确认并进入下一阶段】或系统自动推进：先把当前节点置【已完成】，再生成下一节点
  // promptArg: 当由自动推进触发时传入（避免依赖 state 中的 pendingPrompt）
  const handleProceed = useCallback(async (promptArg?: PendingPrompt | null) => {
    const prompt = promptArg || pendingPrompt;
    if (!prompt) return;
    const { step, nextStep, version, subPhase } = prompt;
    // 子阶段分支：方案文档确认后进入原型设计（方案设计保持【进行中】，不标记完成）
    if (subPhase === "prototype") {
      setPendingPrompt(null);
      setDesignSubPhase("prototype");
      setSelected({ type: "design", subType: "prototype" });
      // 自动根据方案设计生成原型（无需手动点击生成按钮）
      void generatePrototypeRef.current?.();
      return;
    }
    // 仅当 promptArg 未传入时清空 state（自动推进路径无 pendingPrompt 可清）
    if (!promptArg) setPendingPrompt(null);
    // 离开方案设计步骤时退出原型子阶段
    if (step === "design") setDesignSubPhase(null);
    // 先置当前节点【已完成】并清除确认闸门
    try {
      await fetch(`/api/requirements/${requirementId}/steps`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          step,
          state: "done",
          awaitingConfirm: false,
          outputVersion: version,
        }),
      });
      await refreshSteps();
    } catch {
      /* ignore */
    }
    // 再生成下一节点（最后一步仅置 done，不再生成）
    if (nextStep) {
      handleGenerate(nextStep);
    }
  }, [pendingPrompt, handleGenerate, requirementId, refreshSteps]);

  // 用户点击【返回修改】：在对话输入框填入默认修改文案
  const RETURN_MODIFY_TEXT: Record<StepName, string> = {
    dialoguing: "我需要补充/修改需求：\n",
    research_analysis: "请帮我修改调研分析：\n",
    design: "请帮我修改方案设计：\n",
    prd_writing: "请帮我修改需求文档：\n",
  };
  const handleReturnToModify = useCallback(() => {
    const step = pendingPrompt?.step;
    const defaultText = step ? RETURN_MODIFY_TEXT[step] : "请帮我修改：\n";
    window.dispatchEvent(
      new CustomEvent(EVT.REQUEST_MODIFY, { detail: { defaultText } })
    );
  }, [pendingPrompt]);

  // 进入原型子阶段后自动根据方案设计生成可交互原型（复用与 handleGenerate 相同的 SSE 解析）
  const generatePrototype = useCallback(
    async (message = "") => {
      // 借用户点击按钮的手势上下文请求通知权限
      void requestPermission();

      const apiPath = `/api/requirements/${requirementId}/prototype`;
      setGeneratingStep("design");
      generatingStepRef.current = "design";
      setGenerationContent("");
      // 自动将右侧栏切到原型子产物
      setSelected({ type: "design", subType: "prototype" });
      skipAutoRef.current = true;
      try {
        const controller = new AbortController();
        genAbortRef.current = controller;
        const res = await fetch(apiPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
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
                window.dispatchEvent(
                  new CustomEvent(EVT.GEN_MESSAGE, { detail: { content: data.content, requirementId } })
                );
              } catch {
                /* ignore */
              }
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
      } finally {
        genAbortRef.current = null;
        setGeneratingStep(null);
        generatingStepRef.current = null;
      }
    },
    [requirementId, refreshSteps, refreshOutputs]
  );
  // 将原型生成函数挂到 ref，供 handleProceed 在运行时调用（规避 TDZ）
  generatePrototypeRef.current = generatePrototype;

  // 组件卸载（如切走需求页）时中止仍在后台运行的文档生成流，避免跨页派发实时事件
  useEffect(() => {
    return () => {
      genAbortRef.current?.abort();
      genAbortRef.current = null;
    };
  }, []);

  // 通知功能诊断：页面挂载时输出权限状态 / 安全上下文 / 来源
  useEffect(() => {
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
        // 若正在生成中，避免并发重生成：降级为开门等用户点击
        if (generatingStepRef.current) {
          setPendingPrompt({
            step: detail.step,
            nextStep: detail.nextStep ?? null,
            canSkip: detail.canSkip,
            message: detail.message ?? `是否进入「${STEP_LABELS[detail.step]}」阶段？`,
            version: detail.version,
          });
          return;
        }
        handleProceed({
          step: detail.step,
          nextStep: detail.nextStep ?? null,
          canSkip: detail.canSkip,
          message: detail.message ?? "",
          version: detail.version,
        });
        return;
      }
      // auto=false 或未设置：模型主动判定 → 渲染双按钮等用户点击
      setPendingPrompt({
        step: detail.step,
        nextStep: detail.nextStep ?? null,
        canSkip: detail.canSkip,
        message: detail.message ?? `是否进入「${STEP_LABELS[detail.step]}」阶段？`,
        version: detail.version,
      });
    };
    window.addEventListener(EVT.PROCEED_PROMPT, handler);
    return () => window.removeEventListener(EVT.PROCEED_PROMPT, handler);
  }, [requirementId, handleProceed]);

  // 退出重进会话后，从持久化的步骤状态恢复确认闸门：
  // 若存在 awaitingConfirm === true 的步骤，还原 pendingPrompt（双按钮），避免流程卡死。
  // 每个需求仅恢复一次（避免确认后 steps 暂未刷新时把按钮又弹回来）。
  const restoredReqRef = useRef<string | null>(null);
  useEffect(() => {
    if (!steps || steps.length === 0) return; // 等待 steps 数据加载完成
    if (restoredReqRef.current === requirementId) return; // 该需求已恢复过，不再重复
    restoredReqRef.current = requirementId;
    if (pendingPrompt) return; // 实时事件已设置则不再恢复
    const awaiting = steps.find((s) => s.awaitingConfirm);
    if (!awaiting) return;
    const nextStep = nextStepOf(awaiting.step);
    const message =
      awaiting.step === "dialoguing"
        ? "需求确认已完成，请确认后进入下一阶段。"
        : `${STEP_LABELS[awaiting.step] ?? ""}已生成，请确认后进入下一阶段。`;
    setPendingPrompt({
      step: awaiting.step,
      nextStep,
      canSkip: false,
      message,
      version: awaiting.outputVersion,
    });
  }, [steps, pendingPrompt, requirementId]);

  // ===== 上下文值 =====
  const workflowState: WorkflowState = {
    generatingStep,
    generationContent,
    pendingPrompt,
    onProceed: handleProceed,
    onReturnToModify: handleReturnToModify,
    changeTasks,
    designSubPhase,
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
                      <div className="absolute left-0 top-[42px] z-50 w-[280px] overflow-hidden rounded-[12px] border border-[#1111111a] bg-white p-1 shadow-[0_12px_32px_rgba(0,0,0,0.14)]">
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
                        {projectId && (
                          <div className="mt-1 border-t border-[#1111111a] pt-1">
                            <Link
                              href={`/dashboard/projects/${projectId}`}
                              onClick={() => setBreadOpen(false)}
                              className="flex w-full items-center justify-between gap-2 rounded-[6px] px-[14px] py-[9px] text-left text-[14px] font-medium text-[#78746C] transition-colors hover:bg-[#F2F0EB]"
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
            <OutputSidebar outputs={outputs} selected={selected} onSelect={handleSelect} />

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
                    ? "absolute bottom-0 left-[252px] right-0 top-0 z-20 shadow-xl"
                    : "relative z-10 shrink-0 border-l border-black/10"
                )}
              >
                {!expanded && (
                  <div
                    onPointerDown={startResize}
                    className="absolute left-0 top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize bg-transparent hover:bg-[#f6661233]"
                  />
                )}
                <OutputViewer
                  requirementId={requirementId}
                  outputType={selected.type}
                  subType={selected.subType}
                  expanded={expanded}
                  onToggleExpand={() => setExpanded((v) => !v)}
                  onClose={handleClose}
                  generating={generatingStep !== null && generatingStep === stepFromOutput(selected.type)}
                  liveContent={generatingStep !== null && generatingStep === stepFromOutput(selected.type) ? generationContent : ""}
                  liveHtml={
                    generatingStep === "design" && designSubPhase === "prototype"
                      ? generationContent
                      : undefined
                  }
                />
              </div>
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
