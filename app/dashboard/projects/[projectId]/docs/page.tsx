"use client";

import { useParams } from "next/navigation";
import useSWR from "swr";
import type { Requirement } from "@/types";
import type { LibraryItem } from "@/lib/services/library";
import { PageContainer, PageHeader } from "@/components/layout/page";
import { DeliverableList } from "@/components/libraries/deliverable-list";

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

export default function ProjectDocsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const { data: items = [], isLoading } = useSWR<LibraryItem[]>(
    `/api/projects/${projectId}/library/prd`,
    listFetcher
  );
  const { data: requirements = [] } = useSWR<Requirement[]>(
    `/api/requirements?projectId=${projectId}`,
    listFetcher
  );

  return (
    <PageContainer>
      <PageHeader
        title="文档库"
        subtitle="项目下所有需求的 PRD 文档汇总，支持按需求与时间筛选，点击卡片可直接预览。"
      />
      <DeliverableList
        items={items}
        requirements={requirements}
        libraryType="prd"
        isLoading={isLoading}
      />
    </PageContainer>
  );
}
