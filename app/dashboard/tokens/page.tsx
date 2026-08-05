"use client";

import { useState, useCallback, useRef } from "react";
import useSWR from "swr";
import { api } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { PageContainer, PageHeader } from "@/components/layout/page";
import type { ApiToken } from "@/types";
import { useUser } from "@/components/layout/dashboard-shell";

const EXPIRY_OPTIONS = [
  { label: "7 天", value: 7 },
  { label: "30 天", value: 30 },
  { label: "90 天", value: 90 },
  { label: "永不过期", value: 0 },
] as const;

const MCP_GUIDE_TABS = [
  { id: "claude", label: "Claude Desktop" },
  { id: "cursor", label: "Cursor" },
  { id: "terminal", label: "终端/CLI" },
] as const;

function getConfigJson(tab: string, tokenPlaceholder: string) {
  const base = {
    command: "npx",
    args: ["tsx", "/path/to/PRDTube/mcp/server.ts"],
    env: {
      PRDFLOW_BASE_URL: "http://localhost:3000",
      PRDFLOW_TOKEN: tokenPlaceholder,
    },
  };
  const serverBlock = JSON.stringify({ prdflow: base }, null, 2);
  switch (tab) {
    case "claude":
      return `// macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
// Windows: %APPDATA%\\Claude\\claude_desktop_config.json
{
  "mcpServers": ${serverBlock}
}`;
    case "cursor":
      return `// 项目根目录 .cursor/mcp.json
{
  "mcpServers": ${serverBlock}
}`;
    case "terminal":
      return `# 设置环境变量
export PRDFLOW_BASE_URL=http://localhost:3000
export PRDFLOW_TOKEN=${tokenPlaceholder}

# 启动 MCP Server
npx tsx /path/to/PRDTube/mcp/server.ts`;
    default:
      return "";
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "永不过期";
  return new Date(iso).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt) <= new Date();
}

