"use client";

import Link from "next/link";
import { createContext, useContext } from "react";
import { usePathname, useRouter } from "next/navigation";
import useSWR from "swr";
import { ProjectShell } from "@/components/layout/project-shell";
import { RequirementShell } from "@/components/layout/requirement-shell";

const listFetcher = async (url: string) => {
  const res = await fetch(url);
  const d = await res.json();
  return d.ok ? d.data : [];
};

export type ShellUser = { name: string; email: string; initial: string };

/** 把登录会话用户下传给子页面（如概览页欢迎语），避免写死前端 mock 用户 */
export const UserContext = createContext<ShellUser | null>(null);
export function useUser() {
  return useContext(UserContext);
}

/** 侧边栏是否隐藏（无项目时隐藏），供新建页决定表单居中或靠左 */
export const SidebarHiddenContext = createContext(false);
export function useSidebarHidden() {
  return useContext(SidebarHiddenContext);
}

const NAV = [
  {
    href: "/dashboard",
    label: "概览",
    icon: "/figma-dash/4.svg",
    match: (p: string) => p === "/dashboard",
  },
  {
    href: "/dashboard/projects",
    label: "项目管理",
    icon: "/figma-dash/6.svg",
    match: (p: string) =>
      p.startsWith("/dashboard/projects") &&
      !p.startsWith("/dashboard/projects/new"),
  },
  {
    href: "/dashboard/tokens",
    label: "API Token",
    icon: "/figma-dash/token.svg",
    match: (p: string) => p.startsWith("/dashboard/tokens"),
  },
  {
    href: "/dashboard/settings",
    label: "系统设置",
    icon: "/figma-dash/7.svg",
    match: (p: string) => p.startsWith("/dashboard/settings"),
  },
];

export function DashboardShell({
  user,
  hideSidebar = false,
  children,
}: {
  user: ShellUser;
  hideSidebar?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  // 客户端响应式判断「是否隐藏侧边栏」：服务端 layout 只在首次渲染算一次，
  // 客户端导航不会重跑，故改为读取 SWR 缓存的实时项目列表；未返回前沿用服务端初值，避免闪烁。
  const { data: projects } = useSWR<{ id: string }[]>("/api/projects", listFetcher);
  const sidebarHidden = projects ? projects.length === 0 : hideSidebar;

  // 项目详情路由（/dashboard/projects/<id>[/...]）使用项目内部壳，替换全局侧边栏/顶栏
  const projMatch = pathname.match(/^\/dashboard\/projects\/([^/]+)(?:\/.*)?$/);
  if (projMatch && projMatch[1] !== "new") {
    return <ProjectShell user={user}>{children}</ProjectShell>;
  }

  // 需求详情路由（/dashboard/requirements/<id>）使用需求内部壳，顶栏放项目>需求面包屑、左栏替换为输出物栏
  const reqMatch = pathname.match(/^\/dashboard\/requirements\/([^/]+)(?:\/.*)?$/);
  if (reqMatch) {
    return (
      <RequirementShell user={user} requirementId={reqMatch[1]}>
        {children}
      </RequirementShell>
    );
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden font-[Plus_Jakarta_Sans]">
      {/* ===== 顶栏 ===== */}
      <header className="flex h-[63px] shrink-0 items-center justify-between border-b border-[#1111111a] bg-white px-7">
        <Link href="/dashboard" className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-orange.png" alt="AskBuddy" className="h-[40px] w-auto" />
          <span className="text-[22px] font-bold text-[#111111]">AskBuddy</span>
        </Link>

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
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand/20 text-[13.5px] font-bold text-brand">
            {user.initial}
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ===== 侧边栏：无项目时完全隐藏 ===== */}
        {!sidebarHidden && (
        <aside className="flex h-full w-[252px] shrink-0 flex-col overflow-y-auto border-r border-[#1111111a] bg-[#F4F3EF]">
          <nav className="flex flex-col gap-1 p-[13.5px]">
            {NAV.map((item) => {
              const active = item.match(pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={
                    "flex h-[45px] items-center gap-[13.5px] rounded-[9px] px-[13.5px] text-[15.75px] transition-colors " +
                    (active
                  ? "bg-brand/10 font-semibold text-brand"
                  : "font-medium text-[#1e293b] hover:bg-[#1111110a]")
                  }
                >
                  <span
                    aria-hidden
                    className="h-[18px] w-[18px] shrink-0 bg-current"
                    style={{
                      WebkitMaskImage: `url(${item.icon})`,
                      maskImage: `url(${item.icon})`,
                      WebkitMaskSize: "contain",
                      maskSize: "contain",
                      WebkitMaskRepeat: "no-repeat",
                      maskRepeat: "no-repeat",
                      WebkitMaskPosition: "center",
                      maskPosition: "center",
                    }}
                  />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="mt-auto border-t border-[#1111111a] p-[13.5px]">
            <div className="flex items-center gap-3">
              <span className="flex h-[31.5px] w-[31.5px] shrink-0 items-center justify-center rounded-full bg-brand/20 text-[13.5px] font-bold text-brand">
                {user.initial}
              </span>
              <div className="min-w-0">
                <div className="truncate text-[13.5px] font-semibold text-[#111111]">
                  {user.name}
                </div>
                <div className="truncate text-[10px] text-[#1e293b]">
                  {user.email}
                </div>
              </div>
              <button
                type="button"
                onClick={logout}
                aria-label="退出登录"
                className="ml-auto flex h-8 w-8 items-center justify-center rounded-[9px] hover:bg-[#1111110a]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/figma-dash/8.svg" alt="" className="h-[18px] w-[18px]" />
              </button>
            </div>
          </div>
        </aside>
        )}

        <main className="scrollbar-hide min-h-0 flex-1 overflow-y-auto bg-white">
          <UserContext.Provider value={user}>
            <SidebarHiddenContext.Provider value={sidebarHidden}>
              {children}
            </SidebarHiddenContext.Provider>
          </UserContext.Provider>
        </main>
      </div>
    </div>
  );
}
