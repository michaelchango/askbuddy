// 知识库管理页（M4 知识复利）：浏览/筛选/搜索/新增/编辑/软删 + 沉淀入口。
"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import { Plus, Sparkles, Loader2 } from "lucide-react";
import type { KnowledgeItem, KnowledgeCategory } from "@/lib/schemas/knowledge";
import { CategoryLabel } from "@/lib/schemas/knowledge";
import { PageContainer, PageHeader } from "@/components/layout/page";
import { SearchInput } from "@/components/ui/search-input";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { KnowledgeList } from "@/components/knowledge/knowledge-list";
import { KnowledgeFormDialog } from "@/components/knowledge/knowledge-form-dialog";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const d = await res.json();
  return d.ok ? d.data : [];
};

const CATEGORY_FILTERS: Array<{ value: KnowledgeCategory | "all"; label: string }> = [
  { value: "all", label: "全部" },
  { value: "rule", label: "业务规则" },
  { value: "term", label: "术语" },
  { value: "decision", label: "决策" },
  { value: "constraint", label: "约束" },
];

export default function KnowledgePage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const { mutate: globalMutate } = useSWRConfig();

  const [filter, setFilter] = useState<KnowledgeCategory | "all">("all");
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<KnowledgeItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<KnowledgeItem | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractMsg, setExtractMsg] = useState("");

  const query = filter === "all" ? "" : `&category=${filter}`;
  const { data: items = [], mutate } = useSWR<KnowledgeItem[]>(
    `/api/projects/${projectId}/knowledge${query ? `?${query.slice(1)}` : ""}`,
    fetcher
  );

  const filtered = items.filter((k) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase().trim();
    return k.title.toLowerCase().includes(q) || k.content.toLowerCase().includes(q);
  });

  function refresh() {
    mutate();
  }

  async function handleDelete() {
    const k = pendingDelete;
    setPendingDelete(null);
    if (!k) return;
    await fetch(`/api/projects/${projectId}/knowledge/${k.id}`, { method: "DELETE" });
    refresh();
  }

  async function handleExtract() {
    if (extracting) return;
    setExtracting(true);
    setExtractMsg("");
    try {
      const res = await fetch(`/api/projects/${projectId}/knowledge/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: false }),
      });
      const d = await res.json();
      if (d.ok) {
        setExtractMsg(
          `沉淀完成：新增 ${d.data.extracted} 条，跳过 ${d.data.skipped} 条。`
        );
        refresh();
      } else {
        setExtractMsg(d.message ?? "沉淀失败");
      }
    } catch (e) {
      setExtractMsg((e as Error).message);
    } finally {
      setExtracting(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="知识库"
        subtitle="沉淀已确立的业务规则、术语、决策与约束，AI 在后续需求中自动引用并溯源。"
        actions={
          <>
            <button
              type="button"
              onClick={handleExtract}
              disabled={extracting}
              className="flex h-[45.5px] items-center gap-2 rounded-[13px] border border-[#1111111a] bg-white px-[18px] text-[15.75px] font-medium text-[#111111] transition-colors hover:bg-[#F2F0EB] disabled:opacity-70"
            >
              {extracting ? (
                <Loader2 className="h-[18px] w-[18px] animate-spin" />
              ) : (
                <Sparkles className="h-[18px] w-[18px] text-brand" />
              )}
              {extracting ? "沉淀中…" : "沉淀知识"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
              className="flex h-[45.5px] items-center gap-2 rounded-[13px] bg-brand px-[18px] text-[15.75px] font-semibold text-white shadow-[0_4px_6px_-4px_rgba(246,102,18,0.3),0_10px_15px_-3px_rgba(246,102,18,0.3)] transition-colors hover:bg-brand/90"
            >
              <Plus className="h-[18px] w-[18px]" />
              新增知识
            </button>
          </>
        }
      />

      {extractMsg && (
        <div className="mt-[16px] rounded-[10px] border border-[#0ea5e91a] bg-[#0ea5e91a] px-4 py-2.5 text-[14px] text-[#0369a1]">
          {extractMsg}
        </div>
      )}

      {/* ===== 筛选栏 ===== */}
      <div className="mt-[20px] flex items-center gap-[12px] border-b border-[#1111111a] pb-[12px]">
        <div className="flex flex-wrap gap-2">
          {CATEGORY_FILTERS.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => setFilter(c.value)}
              className={
                "rounded-[8px] px-3 py-1.5 text-[13px] font-medium transition-colors " +
                (filter === c.value
                  ? "bg-[#f6661219] text-[#f66612]"
                  : "bg-[#F2F0EB] text-[#78746C] hover:bg-[#e9e6df]")
              }
            >
              {c.label}
            </button>
          ))}
        </div>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="搜索知识…"
          aria-label="搜索知识"
        />
      </div>

      <KnowledgeList
        items={filtered}
        onEdit={(k) => {
          setEditing(k);
          setFormOpen(true);
        }}
        onDelete={setPendingDelete}
      />

      <KnowledgeFormDialog
        open={formOpen}
        projectId={projectId}
        editing={editing}
        onClose={() => setFormOpen(false)}
        onSaved={refresh}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        title={`删除知识「${pendingDelete?.title ?? ""}」？`}
        description="删除后该知识将不再参与后续检索（软删除，历史溯源引用仍保留）。"
        confirmText="删除"
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </PageContainer>
  );
}
