"use client";
import { useMemo } from "react";
import {
  CheckCircle2,
  Circle,
  Loader2,
  MinusCircle,
  AlertCircle,
  ArrowRight,
} from "lucide-react";
import { useWorkflow } from "@/components/requirements/workflow-context";
import { STEP_STATE_LABEL } from "@/lib/display";
import type { RequirementStep, StepName } from "@/types";

const NODES: { key: StepName; label: string }[] = [
  { key: "dialoguing", label: "需求确认" },
  { key: "research_analysis", label: "调研分析" },
  { key: "design", label: "方案设计" },
  { key: "prd_writing", label: "需求文档" },
];

// 步骤状态 → 视觉映射（配色 / 图标）
function stateVisual(state: RequirementStep["state"]) {
  switch (state) {
    case "done":
      return {
        label: STEP_STATE_LABEL.done,
        color: "#008236",
        nodeBg: "#008236",
        nodeText: "white",
        icon: "check",
      } as const;
    case "in_progress":
      return {
        label: STEP_STATE_LABEL.in_progress,
        color: "#F54900",
        nodeBg: "#FFF7ED",
        nodeText: "#F54900",
        icon: "minus",
      } as const;
    case "pending_update":
      return {
        label: STEP_STATE_LABEL.pending_update,
        color: "#B45309",
        nodeBg: "#FEF3C7",
        nodeText: "#B45309",
        icon: "alert",
      } as const;
    case "not_started":
    default:
      return {
        label: STEP_STATE_LABEL.not_started,
        color: "#78746C",
        nodeBg: "#F2F0EB",
        nodeText: "#78746C",
        icon: "circle",
      } as const;
  }
}

export default function StepNavigator({
  steps,
  requirementId: _requirementId,
  currentStatus: _currentStatus,
}: {
  requirementId: string;
  steps: RequirementStep[];
  currentStatus?: string;
}) {
  const workflow = useWorkflow();

  const stepMap = useMemo(() => {
    const m = new Map<StepName, RequirementStep>();
    steps?.forEach((s) => m.set(s.step, s));
    return m;
  }, [steps]);

  const generatingStep = workflow?.generatingStep ?? null;

  return (
    <div className="flex items-center justify-between gap-2 rounded-[14px] border border-[#1111111a] bg-white px-5 py-3">
      {NODES.map((node, index) => {
        const stepData = stepMap.get(node.key);
        const state = stepData?.state ?? "not_started";
        const visual = stateVisual(state);
        const isGenerating = generatingStep === node.key;
        const isConnectorDone = state === "done";

        return (
          <div key={node.key} className="flex flex-1 items-center">
            <div className="flex flex-col items-center gap-1.5">
              <div
                className="flex h-9 w-9 items-center justify-center rounded-full text-[15px] font-semibold"
                style={{
                  backgroundColor: isGenerating ? "#FFF7ED" : visual.nodeBg,
                  color: isGenerating ? "#F54900" : visual.nodeText,
                  border: isGenerating
                    ? "1.5px solid #F54900"
                    : "1.5px solid transparent",
                }}
              >
                {isGenerating ? (
                  <Loader2 className="h-[18px] w-[18px] animate-spin" />
                ) : visual.icon === "check" ? (
                  <CheckCircle2 className="h-[18px] w-[18px]" />
                ) : visual.icon === "alert" ? (
                  <AlertCircle className="h-[18px] w-[18px]" />
                ) : visual.icon === "minus" ? (
                  <MinusCircle className="h-[18px] w-[18px]" />
                ) : (
                  <Circle className="h-[18px] w-[18px]" />
                )}
              </div>
              <div className="flex flex-col items-center">
                <span className="text-[13.5px] font-medium text-[#111111]">{node.label}</span>
                <span className="text-[12px] font-medium" style={{ color: visual.color }}>
                  {isGenerating ? "生成中…" : visual.label}
                </span>
                {node.key === "design" && workflow?.designSubPhase === "prototype" && (
                  <span className="mt-0.5 rounded-full bg-[#FFF7ED] px-2 py-0.5 text-[11px] font-medium text-[#F54900]">
                    含原型设计
                  </span>
                )}
              </div>
            </div>
            {index < NODES.length - 1 && (
              <div
                className="mx-1 mb-5 h-px flex-1"
                style={{ backgroundColor: isConnectorDone ? "#008236" : "#E5E2DC" }}
              />
            )}
          </div>
        );
      })}

      {/* 操作区：pendingPrompt 时显示确认闸门双按钮 */}
      {workflow?.pendingPrompt && (
        <div className="ml-3 flex shrink-0 items-center gap-2">
          <button
            onClick={() => workflow.onReturnToModify()}
            className="flex items-center gap-1.5 rounded-[9px] border border-[#1111111a] bg-white px-3.5 py-2 text-[13.5px] font-semibold text-[#57534E] hover:bg-[#F5F4F1]"
          >
            返回修改
          </button>
          <button
            onClick={() => workflow.onProceed()}
            className="flex items-center gap-1.5 rounded-[9px] bg-[#f66612] px-3.5 py-2 text-[13.5px] font-semibold text-white hover:bg-[#e85d0a]"
          >
            {workflow.pendingPrompt.message || "确认并进入下一阶段"}
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* 变更更新任务队列 */}
      {workflow?.changeTasks && workflow.changeTasks.length > 0 && (
        <div className="ml-3 flex shrink-0 items-center gap-1.5 rounded-[9px] bg-[#FEF3C7] px-3 py-2 text-[13px] font-medium text-[#B45309]">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在自动更新 {workflow.changeTasks.length} 个输出物…
        </div>
      )}
    </div>
  );
}
