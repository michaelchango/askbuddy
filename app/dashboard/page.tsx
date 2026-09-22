"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import useSWR from "swr";
import type { Project, Requirement, RequirementStatus } from "@/types";
import { relativeTime, requirementStatusMeta, projectCardMeta, latestRequirementUpdatedAt } from "@/lib/display";
import { useUser } from "@/components/layout/dashboard-shell";
import { PageContainer, PageHeader } from "@/components/layout/page";
import { ProjectNewForm } from "@/components/project-new-form";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Trash2, Loader2 } from "lucide-react";

/** 需求状态图标：统一「带底色方框 + 居中图标」样式，方框底色与状态标签一致，大小统一 */
function RequirementStatusIcon({
  status,
  bg,
  color,
}: {
  status: RequirementStatus;
  bg: string;
  color: string;
}) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  let glyph: React.ReactNode;
  switch (status) {
    case "dialoguing":
      glyph = <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />;
      break;
    case "researching":
      glyph = (
        <>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </>
      );
      break;
    case "designing":
      glyph = (
        <>
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          <path d="m15 5 4 4" />
        </>
      );
      break;
    case "prd_writing":
      glyph = (
        <>
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
          <path d="M14 2v4a2 2 0 0 0 2 2h4" />
        </>
      );
      break;
    case "completed":
      glyph = (
        <>
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="m9 12 2 2 4-4" />
        </>
      );
      break;
    case "archived":
      glyph = (
        <>
          <rect width="20" height="5" x="2" y="3" rx="1" />
          <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
          <path d="M10 12h4" />
        </>
      );
      break;
  }
  return (
    <span
      className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[7px]"
      style={{ backgroundColor: bg }}
    >
      <svg {...common}>{glyph}</svg>
    </span>
  );
}

