"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ProjectNewForm } from "@/components/project-new-form";
import { useSidebarHidden } from "@/components/layout/dashboard-shell";
import { PageContainer, PageHeader } from "@/components/layout/page";

/** 记录进入本页的来源：来自项目管理页 → 取消/创建回项目管理；来自概览页 → 回概览。默认回项目管理。 */
function getBackTarget(searchParams: ReturnType<typeof useSearchParams>): string {
  const from = searchParams.get("from");
  if (from === "/dashboard" || from === "/dashboard/projects") return from;
  return "/dashboard/projects";
}

function NewProjectForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const backTo = getBackTarget(searchParams);
  const centered = useSidebarHidden();

  if (centered) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center px-9 py-16 font-[Plus_Jakarta_Sans]">
        <h1 className="text-[27px] font-bold text-[#111111] text-center">
          新建项目
        </h1>
        <p className="mt-[4.5px] text-[15.75px] text-[#78746C] text-center">
          填写项目基本信息，创建后即可在项目中管理需求。
        </p>
        <ProjectNewForm
          onCancel={() => router.push(backTo)}
          onSuccess={(p) => router.push(`/dashboard/projects/${p.id}`)}
        />
      </div>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="新建项目"
        subtitle="填写项目基本信息，创建后即可在项目中管理需求。"
      />
      <ProjectNewForm
        onCancel={() => router.push(backTo)}
        onSuccess={(p) => router.push(`/dashboard/projects/${p.id}`)}
      />
    </PageContainer>
  );
}

export default function NewProjectPage() {
  return (
    <Suspense>
      <NewProjectForm />
    </Suspense>
  );
}
