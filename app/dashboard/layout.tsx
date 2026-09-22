import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { listProjects } from "@/lib/services/projects";
import {
  DashboardShell,
  type ShellUser,
} from "@/components/layout/dashboard-shell";
import Providers from "@/components/providers";

// 数据库在境内，函数固定在香港区域，缩短每趟 SQL 跨网关往返（覆盖 Vercel 后台 region 设置）。
// 本布局是 server component（await listProjects），决定整个 dashboard 子树的 server 渲染 region。
export const regions = ["hkg1"];

/** 由会话用户派生出 Shell 需要展示的姓名/首字母（不再写死前端 mock 用户） */
function toShellUser(u: { uid: string; email: string }): ShellUser {
  const name = u.email.split("@")[0] || u.uid;
  return {
    name,
    email: u.email,
    initial: (name[0] ?? "?").toUpperCase(),
  };
}

/**
 * dashboard 是登录后的个性化页面，每次请求都要按当前用户查项目列表，
 * 本就不该被静态预渲染。
 *
 * 不加这行会有一个隐蔽后果：`getSession()` 目前是过渡期实现（硬编码返回
 * mock-user-001，不读 cookies），Next 探测不到任何动态信号，于是把
 * /dashboard 及其子路由判为 Static —— 也就是 `next build` 期间就会真的
 * 去连数据库跑 listProjects()。这会让构建机被迫持有生产库凭据，
 * 且用户数据可能被烤进静态 HTML。
 *
 * 等 M2 把 getSession() 换成真实的 cookies() 读取后，Next 会自动判为
 * 动态渲染，这行届时可以删除。
 */
export const dynamic = "force-dynamic";

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
      <Providers>{children}</Providers>
    </DashboardShell>
  );
}
