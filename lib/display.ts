// 前端展示辅助：项目图标静态映射、相对时间、需求状态→中文+颜色。
// 纯函数，可在客户端组件安全引入。

import type { RequirementStatus, StepState } from "@/types";

// 步骤节点状态中文文案
export const STEP_STATE_LABEL: Record<StepState, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  done: "已完成",
  pending_update: "待更新",
};

// 项目品牌色板：用于需求列表的项目标识圆点（按 id 稳定映射）。
// 注：figma-dash 1-8 的品牌图标多为白描边，置于白底卡片上会不可见，
// 故项目标识统一用品牌色圆点，清晰且无资源依赖。
const PROJECT_COLORS = [
  "#f66612",
  "#4F39F6",
  "#00786F",
  "#F54900",
  "#7F22FE",
  "#008236",
];

function hash(str: string): number {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/** 按项目 id 稳定映射到品牌色（用于需求列表的项目标识圆点） */
export function projectVisual(id: string): { color: string } {
  const i = hash(id) % PROJECT_COLORS.length;
  return { color: PROJECT_COLORS[i] };
}

/** 项目卡片左下角元信息：相对时间 + 需求数量（无需求显示「0条需求」） */
export function projectCardMeta(iso: string | undefined, requirementCount: number): string {
  const time = relativeTime(iso);
  return [time, `${requirementCount}条需求`].filter(Boolean).join(" · ");
}

/**
 * 取某项目下所有需求的最近更新时间（updatedAt 的最大值）。
 * 用于项目卡片展示「该项目需求最近一次更新」而非项目自身编辑时间。
 * 无需求 / 无 updatedAt 时返回 undefined。
 */
export function latestRequirementUpdatedAt(
  requirements: { projectId: string; updatedAt?: string }[],
  projectId: string
): string | undefined {
  let latest: string | undefined;
  for (const r of requirements) {
    if (r.projectId !== projectId || !r.updatedAt) continue;
    if (!latest || r.updatedAt > latest) latest = r.updatedAt;
  }
  return latest;
}

/** ISO 时间 → 相对时间文案（"刚刚 / x分钟前 / x小时前 / x天前 / x个月前"） */
export function relativeTime(iso?: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const min = 60e3;
  const hour = 3600e3;
  const day = 864e5; // 一天 = 86,400,000 ms（之前误写成 864e4 = 8,640,000ms = 2.4h，导致「X天前」整体放大 10 倍）
  if (diff < min) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / min)}分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)}小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}天前`;
  return `${Math.floor(diff / (30 * day))}个月前`;
}

const STATUS_META: Record<RequirementStatus, { label: string; bg: string; text: string }> = {
  dialoguing: { label: "需求确认", bg: "#EEF2FF", text: "#4F39F6" },
  researching: { label: "调研分析", bg: "#F5F3FF", text: "#7F22FE" },
  designing: { label: "方案设计", bg: "#FFF7ED", text: "#F54900" },
  prd_writing: { label: "需求文档", bg: "#F0FDFA", text: "#00786F" },
  completed: { label: "已完成", bg: "#F0FDF4", text: "#008236" },
  archived: { label: "已归档", bg: "#F2F0EB", text: "#78746C" },
};

/** 需求状态枚举 → 中文标签 + 背景/文字颜色（原静态 statusBg/statusText 改为枚举映射） */
export function requirementStatusMeta(status: RequirementStatus): {
  label: string;
  bg: string;
  text: string;
} {
  return STATUS_META[status];
}

/** 需求状态 → 完成度百分比（4 步模型，按阶段粗估） */
const STATUS_PROGRESS: Record<RequirementStatus, number> = {
  dialoguing: 10,
  researching: 35,
  designing: 65,
  prd_writing: 85,
  completed: 100,
  archived: 0,
};

export function requirementProgress(status: RequirementStatus): number {
  return STATUS_PROGRESS[status];
}
