"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import useSWR, { useSWRConfig } from "swr";
import { relativeTime, requirementStatusMeta } from "@/lib/display";
import type { Requirement, RequirementStatus } from "@/types";
import { PageContainer, PageHeader } from "@/components/layout/page";

export default function ProjectRequirementsPage() {
  const router = useRouter();
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const { mutate: globalMutate } = useSWRConfig();
  const [creating, setCreating] = useState(false);

  const { data: requirements = [] } = useSWR<Requirement[]>(
    `/api/requirements?projectId=${projectId}`,
    (url: string) =>
      fetch(url).then((r) => r.json()).then((d) => (d.ok ? d.data : []))
  );

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
    <PageContainer>
      <PageHeader
        title="需求库"
        actions={
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="flex h-[45.5px] items-center gap-2 rounded-[13px] bg-brand px-[18px] text-[15.75px] font-semibold text-white shadow-[0_4px_6px_-4px_rgba(246,102,18,0.3),0_10px_15px_-3px_rgba(246,102,18,0.3)] transition-colors hover:bg-brand/90 disabled:opacity-70"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/figma-dash/9.svg" alt="" className="h-[18px] w-[18px] brightness-0 invert" />
            {creating ? "创建中…" : "新建需求"}
          </button>
        }
      />

      <div className="mt-[36px] grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-3">
        {requirements.map((r) => {
          const meta = requirementStatusMeta(r.status as RequirementStatus);
          return (
            <Link
              key={r.id}
              href={`/dashboard/requirements/${r.id}`}
              className="group flex h-[150px] cursor-pointer flex-col rounded-[13px] border border-[#1111111a] bg-white p-[18.8px] transition-all hover:border-[#f6661280] hover:shadow-[0_4px_12px_rgba(246,102,18,0.10)]"
            >
              <span className="line-clamp-2 text-[16.5px] font-semibold text-[#111111]">
                {r.title || "Untitled"}
              </span>
              <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-[#78746C]">
                {r.card?.background || "暂无描述"}
              </p>
              <div className="mt-auto flex items-center justify-between pt-3">
                <span
                  className="inline-block rounded-[7px] px-[11.25px] py-[4.5px] text-[11px] font-medium"
                  style={{ backgroundColor: meta.bg, color: meta.text }}
                >
                  {meta.label}
                </span>
                <span className="text-[12px] text-[#78746C]">
                  {relativeTime(r.updatedAt)}
                </span>
              </div>
            </Link>
          );
        })}
      </div>

      {requirements.length === 0 && (
        <div className="mt-[64px] flex flex-col items-center text-center">
          <p className="text-[15.75px] text-[#78746C]">还没有需求，点击右上角「新建需求」开始沉淀。</p>
        </div>
      )}
    </PageContainer>
  );
}
