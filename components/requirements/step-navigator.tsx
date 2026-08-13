"use client";
import { Fragment, useMemo } from "react";
import {
  Check,
  Loader2,
  AlertTriangle,
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
        nodeBg: "#F54900",
        nodeText: "#FFFFFF",
        icon: "radio",
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
        nodeBg: "#C9C5BE",
        nodeText: "#78746C",
        icon: "none",
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
    <div className="flex items-center rounded-[14px] border border-[#1111111a] bg-white px-5 py-3">
      <div className="flex w-full items-center pl-3">
        {NODES.map((node, index) => {
          const stepData = stepMap.get(node.key);
          const state = stepData?.state ?? "not_started";
          const visual = stateVisual(state);
          const isGenerating = generatingStep === node.key;
          const isConnectorDone = state === "done";

          return (
            <Fragment key={node.key}>
              <div className="flex shrink-0 items-center gap-2">
                <div
                  className="relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold"
                  style={{
                    backgroundColor: isGenerating ? "#FFF7ED" : visual.nodeBg,
                    color: isGenerating ? "#F54900" : visual.nodeText,
                    border: isGenerating
                      ? "1.5px solid #F54900"
                      : "1.5px solid transparent",
                  }}
                >
                  {isGenerating ? (
                    <Loader2 className="h-[15px] w-[15px] animate-spin" />
                  ) : visual.icon === "check" ? (
                    <Check className="h-[15px] w-[15px]" />
                  ) : visual.icon === "alert" ? (
                    <AlertTriangle className="h-[15px] w-[15px]" />
                  ) : visual.icon === "radio" ? (
                    <span className="relative flex h-full w-full items-center justify-center rounded-full">
                      <span
                        className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-25"
                        style={{ backgroundColor: visual.color }}
                      />
                      <span
                        className="relative flex h-2.5 w-2.5 items-center justify-center rounded-full bg-white"
                      />
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-col items-start">
                  <span className="text-[14px] font-medium leading-tight text-[#111111]">{node.label}</span>
                  <span className="text-[13px] font-medium leading-tight" style={{ color: visual.color }}>
                    {isGenerating ? "生成中…" : visual.label}
                  </span>
                </div>
              </div>
              {index < NODES.length - 1 && (
                <div
                  className="mx-2 h-px flex-1"
                  style={{ backgroundColor: isConnectorDone ? "#008236" : "#C9C5BE" }}
                />
              )}
            </Fragment>
          );
        })}

      {/* 变更更新任务队列 */}
      {workflow?.changeTasks && workflow.changeTasks.length > 0 && (
        <div className="ml-3 flex shrink-0 items-center gap-1.5 rounded-[9px] bg-[#FEF3C7] px-3 py-2 text-[13px] font-medium text-[#B45309]">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在自动更新 {workflow.changeTasks.length} 个输出物…
        </div>
      )}
      </div>
    </div>
  );
}
