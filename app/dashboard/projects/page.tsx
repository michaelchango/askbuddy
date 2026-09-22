"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import type { Project, Requirement } from "@/types";
import { projectCardMeta, latestRequirementUpdatedAt } from "@/lib/display";
import { PageContainer, PageHeader } from "@/components/layout/page";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { SearchInput } from "@/components/ui/search-input";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const d = await res.json();
  return d.ok ? d.data : [];
};

/**
 * 项目列表页取需求的上限。只用于项目卡片的「N 个需求」计数与最近更新时间展示，
 * 不做翻页（项目卡片网格本身一次展示全部项目），取 50 条足够且能限制数据量。
 */
const REQ_PAGE_SIZE = 50;

type ProjectCardProps = {
  project: Project;
  reqCount: number;
  /** 该项目下需求最近一次更新时间（用于卡片左下角展示），缺省回退到项目自身编辑时间 */
  updatedAt?: string;
  onDeleted: () => void;
};

/** 项目卡片：整卡可点击进入；右上角「…」提供删除（二次确认）。 */
function ProjectCard({ project, reqCount, updatedAt, onDeleted }: ProjectCardProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(project.name);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [savingRename, setSavingRename] = useState(false);
  const confirmDialogRef = useRef<HTMLDialogElement>(null);
  const renameDialogRef = useRef<HTMLDialogElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = confirmDialogRef.current;
    if (!el) return;
    if (confirmOpen && !el.open) el.showModal();
    else if (!confirmOpen && el.open) el.close();
  }, [confirmOpen]);

  useEffect(() => {
    const el = renameDialogRef.current;
    if (!el) return;
    if (renameOpen && !el.open) {
      el.showModal();
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    } else if (!renameOpen && el.open) {
      el.close();
    }
  }, [renameOpen]);

  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}`, { method: "PATCH" });
      const d = await res.json();
      if (d.ok) {
        setConfirmOpen(false);
        onDeleted();
      } else {
        setDeleteError(d.error ?? "删除失败，请稍后重试");
      }
    } catch {
      setDeleteError("网络错误，删除失败");
    } finally {
      setDeleting(false);
    }
  }

  function openRename() {
    setRenameValue(project.name);
    setRenameError(null);
    setRenameOpen(true);
  }

  async function handleRename() {
    const name = renameValue.trim();
    if (!name) {
      setRenameError("项目名称不能为空");
      return;
    }
    if (name === project.name) {
      setRenameOpen(false);
      return;
    }
    setSavingRename(true);
    setRenameError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        setRenameOpen(false);
        onDeleted();
        return;
      }
      const d = await res.json().catch(() => ({}));
      if (d.error === "name_exists") {
        setRenameError(d.message ?? "已存在同名项目，请更换项目名称");
      } else {
        setRenameError("修改失败，请稍后重试");
      }
    } catch {
      setRenameError("网络错误，请稍后重试");
    } finally {
      setSavingRename(false);
    }
  }

  return (
    <div className="relative">
      <Link
        href={`/dashboard/projects/${project.id}`}
        className="group flex h-[144.48px] cursor-pointer flex-col rounded-[13px] border border-[#1111111a] bg-white p-[18.8px] transition-all hover:border-[#f6661280] hover:shadow-[0_4px_12px_rgba(246,102,18,0.10)]"
      >
        <span className="pr-[38px] text-[15.75px] font-semibold text-[#111111]">{project.name}</span>
        <p className="mt-[9px] line-clamp-2 min-h-[44px] text-[13.5px] leading-relaxed text-[#78746C]">
          {project.description}
        </p>
        <div className="mt-auto flex items-center justify-between pt-4">
          <span className="flex items-center gap-[5px] text-[12px] text-[#78746C]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/figma-dash/13.svg" alt="" className="h-[13px] w-[13px]" />
            {projectCardMeta(updatedAt, reqCount)}
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
            label: "重命名",
            icon: (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-[15px] w-[15px]"
                aria-hidden
              >
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            ),
            onSelect: openRename,
          },
          {
            label: "删除项目",
            danger: true,
            icon: (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-[15px] w-[15px]"
                aria-hidden
              >
                <path d="M3 6h18" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
              </svg>
            ),
            onSelect: () => {
              setDeleteError(null);
              setConfirmOpen(true);
            },
          },
        ]}
      />

      {/* 二次确认弹窗 */}
      <dialog
        ref={confirmDialogRef}
        closedby="any"
        aria-labelledby="confirm-delete-title"
        className="w-full max-w-[380px] rounded-[18px] bg-white p-[28px] shadow-[0_24px_60px_rgba(0,0,0,0.28)] backdrop:bg-black/40 backdrop:backdrop-blur-[2px]"
        onCancel={(e) => {
          e.preventDefault();
          if (!deleting) {
            setConfirmOpen(false);
            setDeleteError(null);
          }
        }}
      >
        {/* 警告图标 */}
        <div className="mx-auto flex h-[56px] w-[56px] items-center justify-center rounded-full bg-[#E5484D1a]">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="#E5484D"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-[26px] w-[26px]"
            aria-hidden
          >
            <path d="M3 6h18" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6M14 11v6" />
          </svg>
        </div>

        <h3
          id="confirm-delete-title"
          className="mt-[18px] text-center text-[19px] font-bold text-[#111111]"
        >
          删除项目
        </h3>
        <p className="mt-[12px] text-center text-[13.5px] leading-relaxed text-[#78746C]">
          确定要删除「<span className="font-semibold text-[#111111]">{project.name}</span>」吗？删除后不可恢复，相关需求也会一并删除。
        </p>

        {deleteError && (
          <p className="mt-[14px] rounded-[10px] border border-[#E5484D33] bg-[#E5484D0d] px-3 py-2 text-center text-[12.5px] text-[#E5484D]">
            {deleteError}
          </p>
        )}

        <div className="mt-[26px] flex gap-[12px]">
          <button
            type="button"
            onClick={() => {
              setConfirmOpen(false);
              setDeleteError(null);
            }}
            disabled={deleting}
            className="h-[44px] flex-1 rounded-[12px] border border-[#1111111a] bg-white text-[14.4px] font-semibold text-[#111111] transition-colors hover:bg-[#F2F0EB] disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            className="h-[44px] flex-1 rounded-[12px] bg-[#E5484D] text-[14.4px] font-semibold text-white transition-colors hover:bg-[#cf3b3f] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {deleting ? "删除中…" : "删除"}
          </button>
        </div>
      </dialog>

      {/* 重命名弹窗 */}
      <dialog
        ref={renameDialogRef}
        closedby="any"
        aria-labelledby="rename-title"
        className="w-full max-w-[380px] rounded-[18px] bg-white p-[28px] shadow-[0_24px_60px_rgba(0,0,0,0.28)] backdrop:bg-black/40 backdrop:backdrop-blur-[2px]"
        onCancel={(e) => {
          e.preventDefault();
          if (!savingRename) setRenameOpen(false);
        }}
      >
        <h3
          id="rename-title"
          className="text-center text-[19px] font-bold text-[#111111]"
        >
          重命名项目
        </h3>
        <p className="mt-[8px] text-center text-[13px] text-[#78746C]">
          修改项目名称，不可与其他项目重名
        </p>
        <input
          ref={renameInputRef}
          value={renameValue}
          onChange={(e) => {
            setRenameValue(e.target.value);
            if (renameError) setRenameError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !savingRename) handleRename();
          }}
          placeholder="请输入项目名称"
          className={
            "mt-[18px] h-[45px] w-full rounded-[13px] border bg-white px-[18px] text-[15.75px] text-[#111111] outline-none transition-colors placeholder:text-[#78746C] focus:border-[#f66612] " +
            (renameError ? "border-[#f66612]" : "border-[#1111111a]")
          }
        />
        {renameError && (
          <p className="mt-[6px] text-[12px] text-[#f66612]">{renameError}</p>
        )}
        <div className="mt-[26px] flex gap-[12px]">
          <button
            type="button"
            onClick={() => setRenameOpen(false)}
            disabled={savingRename}
            className="h-[44px] flex-1 rounded-[12px] border border-[#1111111a] bg-white text-[14.4px] font-semibold text-[#111111] transition-colors hover:bg-[#F2F0EB] disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleRename}
            disabled={savingRename}
            className="h-[44px] flex-1 rounded-[12px] bg-[#f66612] text-[14.4px] font-semibold text-white transition-colors hover:bg-[#D85A10] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {savingRename ? "保存中…" : "保存"}
          </button>
        </div>
      </dialog>
    </div>
  );
}

type SortBy = "updatedAt" | "createdAt";

const sortLabels: Record<SortBy, string> = {
  updatedAt: "更新时间",
  createdAt: "创建时间",
};

/** 排序切换：两个选项直接平铺展示，点击即可切换。 */
function SortTabs({
  value,
  onChange,
}: {
  value: SortBy;
  onChange: (v: SortBy) => void;
}) {
  return (
    <div
      role="group"
      aria-label="排序方式"
      className="inline-flex items-center rounded-[8px] border border-[#1111111a] bg-white p-[3px]"
    >
      {(["updatedAt", "createdAt"] as SortBy[]).map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(k)}
          aria-pressed={value === k}
          className={`h-[26px] rounded-[6px] px-3 text-[13px] font-medium transition-colors ${
            value === k
              ? "bg-[#f66612] text-white"
              : "text-[#78746C] hover:bg-[#F2F0EB] hover:text-[#111111]"
          }`}
        >
          {sortLabels[k]}
        </button>
      ))}
    </div>
  );
}

export default function ProjectsPage() {
  const [q, setQ] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("updatedAt");
  const { data: projects = [], mutate } = useSWR<Project[]>("/api/projects", fetcher);
  // 需求只用于项目卡片上的「N 个需求」计数与最近更新时间，取最近 REQ_PAGE_SIZE 条即可。
  // 原本一次拉全量，数据量随使用线性增长；生产环境前端在海外、数据库在境内，
  // 每次跨网关 SQL 往返约 1.7s，全量拉取会越来越慢。
  // 只传 limit、不传 page：本页没有翻页控件，不需要 total，
  // 省下统计总数那次跨网关往返（约 1.7s）。
  const { data: requirements = [] } = useSWR<Requirement[]>(
    `/api/requirements?limit=${REQ_PAGE_SIZE}`,
    fetcher
  );
  const reqCount = new Map<string, number>();
  for (const r of requirements) {
    reqCount.set(r.projectId, (reqCount.get(r.projectId) ?? 0) + 1);
  }
  // 各项目下需求的最近更新时间（用于项目卡片左下角展示与排序）
  const latestUpdatedAt = new Map<string, string>();
  for (const r of requirements) {
    if (!r.updatedAt) continue;
    const cur = latestUpdatedAt.get(r.projectId);
    if (!cur || r.updatedAt > cur) latestUpdatedAt.set(r.projectId, r.updatedAt);
  }
  const keyword = q.trim().toLowerCase();
  const list = (keyword
    ? projects.filter((p) => p.name.toLowerCase().includes(keyword))
    : projects
  ).sort((a, b) => {
    const keyA = sortBy === "updatedAt"
      ? (latestUpdatedAt.get(a.id) ?? a.updatedAt)
      : a.createdAt;
    const keyB = sortBy === "updatedAt"
      ? (latestUpdatedAt.get(b.id) ?? b.updatedAt)
      : b.createdAt;
    return keyB.localeCompare(keyA);
  });

  return (
    <PageContainer>
      {/* ===== 标题 + 操作 ===== */}
      <PageHeader
        title="项目管理"
        actions={
          <>
            <Link
              href="/dashboard/projects/new?from=/dashboard/projects"
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
        <div className="flex min-h-[38px] items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <h2 className="text-[18px] font-bold leading-[38px] text-[#111111]">我的项目</h2>
            <SearchInput
              value={q}
              onChange={setQ}
              placeholder="搜索项目名称"
              aria-label="搜索项目名称"
            />
          </div>
          <SortTabs value={sortBy} onChange={setSortBy} />
        </div>

        {projects.length === 0 ? (
          <div className="mt-[72px] flex flex-col items-center text-center">
            <p className="text-[15.75px] text-[#78746C]">还没有项目，创建第一个来开始管理产品需求吧</p>
            <Link
              href="/dashboard/projects/new?from=/dashboard/projects"
              className="mt-6 inline-flex h-[45.5px] items-center gap-2 rounded-[13px] bg-[#f66612] px-[22px] text-[15.75px] font-semibold text-white shadow-[0_4px_6px_-4px_rgba(246,102,18,0.3),0_10px_15px_-3px_rgba(246,102,18,0.3)] transition-colors hover:bg-[#D85A10]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/figma-dash/9.svg" alt="" className="h-[18px] w-[18px] brightness-0 invert" />
              创建第一个项目
            </Link>
          </div>
        ) : (
          <div className="mt-[18px] grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-3">
            {list.map((p: Project) => (
              <ProjectCard
                key={p.id}
                project={p}
                reqCount={reqCount.get(p.id) ?? 0}
                updatedAt={latestUpdatedAt.get(p.id) ?? p.updatedAt}
                onDeleted={() => mutate()}
              />
            ))}
          </div>
        )}

        {projects.length > 0 && list.length === 0 && (
          <p className="mt-4 text-[13.5px] text-[#78746C]">
            未找到匹配「{q}」的项目
          </p>
        )}
      </section>
    </PageContainer>
  );
}