/** 空状态引导：当前用户尚无项目与需求时的强引导视图。 */
function EmptyState() {
  const router = useRouter();
  // intro：引导卡片态；form：从「新建项目」按钮浮现出表单态（不跳转页面）
  const [mode, setMode] = useState<"intro" | "form">("intro");
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const [shown, setShown] = useState(false);
  const formWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode === "form" && formWrapRef.current && origin) {
      const rect = formWrapRef.current.getBoundingClientRect();
      formWrapRef.current.style.transformOrigin = `${origin.x - rect.left}px ${origin.y - rect.top}px`;
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
  }, [mode, origin]);

  function openNew(e: React.MouseEvent<HTMLElement>) {
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setOrigin({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    setMode("form");
  }

  return (
    <div
      className={
        "flex flex-col items-center transition-all duration-300 " +
        (mode === "form" ? "pt-[40px] pb-16" : "pt-[80px] pb-16")
      }
    >
      {/* Logo */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo-orange.png"
        alt="AskBuddy"
        className="h-[180px] w-auto"
      />

      <h2 className="mt-2 text-[24px] font-bold text-[#111111]">创建你的第一个项目</h2>
      <p className="mt-3 text-[15.75px] text-[#78746C]">把零散的想法沉淀为可管理的产品需求</p>

      {mode === "intro" ? (
        <div className="mt-9 flex items-stretch gap-4">
          <button
            type="button"
            onClick={openNew}
            className="flex w-[200px] flex-col items-center gap-3 rounded-[13px] border border-[#1111111a] bg-white px-6 py-7 text-left transition-all hover:border-[#f6661280] hover:shadow-[0_4px_12px_rgba(246,102,18,0.10)]"
          >
            <span className="flex h-[40px] w-[40px] items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/figma-dash/9.svg" alt="" className="h-[24px] w-[24px] brightness-0" />
            </span>
            <span className="text-[15.75px] font-semibold text-[#111111]">新建项目</span>
          </button>

          <div className="flex items-center text-[13.5px] text-[#78746C]">或</div>

          <Link
            href="/dashboard/projects"
            className="flex w-[200px] flex-col items-center gap-3 rounded-[13px] bg-brand px-6 py-7 text-white shadow-[0_4px_6px_-4px_rgba(246,102,18,0.3),0_10px_15px_-3px_rgba(246,102,18,0.3)] transition-colors hover:bg-brand/90"
          >
            <span className="flex h-[40px] w-[40px] items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/figma-dash/10.svg" alt="" className="h-[24px] w-[24px] brightness-0 invert" />
            </span>
            <span className="text-[15.75px] font-semibold">召唤 AI 需求助手</span>
          </Link>
        </div>
      ) : (
        <div
          ref={formWrapRef}
          className={
            "w-full flex flex-col items-center transition-all duration-300 ease-out " +
            (shown ? "opacity-100 scale-100" : "opacity-0 scale-90")
          }
        >
          <ProjectNewForm
            onCancel={() => setMode("intro")}
            onSuccess={(p) => router.push(`/dashboard/projects/${p.id}`)}
          />
        </div>
      )}
    </div>
  );
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const d = await res.json();
  return d.ok ? d.data : [];
};

/**
 * 概览页取「最近需求」的上限。
 * 这里只用于：下方列表展示前 5 条 + 项目卡片上「N 个需求」的粗略计数，
 * 不需要全量。取 50 条既够用，又避免数据量随使用无限增长
 * （生产环境每次跨网关 SQL 往返约 1.7s，全量拉取会越来越慢）。
 */
const REQ_PAGE_SIZE = 50;

export default function DashboardOverview() {
  const user = useUser();
  const { data: projects = [], mutate: mutateProjects } = useSWR<Project[]>(
    "/api/projects",
    fetcher
  );
  const [pendingProject, setPendingProject] = useState<Project | null>(null);
  const handleDeleteProject = async () => {
    const p = pendingProject;
    setPendingProject(null);
    if (!p) return;
    await fetch(`/api/projects/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "archive" }),
    });
    mutateProjects();
  };
  // 概览页只展示「最近需求」（前 5 条）与项目卡片的粗略计数，
  // 原本一次拉全量需求再前端切片 —— 数据量随使用无限增长，而跨网关 SQL 往返
  // 在生产环境约 1.7s/次，全量拉取会越来越慢。改为只取最近 REQ_PAGE_SIZE 条。
  const { data: requirements = [], mutate: mutateRequirements } = useSWR<Requirement[]>(
    `/api/requirements?page=1&pageSize=${REQ_PAGE_SIZE}`,
    fetcher
  );

  // 若有需求正在生成中，低频轮询列表以在生成完成后自动刷新状态与阶段标签。
  const anyGenerating = requirements.some((r) => !!r.generatingStep);
  useEffect(() => {
    if (!anyGenerating) return;
    const id = setInterval(() => {
      mutateRequirements();
    }, 3000);
    return () => clearInterval(id);
  }, [anyGenerating, mutateRequirements]);

  const projectMap = new Map(projects.map((p) => [p.id, p]));
  const reqCount = new Map<string, number>();
  for (const r of requirements) {
    reqCount.set(r.projectId, (reqCount.get(r.projectId) ?? 0) + 1);
  }
  const recentReqs = [...requirements]
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, 5);

  // 空态：项目和需求都为 0，切换到强引导视图（隐藏原 section 标题与列表）。
  const isEmpty = projects.length === 0 && requirements.length === 0;

  return (
    <>
      {isEmpty ? (
        <EmptyState />
      ) : (
        <PageContainer>
          {/* ===== 欢迎语 + 操作 ===== */}
          <PageHeader
            title={user?.name ? `欢迎回来，${user.name}！` : "欢迎回来！"}
            actions={
              <>
                <Link
                  href="/dashboard/projects/new?from=/dashboard"
                  className="flex h-[45.5px] items-center gap-2 rounded-[13px] border border-[#1111111a] bg-white px-[18px] text-[15.75px] font-semibold text-[#111111] transition-colors hover:bg-[#F2F0EB]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/figma-dash/9.svg" alt="" className="h-[18px] w-[18px] brightness-0" />
                  新建项目
                </Link>
                <Link
                  href="/dashboard/projects"
                  className="flex h-[45.5px] items-center gap-2 rounded-[13px] bg-brand px-[18px] text-[15.75px] font-semibold text-white shadow-[0_4px_6px_-4px_rgba(246,102,18,0.3),0_10px_15px_-3px_rgba(246,102,18,0.3)] transition-colors hover:bg-brand/90"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/figma-dash/10.svg" alt="" className="h-[18px] w-[18px] brightness-0 invert" />
                  AI 需求助手
                </Link>
              </>
            }
          />

      {/* ===== 我的项目 ===== */}
      <section className="mt-[36px]">
        <div className="flex min-h-[38px] items-start justify-between gap-4">
          <h2 className="text-[18px] font-bold leading-[38px] text-[#111111]">我的项目</h2>
          <Link
            href="/dashboard/projects"
            className="flex h-[38px] items-center gap-1 text-[13.5px] font-medium text-[#f66612]"
          >
            查看全部
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/figma-dash/11.svg" alt="" className="h-[13px] w-[13px]" />
          </Link>
        </div>

        {projects.length === 0 ? (
          <p className="mt-4 text-[13.5px] text-[#78746C]">
            还没有项目，点击「新建项目」开始。
          </p>
        ) : (
          <div className="mt-[18px] grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-3">
            {[...projects]
              .sort((a, b) => {
                const ta = latestRequirementUpdatedAt(requirements, a.id) ?? a.updatedAt ?? "";
                const tb = latestRequirementUpdatedAt(requirements, b.id) ?? b.updatedAt ?? "";
                return tb.localeCompare(ta);
              })
              .slice(0, 3)
              .map((p) => {
              return (
                <div key={p.id} className="relative">
                  <Link
                    href={`/dashboard/projects/${p.id}`}
                    className="group flex h-[144.48px] cursor-pointer flex-col rounded-[13px] border border-[#1111111a] bg-white p-[18.8px] transition-all hover:border-[#f6661280] hover:shadow-[0_4px_12px_rgba(246,102,18,0.10)]"
                  >
                    <span className="pr-[38px] text-[15.75px] font-semibold text-[#111111]">
                      {p.name}
                    </span>
                    <p className="mt-[9px] line-clamp-2 min-h-[44px] text-[13.5px] leading-relaxed text-[#78746C]">
                      {p.description}
                    </p>
                    <div className="mt-auto flex items-center justify-between pt-4">
                      <span className="flex items-center gap-[5px] text-[12px] text-[#78746C]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src="/figma-dash/13.svg" alt="" className="h-[13px] w-[13px]" />
                        {projectCardMeta(latestRequirementUpdatedAt(requirements, p.id) ?? p.updatedAt, reqCount.get(p.id) ?? 0)}
                      </span>
                      <span className="text-[12px] text-[#78746C] transition-colors group-hover:text-[#f66612]">
                        进入项目 →
                      </span>
                    </div>
                  </Link>

                  <DropdownMenu
                    className="absolute right-[12px] top-[12px] z-30"
                    icon={
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src="/figma-dash/12.svg" alt="" className="h-[15.75px] w-[15.75px]" />
                    }
                    items={[
                      {
                        label: "删除项目",
                        danger: true,
                        icon: <Trash2 className="h-[15px] w-[15px]" />,
                        onSelect: () => setPendingProject(p),
                      },
                    ]}
                  />
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ===== 最近需求 ===== */}
      <section className="mt-[36px]">
        <div className="flex items-center justify-between">
          <h2 className="text-[18px] font-bold text-[#111111]">最近需求</h2>
          {false && (
          <Link
            href="/dashboard/projects"
            className="flex items-center gap-1 text-[13.5px] font-medium text-brand"
          >
            查看全部
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/figma-dash/18.svg" alt="" className="h-[13px] w-[13px]" />
          </Link>
          )}
        </div>

        {recentReqs.length === 0 ? (
          <p className="mt-4 text-[13.5px] text-[#78746C]">暂无需求。</p>
        ) : (
          <div className="mt-[18px] overflow-x-auto rounded-[13px] border border-[#1111111a] bg-white">
            <div className="min-w-[760px]">
              <div className="grid grid-cols-[minmax(0,1fr)_140px_160px_120px] items-center border-b border-[#1111111a] bg-[#F2F0EB4D] px-[22.5px] py-[13.5px] text-[13.5px] font-semibold text-[#78746C]">
                <span>需求名称</span>
                <span className="pl-[11.25px]">状态</span>
                <span>所属项目</span>
                <span>最近更新</span>
              </div>

              {recentReqs.map((r) => {
                const meta = requirementStatusMeta(r.status);
                const proj = projectMap.get(r.projectId);
                return (
                  <div
                    key={r.id}
                    className="grid grid-cols-[minmax(0,1fr)_140px_160px_120px] items-center border-b border-[#1111111a] px-[22.5px] py-[15.75px] text-[13.5px] last:border-b-0"
                  >
                    <div className="flex items-center gap-[10px]">
                      <RequirementStatusIcon status={r.status} bg={meta.bg} color={meta.text} />
                      <span className="font-bold text-[#111111]">{r.title || "Untitled"}</span>
                    </div>
                    <div className="flex items-center gap-[6px]">
                      <span
                        className="inline-block rounded-[7px] px-[11.25px] py-[4.5px] text-[11px] font-medium"
                        style={{ backgroundColor: meta.bg, color: meta.text }}
                      >
                        {meta.label}
                      </span>
                      {r.generatingStep && (
                        <span className="flex items-center gap-1 rounded-[7px] bg-[#f666121a] px-[9px] py-[4.5px] text-[11px] font-medium text-brand">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          生成中
                        </span>
                      )}
                    </div>
                    <div className="text-[#78746C]">{proj?.name ?? "—"}</div>
                    <div className="text-[#78746C]">{relativeTime(r.updatedAt)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
      </PageContainer>
      )}
      <ConfirmDialog
        open={!!pendingProject}
        title={`删除项目「${pendingProject?.name ?? ""}」？`}
        description="项目将被归档（软删除），其下的需求仍会保留。"
        confirmText="删除项目"
        onConfirm={handleDeleteProject}
        onCancel={() => setPendingProject(null)}
      />
    </>
  );
}