export default function TokenManagementPage() {
  const user = useUser();
  const { data, mutate } = useSWR<ApiToken[]>("/api/tokens", (u: string) =>
    api<ApiToken[]>(u)
  );

  const [name, setName] = useState("");
  const [expiryDays, setExpiryDays] = useState<number>(30);
  const [newRawToken, setNewRawToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [guideTab, setGuideTab] = useState<string>("claude");
  const [guideOpen, setGuideOpen] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [copied, setCopied] = useState(false);

  const guideRef = useRef<HTMLDivElement>(null);

  const create = useCallback(async () => {
    if (!name.trim()) return;
    setBusy(true);
    const r = await api<
      ApiToken & { raw: string }
    >("/api/tokens", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        expires_in_days: expiryDays > 0 ? expiryDays : undefined,
      }),
    });
    setNewRawToken(r.raw);
    setShowTokenModal(true);
    setCopied(false);
    setName("");
    await mutate();
    setBusy(false);
  }, [name, expiryDays, mutate]);

  const hardDelete = useCallback(
    async (id: string) => {
      await api(`/api/tokens/${id}`, { method: "DELETE" });
      setDeleteConfirm(null);
      await mutate();
    },
    [mutate]
  );

  const copyToClipboard = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const scrollToGuide = useCallback(() => {
    guideRef.current?.scrollIntoView({ behavior: "smooth" });
    setGuideOpen(true);
  }, []);

  return (
    <PageContainer>
      {/* ===== 区块一：页面标题栏 ===== */}
      <PageHeader
        title="API Token"
        actions={
          <button
            type="button"
            onClick={scrollToGuide}
            className="flex items-center gap-1.5 rounded-[10px] border border-[#1111111a] px-4 py-2 text-[15.75px] font-medium text-[#374151] transition-colors hover:bg-[#F9FAFB]"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <circle cx="7" cy="7" r="5.5" />
              <path d="M7 5v3M7 10.5v.01" />
            </svg>
            查看 MCP 配置引导
          </button>
        }
      />

      {/* ===== 区块二：新建 Token 表单 ===== */}
      <section className="mt-[36px] rounded-[13px] border border-[#1111111a] bg-white p-6"> 
        <h3 className="mb-4 text-[18px] font-bold text-[#111111]">
          创建新 Token
        </h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <label className="mb-1.5 block text-[13px] font-medium text-[#374151]">
              名称
            </label>
            <input
              type="text"
              className="w-full rounded-lg border border-[#D1D5DB] bg-white px-3 py-2 text-[14px] text-[#111111] placeholder-[#9CA3AF] outline-none transition-colors focus:border-[#F97316] focus:ring-1 focus:ring-[#F97316]"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：my-cli-token"
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) create();
              }}
            />
          </div>
          <div className="w-[160px]">
            <label className="mb-1.5 block text-[13px] font-medium text-[#374151]">
              有效期
            </label>
            <select
              className="w-full rounded-lg border border-[#D1D5DB] bg-white px-3 py-2 text-[14px] text-[#111111] outline-none transition-colors focus:border-[#F97316] focus:ring-1 focus:ring-[#F97316]"
              value={expiryDays}
              onChange={(e) => setExpiryDays(Number(e.target.value))}
            >
              {EXPIRY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <Button
            onClick={create}
            disabled={busy || !name.trim()}
            className="h-[42px] bg-[#F97316] px-6 text-[14px] font-medium text-white hover:bg-[#EA580C]"
          >
            {busy ? "生成中…" : "生成 Token"}
          </Button>
        </div>

        {/* Token 生成弹窗 */}
        {showTokenModal && newRawToken && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
            <div className="w-[520px] rounded-xl bg-white shadow-xl">
              <div className="flex items-center justify-between border-b border-[#E5E7EB] px-6 py-4">
                <div className="flex items-center gap-2">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 18 18"
                    fill="none"
                    stroke="#F59E0B"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  >
                    <circle cx="9" cy="9" r="6.5" />
                    <path d="M9 5.5v4M9 12.5v.01" />
                  </svg>
                  <h3 className="text-[16px] font-semibold text-[#111111]">
                    Token 已生成
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setShowTokenModal(false)}
                  className="rounded-lg p-1.5 text-[#9CA3AF] transition-colors hover:bg-[#F3F4F6] hover:text-[#374151]"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              </div>
              <div className="px-6 py-5">
                <p className="text-[13px] text-[#6B7280]">
                  请立即复制并妥善保存此密钥，<strong className="text-[#DC2626]">关闭后将无法再次查看</strong>。
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <code className="flex-1 break-all rounded-lg border border-[#D1D5DB] bg-[#F9FAFB] px-3 py-2.5 text-[13px] text-[#111111] font-mono leading-relaxed">
                    {newRawToken}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(newRawToken)}
                    className={`flex h-[42px] w-[88px] shrink-0 items-center justify-center gap-1.5 rounded-lg border text-[13px] font-medium transition-all ${
                      copied
                        ? "border-[#10B981] bg-[#ECFDF5] text-[#059669]"
                        : "border-[#D1D5DB] bg-white text-[#374151] hover:bg-[#F9FAFB]"
                    }`}
                  >
                    {copied ? (
                      <>
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 7.5 6 10.5 11 4.5" />
                        </svg>
                        已复制
                      </>
                    ) : (
                      <>
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="4" y="4" width="7.5" height="7.5" rx="1.5" />
                          <path d="M2.5 10V3a1 1 0 011-1h5.5" />
                        </svg>
                        复制
                      </>
                    )}
                  </button>
                </div>
              </div>
              <div className="rounded-b-xl border-t border-[#E5E7EB] bg-[#F9FAFB] px-6 py-3">
                <div className="flex items-center justify-between">
                  <p className="text-[12px] text-[#F59E0B]">
                    确认已复制后再关闭此窗口
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowTokenModal(false)}
                    className="rounded-lg bg-[#F97316] px-4 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-[#EA580C]"
                  >
                    我已复制，关闭
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

      </section>

      {/* ===== 区块三：Token 列表 ===== */}
      <section className="mt-[18px] rounded-[13px] border border-[#1111111a] bg-white">
        <div className="border-b border-[#1111111a] px-6 py-4">
          <h3 className="text-[18px] font-bold text-[#111111]">
            Token 列表
          </h3>
        </div>
        {data && data.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <svg
              width="48"
              height="48"
              viewBox="0 0 48 48"
              fill="none"
              stroke="#D1D5DB"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <circle cx="24" cy="24" r="14" />
              <path d="M24 16v8M24 32v.01" />
            </svg>
            <p className="mt-4 text-[14px] text-[#9CA3AF]">
              暂无 Token，请在上方创建一个
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#1111111a] bg-[#F9FAFB] text-left text-[12px] font-medium uppercase text-[#6B7280]">
                  <th className="px-6 py-3">名称</th>
                  <th className="px-6 py-3">Key</th>
                  <th className="px-6 py-3">有效期</th>
                  <th className="px-6 py-3">创建时间</th>
                  <th className="px-6 py-3">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F3F4F6]">
                {data?.map((token) => {
                  const expired = isExpired(token.expires_at);
                  return (
                    <tr
                      key={token.id}
                      className={`text-[14px] transition-colors hover:bg-[#F9FAFB] ${
                        expired ? "opacity-50" : ""
                      }`}
                    >
                      <td className="px-6 py-3.5 font-medium text-[#111111]">
                        {token.name}
                        {expired && (
                          <span className="ml-2 inline-block rounded-full bg-[#FEE2E2] px-2 py-0.5 text-[11px] font-medium text-[#DC2626]">
                            已过期
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-3.5">
                        <code className="text-[13px] text-[#6B7280] font-mono">
                          {token.key_preview}
                        </code>
                      </td>
                      <td className="px-6 py-3.5 text-[#374151] whitespace-nowrap">
                        {formatDate(token.expires_at)}
                      </td>
                      <td className="px-6 py-3.5 text-[#6B7280] whitespace-nowrap">
                        {formatDate(token.created_at)}
                      </td>
                      <td className="px-6 py-3.5 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setDeleteConfirm(token.id)}
                          className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[#EF4444] transition-colors hover:bg-[#FEF2F2]"
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ===== 删除确认对话框 ===== */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-[400px] rounded-xl bg-white p-6 shadow-xl">
            <h3 className="text-[16px] font-semibold text-[#111111]">
              确认删除
            </h3>
            <p className="mt-2 text-[14px] text-[#6B7280]">
              此操作将永久删除该 Token，无法恢复。确定要继续吗？
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirm(null)}
                className="rounded-lg border border-[#D1D5DB] px-4 py-2 text-[13px] font-medium text-[#374151] transition-colors hover:bg-[#F9FAFB]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => hardDelete(deleteConfirm)}
                className="rounded-lg bg-[#EF4444] px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[#DC2626]"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 区块四：配置引导 ===== */}
      <section ref={guideRef} className="mt-[18px] rounded-[13px] border border-[#1111111a] bg-white">
        <button
          type="button"
          onClick={() => setGuideOpen(!guideOpen)}
          className="flex w-full items-center justify-between px-6 py-4 text-left"
        >
          <h3 className="text-[18px] font-bold text-[#111111]">
            如何在 AI 工具中配置 PAT
          </h3>
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            className={`text-[#6B7280] transition-transform ${guideOpen ? "rotate-180" : ""}`}
          >
            <path d="M4.5 6.75L9 11.25L13.5 6.75" />
          </svg>
        </button>
        {guideOpen && (
          <div className="border-t border-[#1111111a] px-6 pb-6">
            <p className="mt-4 text-[13px] text-[#6B7280]">
              创建 Token 后，将其配置到 MCP 客户端中，AI 工具即可读取 PRDTube
              的需求、调研、原型和 PRD 文档。
            </p>

            {/* Tab 切换 */}
            <div className="mt-4 flex gap-1 rounded-lg bg-[#F3F4F6] p-1">
              {MCP_GUIDE_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setGuideTab(tab.id)}
                  className={`flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                    guideTab === tab.id
                      ? "bg-white text-[#111111] shadow-sm"
                      : "text-[#6B7280] hover:text-[#374151]"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* 配置代码块 */}
            <div className="relative mt-3">
              <pre className="overflow-x-auto rounded-lg bg-[#1E1E1E] p-4 text-[13px] leading-relaxed text-[#D4D4D4]">
                <code>
                  {getConfigJson(guideTab, "YOUR_PAT_HERE")}
                </code>
              </pre>
              <button
                type="button"
                onClick={() =>
                  copyToClipboard(
                    getConfigJson(guideTab, "YOUR_PAT_HERE")
                  )
                }
                className="absolute right-3 top-3 flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1.5 text-[12px] text-white/80 transition-colors hover:bg-white/20"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1" />
                  <path d="M2 8.5V2.5A1 1 0 013 1.5h5" />
                </svg>
                复制
              </button>
            </div>

            {/* 环境变量说明 */}
            <div className="mt-4 rounded-lg border border-[#1111111a] bg-[#F9FAFB] p-4">
              <h4 className="text-[13px] font-medium text-[#111111]">
                环境变量说明
              </h4>
              <div className="mt-2 space-y-1.5 text-[13px] text-[#374151]">
                <p>
                  <code className="rounded bg-[#E5E7EB] px-1.5 py-0.5 text-[12px] font-mono text-[#111111]">
                    PRDFLOW_TOKEN
                  </code>
                  ：必填，你在上方创建的 PAT 令牌
                </p>
                <p>
                  <code className="rounded bg-[#E5E7EB] px-1.5 py-0.5 text-[12px] font-mono text-[#111111]">
                    PRDFLOW_BASE_URL
                  </code>
                  ：PRDTube 后端地址，本地默认为
                  <code className="rounded bg-[#E5E7EB] px-1.5 py-0.5 text-[12px] font-mono text-[#111111]">
                    http://localhost:3000
                  </code>
                </p>
              </div>
              <p className="mt-2 text-[12px] text-[#F59E0B]">
                提示：将代码块中的 YOUR_PAT_HERE 替换为你刚刚生成的 Token，将路径替换为实际的 MCP
                Server 路径。
              </p>
            </div>
          </div>
        )}
      </section>
    </PageContainer>
  );
}
