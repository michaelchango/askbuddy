import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { listProjects } from "@/lib/services/projects";
import {
  DashboardShell,
  type ShellUser,
} from "@/components/layout/dashboard-shell";

/** 由会话用户派生出 Shell 需要展示的姓名/首字母（不再写死前端 mock 用户） */
function toShellUser(u: { uid: string; email: string }): ShellUser {
  const name = u.email.split("@")[0] || u.uid;
  return {
    name,
    email: u.email,
    initial: (name[0] ?? "?").toUpperCase(),
  };
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  // 没有项目时隐藏侧边栏，引导用户创建第一个项目
  const projects = await listProjects(session.uid);
  const hideSidebar = projects.length === 0;

  return (
    <DashboardShell user={toShellUser(session)} hideSidebar={hideSidebar}>
      {children}
    </DashboardShell>
  );
}
