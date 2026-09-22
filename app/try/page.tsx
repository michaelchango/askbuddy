"use client";

// 体验模式页（feat/try-mode-deploy 引入）：
//   - 老 /login 仍保留原登录/注册/邮箱/微信/协议弹窗的完整 UI（待正式 Auth 接入后启用）。
//   - 本页是临时"匿名轻量身份"入口：填昵称 → 写 askbuddy_session cookie → 进 dashboard。
//   - 数据按 cookie 中的昵称做 owner 隔离（projects.owner_id = nickname）。
//   - middleware（无 cookie 时）优先跳本页而非 /login。

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

const BULLETS = [
  { icon: "/figma-auth/2.svg", text: "AI 对话完善需求，告别反复拉会议" },
  { icon: "/figma-auth/3.svg", text: "一键生成可交互原型，快速验证想法" },
  { icon: "/figma-auth/4.svg", text: "MCP Server 直连 Cursor，无缝开发交接" },
];

const NICK_MAX_LEN = 20;

export default function TryPage() {
  const router = useRouter();
  const [nickname, setNickname] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function startTryMode(e: React.FormEvent) {
    e.preventDefault();
    const nick = nickname.trim().slice(0, NICK_MAX_LEN);
    if (!nick) {
      setError("请先填写昵称");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nickname: nick }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setError(body?.message ?? "昵称格式不正确，仅支持字母/数字/_/-/空格，长度 1-20");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-2">
      {/* ===== 左侧深色品牌面板 ===== */}
      <div className="hidden flex-col bg-[#1A1915] p-[54px] lg:flex">
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-orange.png" alt="AskBuddy" className="h-[44px] w-auto" />
          <span className="text-[28px] font-bold text-white">AskBuddy</span>
        </div>

        <div className="mt-[106px]">
          <h1 className="text-[40.5px] font-extrabold leading-[1.25]">
            <span className="text-white">AI 驱动的</span>
            <br />
            <span className="text-[#f66612]">产品工作流</span>
            <br />
            <span className="text-white">协作平台</span>
          </h1>
          <p className="mt-[18px] max-w-[656px] text-[18px] leading-relaxed text-[#9C9890]">
            从需求对话到 PRD 输出，全程 AI 协作，让每个想法高效落地。
          </p>

          <div className="mt-[40px] space-y-[18px]">
            {BULLETS.map((b) => (
              <div key={b.text} className="flex items-center gap-[13.5px]">
                <span className="flex h-[40.5px] w-[40.5px] shrink-0 items-center justify-center rounded-[13px] bg-[#f6661219]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={b.icon} alt="" className="h-[18px] w-[18px]" />
                </span>
                <span className="text-[15.75px] text-[#C8C4BC]">{b.text}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="mt-auto text-[13.5px] text-[#6B6B60]">
          © 2026 AskBuddy · 让产品工作更高效
        </p>
      </div>

      {/* ===== 右侧白色表单面板 ===== */}
      <div className="flex min-h-screen flex-col bg-white px-6 py-8 lg:min-h-0 lg:px-0">
        <div className="mx-auto flex w-full max-w-[432px] items-center justify-between">
          <Link href="/" className="flex items-center gap-2 lg:hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-orange.png" alt="AskBuddy" className="h-[40px] w-auto" />
            <span className="text-[22px] font-bold text-[#111111]">AskBuddy</span>
          </Link>
          <Link
            href="/"
            className="ml-auto flex items-center gap-1 text-[15.75px] font-medium text-[#78746C]"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/figma-auth/5.svg" alt="" className="h-4 w-4" />
            返回首页
          </Link>
        </div>

        <div className="mx-auto mt-10 w-full max-w-[432px] lg:mt-0 lg:flex lg:flex-1 lg:flex-col lg:justify-center">
          <h2 className="text-[27px] font-bold text-[#111111]">开始体验</h2>
          <p className="mt-[4.5px] text-[15.75px] text-[#78746C]">
            填一个昵称即进入演示，所有体验数据按昵称隔离
          </p>

          <form className="mt-[31.5px]" onSubmit={startTryMode}>
            <div className="mb-[27px]">
              <label
                htmlFor="nickname"
                className="mb-2 block text-[15.75px] font-medium text-[#111111]"
              >
                昵称
              </label>
              <input
                id="nickname"
                type="text"
                autoFocus
                autoComplete="off"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                maxLength={NICK_MAX_LEN}
                placeholder="例如：Alice / 产品小张"
                className={cn(
                  "h-[46.6px] w-full rounded-[13px] border bg-white px-[18.8px] text-[15.75px] text-[#111111]",
                  "border-[#1111111a] outline-none placeholder:text-[#78746C]",
                  "focus:border-[#f66612] focus:ring-2 focus:ring-[#f66612]/20"
                )}
              />
              <p className="mt-2 text-[13px] text-[#78746C]">
                仅支持字母/数字/_/-/空格，长度 1-20。Cookie 中保存 30 天。
              </p>
            </div>

            {error && (
              <p className="mb-3 text-[13.5px] text-[#f66612]">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className={cn(
                "flex h-[45px] w-full items-center justify-center rounded-[13px]",
                "bg-[#f66612] text-[15.75px] font-semibold text-white",
                "shadow-[0_4px_6px_-4px_rgba(246,102,18,0.3),0_10px_15px_-3px_rgba(246,102,18,0.3)]",
                "transition-colors hover:bg-[#D85A10] disabled:opacity-70"
              )}
            >
              {loading ? "处理中…" : "开始体验"}
            </button>
          </form>

          <p className="mt-[27px] text-[13px] leading-relaxed text-[#78746C]">
            清空浏览器
            <code className="mx-1 rounded bg-[#F2F0EB] px-1.5 py-0.5 text-[12px] text-[#111111]">
              askbuddy_session
            </code>
            Cookie 即可重填昵称。
          </p>

          {/* 老登录入口保留，正式 Auth 接入后启用 */}
          <p className="mt-4 text-[13px] text-[#78746C]">
            需要正式账号？
            <Link href="/login" className="ml-1 text-[#f66612]">
              登录 / 注册
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}