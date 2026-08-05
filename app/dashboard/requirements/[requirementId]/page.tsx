import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getRequirementWithStatus } from "@/lib/services/requirements";
import { ConversationPanel } from "@/components/requirements/conversation-panel";

export default async function RequirementPage({
  params,
}: {
  params: { requirementId: string };
}) {
  const user = await getSession();
  if (!user) redirect("/login");
  const req = await getRequirementWithStatus(params.requirementId);
  if (!req) redirect("/dashboard/projects");

  // 顶栏面包屑（项目>需求切换）与输出物左栏由 RequirementShell 提供，
  // 此处主内容区仅渲染对话面板，右侧输出物查看器亦由 shell 管理。
  return <ConversationPanel requirementId={req.id} status={req.status} />;
}
