"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import useSWR from "swr";
import { ChevronRight } from "lucide-react";
import type { Project, Requirement } from "@/types";
import { UserContext, type ShellUser } from "@/components/layout/dashboard-shell";

/** 项目内部菜单 */
const PROJECT_NAV = [
  {
    key: "overview",
    label: "项目需求",
    href: (id: string) => `/dashboard/projects/${id}`,
    match: (p: string, base: string) => p === base,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
      </svg>
    ),
  },
  {
    key: "research",
    label: "调研库",
    href: (id: string) => `/dashboard/projects/${id}/research`,
    match: (p: string, base: string) => p.startsWith(`${base}/research`),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </svg>
    ),
  },
  {
    key: "solution",
    label: "方案库",
    href: (id: string) => `/dashboard/projects/${id}/solution`,
    match: (p: string, base: string) => p.startsWith(`${base}/solution`),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
    ),
  },
  {
    key: "prototype",
    label: "原型库",
    href: (id: string) => `/dashboard/projects/${id}/prototype`,
    match: (p: string, base: string) => p.startsWith(`${base}/prototype`),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 19l7-7 3 3-7 7-3-3z" />
        <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
        <path d="M2 2l7.586 7.586" />
        <circle cx="11" cy="11" r="2" />
      </svg>
    ),
  },
  {
    key: "docs",
    label: "文档库",
    href: (id: string) => `/dashboard/projects/${id}/docs`,
    match: (p: string, base: string) => p.startsWith(`${base}/docs`),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6a2 2 0 0 0 2 2h6" />
        <path d="M9 13h6M9 17h6" />
      </svg>
    ),
  },
  {
    key: "settings",
    label: "设置",
    href: (id: string) => `/dashboard/projects/${id}/settings`,
    match: (p: string, base: string) => p.startsWith(`${base}/settings`),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
];

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

export function ProjectShell({
  user,
  children,
}: {
  user: ShellUser;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // 从 /dashboard/projects/<id>[/...] 取项目 id
  const m = pathname.match(/^\/dashboard\/projects\/([^/]+)(?:\/.*)?$/);
  const projectId = m && m[1] !== "new" ? m[1] : null;

  const { data: project } = useSWR<Project | null>(
    projectId ? `/api/projects/${projectId}` : null,
    fetcher
  );
  const { data: projects = [] } = useSWR<Project[]>(
    projectId ? "/api/projects" : null,
    listFetcher
  );
  // 项目下无任何需求时隐藏左侧内部菜单（与全局「无项目隐藏菜单」保持一致）
  const { data: requirements = [], isLoading: reqLoading } = useSWR<Requirement[]>(
    projectId ? `/api/requirements?projectId=${projectId}` : null,
    listFetcher
  );
  const hideNav = !reqLoading && requirements.length === 0;

  useEffect(() => {
    setSwitcherOpen(false);
  }, [projectId]);

  const base = projectId ? `/dashboard/projects/${projectId}` : "/dashboard/projects";

  return (
    <UserContext.Provider value={user}>
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

            {/* 面包屑：只到项目名层级，与需求详情页顶部面包屑保持字体/字号/位置一致 */}
            <nav className="flex items-center gap-1.5 text-[15.75px]">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setSwitcherOpen((v) => !v)}
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 font-semibold text-[#111111] hover:bg-[#F2F0EB]"
                >
                  <span className="max-w-[220px] truncate">
                    {project?.name ?? "项目"}
                  </span>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={"h-4 w-4 text-slate-400 transition-transform " + (switcherOpen ? "rotate-180" : "")}
                    aria-hidden
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>

              {switcherOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setSwitcherOpen(false)}
                    aria-hidden
                  />
                  <div className="absolute left-0 top-[42px] z-50 w-[280px] overflow-hidden rounded-[12px] border border-[#1111111a] bg-white p-1 shadow-[0_12px_32px_rgba(0,0,0,0.14)]">
                    {projects.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setSwitcherOpen(false);
                          if (p.id !== projectId) router.push(`/dashboard/projects/${p.id}`);
                        }}
                        className={
                          "flex w-full items-center justify-between gap-2 rounded-[6px] px-[14px] py-[9px] text-left text-[14px] transition-colors hover:bg-[#F2F0EB] " +
                          (p.id === projectId ? "font-semibold text-[#f66612]" : "text-[#111111]")
                        }
                      >
                        <span className="truncate">{p.name}</span>
                        {p.id === projectId && (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px] shrink-0" aria-hidden>
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                        )}
                      </button>
                    ))}
                    <div className="mt-1 border-t border-[#1111111a] pt-1">
                      <Link
                        href="/dashboard/projects"
                        onClick={() => setSwitcherOpen(false)}
                        className="flex w-full items-center justify-between gap-2 rounded-[6px] px-[14px] py-[9px] text-left text-[14px] font-medium text-[#78746C] transition-colors hover:bg-[#F2F0EB]"
                      >
                        <span>管理所有项目</span>
                        <ChevronRight className="h-4 w-4 text-slate-400" />
                      </Link>
                    </div>
                  </div>
                </>
              )}
            </div>
          </nav>
        </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="通知"
              className="flex h-9 w-9 items-center justify-center rounded-[9px] hover:bg-[#F2F0EB]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/figma-dash/2.svg" alt="" className="h-[18px] w-[18px]" />
            </button>
            <button
              type="button"
              aria-label="帮助"
              className="flex h-9 w-9 items-center justify-center rounded-[9px] hover:bg-[#F2F0EB]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/figma-dash/3.svg" alt="" className="h-[18px] w-[18px]" />
            </button>
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#f6661233] text-[13.5px] font-bold text-[#f66612]">
              {user.initial}
            </span>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
        {/* ===== 项目内部侧边栏：无需求时隐藏 ===== */}
        {!hideNav && (
        <aside className="flex h-full w-[252px] shrink-0 flex-col overflow-y-auto border-r border-[#1111111a] bg-[#F4F3EF]">
            <nav className="flex flex-col gap-1 p-[13.5px]">
              {PROJECT_NAV.map((item) => {
                const active = item.match(pathname, base);
                return (
                  <Link
                    key={item.key}
                    href={item.href(projectId ?? "")}
                    className={
                      "flex h-[45px] items-center gap-[13.5px] rounded-[9px] px-[13.5px] text-[15.75px] transition-colors " +
                      (active
                        ? "bg-[#f6661219] font-semibold text-[#f66612]"
                        : "font-medium text-[#1e293b] hover:bg-[#1111110a]")
                    }
                  >
                    <span className="h-[18px] w-[18px] shrink-0">{item.icon}</span>
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </aside>
        )}

          <main className="scrollbar-hide min-h-0 flex-1 overflow-y-auto bg-white">
            {children}
          </main>
        </div>
      </div>
    </UserContext.Provider>
  );
}
