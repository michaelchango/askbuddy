"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import useSWR, { useSWRConfig } from "swr";
import type { Project, Requirement, RequirementStatus } from "@/types";
import { PageContainer, PageHeader } from "@/components/layout/page";
import {
  relativeTime,
  requirementStatusMeta,
} from "@/lib/display";
import type { ProjectStats } from "@/lib/services/projects";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { SearchInput } from "@/components/ui/search-input";
import { MoreHorizontal, Trash2 } from "lucide-react";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const d = await res.json();
  return d.ok ? d.data : null;
};
const listFetcher = async (url: string) => {
  const res = await fetch(url);
  const d = await res.json();
  return d.ok ? d.data : [];
};

const EMPTY: ProjectStats = {
  total: 0,
  active: 0,
  doneThisWeek: 0,
  notStarted: 0,
};

const STAT_CARDS: {
  key: keyof ProjectStats;
  label: string;
  sub: string;
  color: string;
}[] = [
  { key: "total", label: "总需求", sub: "本项目", color: "#111111" },
  { key: "active", label: "进行中", sub: "活跃中", color: "#FFB900" },
  { key: "doneThisWeek", label: "本周完成", sub: "+1 同比", color: "#00D492" },
  { key: "notStarted", label: "待开始", sub: "未推进", color: "#111111" },
];

type PhaseFilter = RequirementStatus | "all";
const PHASES: { value: PhaseFilter; label: string }[] = [
  { value: "all", label: "全部阶段" },
  { value: "dialoguing", label: "需求确认" },
  { value: "researching", label: "调研分析" },
  { value: "designing", label: "方案设计" },
  { value: "prd_writing", label: "需求文档" },
  { value: "completed", label: "已完成" },
  { value: "archived", label: "已归档" },
];

/** 新项目无需求时的引导：隐藏左侧菜单，视觉区只保留创建引导（单一入口）。 */
function EmptyRequirementGuide({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const { mutate: globalMutate } = useSWRConfig();

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/requirements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const d = await res.json();
      if (d.ok) {
        globalMutate(`/api/requirements?projectId=${projectId}`);
        router.push(`/dashboard/requirements/${d.data.id}`);
      }
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-63px)] flex-col items-center justify-center px-6 text-center">
      {/* 顶部视觉锚点：渐变圆 + 图标 + 角标 */}
      <div className="relative mb-7 flex h-[72px] w-[72px] items-center justify-center rounded-[20px] bg-gradient-to-br from-[#FFE1CC] to-[#FFCBA0] shadow-[0_8px_20px_-6px_rgba(246,102,18,0.35)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/figma-dash/9.svg" alt="" className="h-[34px] w-[34px] brightness-0" />
        <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[#f66612] text-[13px] font-bold leading-none text-white shadow-[0_2px_6px_rgba(246,102,18,0.4)]">
          +
        </span>
      </div>

      <h2 className="text-[21px] font-semibold leading-tight text-[#111111]">
        创建你的第一条需求
      </h2>

      <button
        type="button"
        onClick={handleCreate}
        disabled={creating}
        className="mt-9 flex h-[50px] items-center gap-2 rounded-[13px] bg-brand px-[28px] text-[16px] font-semibold text-white shadow-[0_4px_6px_-4px_rgba(246,102,18,0.3),0_10px_15px_-3px_rgba(246,102,18,0.3)] transition-colors hover:bg-brand/90 disabled:opacity-70"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/figma-dash/9.svg" alt="" className="h-[18px] w-[18px] brightness-0 invert" />
        {creating ? "创建中…" : "创建需求"}
      </button>
    </div>
  );
}

