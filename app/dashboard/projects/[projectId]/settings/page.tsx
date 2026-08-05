"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import type { Project } from "@/types";
import { PageContainer, PageHeader } from "@/components/layout/page";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const d = await res.json();
  return d.ok ? d.data : null;
};

export default function ProjectSettingsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const router = useRouter();

  const { data: project } = useSWR<Project | null>(
    `/api/projects/${projectId}`,
    fetcher
  );

  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [deleting, setDeleting] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const curName = name ?? project?.name ?? "";
  const curDesc = description ?? project?.description ?? "";

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: curName, description: curDesc }),
      });
      if (res.ok) {
        setSaved(true);
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.message ?? "保存失败，请稍后重试");
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  async function doDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: "PATCH" });
      const d = await res.json();
      if (d.ok) {
        router.push("/dashboard/projects");
      } else {
        alert(d.error ?? "删除失败");
      }
    } catch {
      alert("网络错误，删除失败");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader title="设置" />

      {/* 基本信息 */}
      <section className="mt-[36px] max-w-[560px] rounded-[13px] border border-[#1111111a] bg-white p-[24px]">
        <h2 className="text-[16.5px] font-semibold text-[#111111]">基本信息</h2>

        <label className="mt-[18px] block text-[15.75px] font-semibold text-[#111111]">
          项目名称<span className="ml-1 text-[#f66612]">*</span>
        </label>
        <input
          value={curName}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
          placeholder="请输入项目名称"
          className="mt-[9px] h-[45px] w-full rounded-[13px] border border-[#1111111a] bg-white px-[18px] text-[15.75px] text-[#111111] outline-none transition-colors placeholder:text-[#78746C] focus:border-[#f66612]"
        />

        <label className="mt-[18px] block text-[15.75px] font-semibold text-[#111111]">
          项目简介
        </label>
        <textarea
          rows={4}
          value={curDesc}
          onChange={(e) => {
            setDescription(e.target.value);
            setSaved(false);
          }}
          placeholder="简要描述项目目标、范围与价值"
          className="mt-[9px] w-full resize-none rounded-[13px] border border-[#1111111a] bg-white p-[18px] text-[15.75px] leading-relaxed text-[#111111] outline-none transition-colors placeholder:text-[#78746C] focus:border-[#f66612]"
        />

        {error && <p className="mt-[10px] text-[12px] text-[#f66612]">{error}</p>}
        {saved && !error && (
          <p className="mt-[10px] text-[12px] text-[#16A34A]">已保存</p>
        )}

        <div className="mt-[22px] flex justify-end">
          <button
            type="button"
            onClick={save}
            disabled={saving || !curName.trim()}
            className="h-[44px] rounded-[12px] bg-[#f66612] px-[22px] text-[14.4px] font-semibold text-white transition-colors hover:bg-[#D85A10] disabled:opacity-70"
          >
            {saving ? "保存中…" : "保存修改"}
          </button>
        </div>
      </section>

      {/* 危险操作 */}
      <section className="mt-[24px] max-w-[560px] rounded-[13px] border border-[#E5484D33] bg-white p-[24px]">
        <h2 className="text-[16.5px] font-semibold text-[#E5484D]">危险操作</h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[#78746C]">
          归档项目会将其从项目列表中移除，相关需求数据仍保留。
        </p>
        {!confirmDel ? (
          <div className="mt-[18px] flex justify-end">
            <button
              type="button"
              onClick={() => setConfirmDel(true)}
              className="h-[44px] rounded-[12px] border border-[#E5484D33] bg-white px-[22px] text-[14.4px] font-semibold text-[#E5484D] transition-colors hover:bg-[#E5484D0a]"
            >
              归档项目
            </button>
          </div>
        ) : (
          <div className="mt-[18px] flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => setConfirmDel(false)}
              disabled={deleting}
              className="h-[44px] rounded-[12px] border border-[#1111111a] bg-white px-[22px] text-[14.4px] font-semibold text-[#111111] transition-colors hover:bg-[#F2F0EB] disabled:opacity-60"
            >
              取消
            </button>
            <button
              type="button"
              onClick={doDelete}
              disabled={deleting}
              className="h-[44px] rounded-[12px] bg-[#E5484D] px-[22px] text-[14.4px] font-semibold text-white transition-colors hover:bg-[#CE3B40] disabled:opacity-70"
            >
              {deleting ? "处理中…" : "确认归档"}
            </button>
          </div>
        )}
      </section>
    </PageContainer>
  );
}