export default function ProjectRequirementsPage() {
  const router = useRouter();
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const [phaseFilter, setPhaseFilter] = useState<PhaseFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [creatingReq, setCreatingReq] = useState(false);
  const { mutate: globalMutate } = useSWRConfig();
  const [pendingReq, setPendingReq] = useState<Requirement | null>(null);
  const handleDeleteRequirement = async () => {
    const r = pendingReq;
    setPendingReq(null);
    if (!r) return;
    await fetch(`/api/requirements/${r.id}`, { method: "DELETE" });
    globalMutate(`/api/requirements?projectId=${projectId}`);
  };

  const { data: project } = useSWR<Project | null>(
    `/api/projects/${projectId}`,
    fetcher
  );
  const { data: stats } = useSWR<ProjectStats>(
    `/api/projects/${projectId}/stats`,
    fetcher
  );
  const { data: requirements = [], isLoading: reqLoading } = useSWR<Requirement[]>(
    `/api/requirements?projectId=${projectId}`,
    listFetcher
  );
  // 需求真正为空（排除加载态）时，隐藏统计/筛选/列表，只显示新手引导
  const showEmpty = !reqLoading && requirements.length === 0;

  const s = stats ?? EMPTY;

  const filtered = requirements
    .filter((r) => {
      if (phaseFilter === "all") return true;
      return r.status === phaseFilter;
    })
    .filter((r) => {
      if (!searchQuery.trim()) return true;
      return r.title.toLowerCase().includes(searchQuery.toLowerCase().trim());
    })
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

  return (
    <>
      {showEmpty ? (
        <EmptyRequirementGuide projectId={projectId} />
      ) : (
        <PageContainer>
          <PageHeader
            title={project?.name ?? "项目需求"}
            subtitle={project?.description || undefined}
            actions={
              <button
                type="button"
                onClick={async () => {
                  if (creatingReq) return;
                  setCreatingReq(true);
                  try {
                    const res = await fetch("/api/requirements", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ projectId }),
                    });
                    const d = await res.json();
                    if (d.ok) {
                      globalMutate(`/api/requirements?projectId=${projectId}`);
                      router.push(`/dashboard/requirements/${d.data.id}`);
                    }
                  } finally {
                    setCreatingReq(false);
                  }
                }}
                disabled={creatingReq}
                className="flex h-[45.5px] items-center gap-2 rounded-[13px] bg-brand px-[18px] text-[15.75px] font-semibold text-white shadow-[0_4px_6px_-4px_rgba(246,102,18,0.3),0_10px_15px_-3px_rgba(246,102,18,0.3)] transition-colors hover:bg-brand/90 disabled:opacity-70"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/figma-dash/9.svg"
                  alt=""
                  className="h-[18px] w-[18px] brightness-0 invert"
                />
                {creatingReq ? "创建中…" : "新建需求"}
              </button>
            }
          />
        {/* ===== 需求统计 ===== */}
      <div className="mt-[36px] grid grid-cols-2 gap-[16px] lg:grid-cols-4">
        {STAT_CARDS.map((c) => (
          <div
            key={c.key}
            className="rounded-[13px] border border-[#1111111a] bg-[#F9F8F5] p-[18.8px]"
          >
            <div
              className="text-[27px] font-bold leading-none"
              style={{ color: c.color }}
            >
              {s[c.key]}
            </div>
            <div className="mt-[10px] flex items-baseline gap-[6px]">
              <span className="text-[13.5px] font-medium text-[#78746C]">
                {c.label}
              </span>
              <span className="text-[10px] text-[#78746C99]">{c.sub}</span>
            </div>
          </div>
        ))}
      </div>

      {/* ===== 筛选栏 ===== */}
      <div className="mt-[20px] flex items-center gap-[12px] border-b border-[#1111111a] pb-[12px]">
        <select
          value={phaseFilter}
          onChange={(e) => setPhaseFilter(e.target.value as PhaseFilter)}
          className="h-[36.5px] rounded-[9px] border border-[#1111111a] bg-white px-[13.5px] text-[15.75px] font-medium text-[#111111] outline-none cursor-pointer appearance-none bg-no-repeat pr-[32px]"
          style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2378746C' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`, backgroundPosition: "right 10px center" }}
        >
          {PHASES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="搜索需求名称…"
          aria-label="搜索需求名称"
        />
      </div>

      {/* ===== 需求列表 ===== */}
      <div className="mt-[12px] flex flex-col gap-[12px]">
        {filtered.map((r) => {
          const meta = requirementStatusMeta(r.status as RequirementStatus);
          return (
            <Link
              key={r.id}
              href={`/dashboard/requirements/${r.id}`}
              className="group flex items-center justify-between rounded-[13px] border border-[#1111111a] bg-[#F9F8F5] p-[18.8px] transition-all hover:border-[#f6661280] hover:shadow-[0_4px_12px_rgba(246,102,18,0.10)]"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-[8px]">
                  <span className="truncate text-[15.75px] font-semibold text-[#111111]">
                    {r.title || "Untitled"}
                  </span>
                  <span
                    className="shrink-0 rounded-[7px] px-[9px] py-[3px] text-[11px] font-medium"
                    style={{ backgroundColor: meta.bg, color: meta.text }}
                  >
                    {meta.label}
                  </span>
                  {r.priority === "high" && (
                    <span className="shrink-0 rounded-[7px] bg-[rgba(255,100,103,0.10)] px-[9px] py-[3px] text-[11px] font-medium text-[#FF6467]">
                      高优
                    </span>
                  )}
                </div>
                <div className="mt-[8px] flex flex-wrap items-center gap-[8px] text-[13.5px] text-[#78746C]">
                  <span className="flex items-center gap-[5px]">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-[14px] w-[14px]"
                      aria-hidden
                    >
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 7v5l3 3" />
                    </svg>
                    {relativeTime(r.updatedAt)}
                  </span>
                  {(r.tags ?? []).map((t) => (
                    <span
                      key={t}
                      className="rounded-[4.5px] bg-[#F2F0EB] px-[6.75px] py-[2.25px] font-mono text-[13.5px] text-[#78746C]"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>

              <div className="ml-[16px] flex shrink-0 items-center">
                <DropdownMenu
                  icon={<MoreHorizontal className="h-[18px] w-[18px]" />}
                  width={132}
                  items={[
                    {
                      label: "删除",
                      danger: true,
                      icon: <Trash2 className="h-[15px] w-[15px]" />,
                      onSelect: () => setPendingReq(r),
                    },
                  ]}
                />
              </div>
            </Link>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div className="mt-[40px] flex flex-col items-center text-center">
          <p className="text-[15.75px] text-[#78746C]">
            还没有需求，点击右上角「新建需求」开始沉淀。
          </p>
        </div>
      )}
        </PageContainer>
      )}
      <ConfirmDialog
        open={!!pendingReq}
        title={`删除需求「${pendingReq?.title || "Untitled"}」？`}
        description="此操作不可恢复，删除后该需求及其对话、输出物都会被移除。"
        confirmText="删除"
        onConfirm={handleDeleteRequirement}
        onCancel={() => setPendingReq(null)}
      />
    </>
  );
}
