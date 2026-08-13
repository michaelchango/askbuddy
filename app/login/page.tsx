"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

const BULLETS = [
  { icon: "/figma-auth/2.svg", text: "AI 对话完善需求，告别反复拉会议" },
  { icon: "/figma-auth/3.svg", text: "一键生成可交互原型，快速验证想法" },
  { icon: "/figma-auth/4.svg", text: "MCP Server 直连 Cursor，无缝开发交接" },
];

function LoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // 默认登录模式；仅当显式带 ?mode=register（如官网「免费注册」）时才进入注册模式
  const [mode, setMode] = useState<"login" | "register">(
    searchParams.get("mode") === "register" ? "register" : "login"
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [showAgreeModal, setShowAgreeModal] = useState(false);
  const agreeDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = agreeDialogRef.current;
    if (!el) return;
    if (showAgreeModal && !el.open) el.showModal();
    else if (!showAgreeModal && el.open) el.close();
  }, [showAgreeModal]);

  // 登录/注册：调用 /api/auth/* 写入会话并进入控制台
  async function enterConsole() {
    setLoading(true);
    try {
      await fetch("/api/auth/login", { method: "POST" });
      router.push("/dashboard");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "register" && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    if (mode === "register" && !agreed) {
      setShowAgreeModal(true);
      return;
    }
    setError("");
    enterConsole();
  }

  const isRegister = mode === "register";

  // 切换登录/注册时重置校验态，避免报错/勾选残留
  function switchMode(next: "login" | "register") {
    setMode(next);
    setError("");
    setConfirm("");
    setAgreed(false);
  }

  return (
    <>
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
          <h2 className="text-[27px] font-bold text-[#111111]">
            {isRegister ? "创建账号" : "欢迎回来"}
          </h2>
          <p className="mt-[4.5px] text-[15.75px] text-[#78746C]">
            {isRegister ? "免费开始使用 AskBuddy" : "登录以继续使用 AskBuddy"}
          </p>

          {/* 登录 / 注册 切换 */}
          <div className="mt-[31.5px] flex h-[49.5px] w-full rounded-[13px] bg-[#F2F0EB] p-[4.5px]">
            <button
              type="button"
              onClick={() => switchMode("login")}
              className={cn(
                "flex-1 rounded-[9px] text-[15.75px] font-medium transition-colors",
                !isRegister
                  ? "bg-white text-[#111111] shadow-[0_1px_2px_-1px_rgba(0,0,0,0.1),0_1px_3px_rgba(0,0,0,0.1)]"
                  : "text-[#78746C]"
              )}
            >
              登录
            </button>
            <button
              type="button"
              onClick={() => switchMode("register")}
              className={cn(
                "flex-1 rounded-[9px] text-[15.75px] font-medium transition-colors",
                isRegister
                  ? "bg-white text-[#111111] shadow-[0_1px_2px_-1px_rgba(0,0,0,0.1),0_1px_3px_rgba(0,0,0,0.1)]"
                  : "text-[#78746C]"
              )}
            >
              注册
            </button>
          </div>

          <form className="mt-[27px]" onSubmit={handleSubmit}>
            <div className="mb-[27px]">
              <label className="mb-2 block text-[15.75px] font-medium text-[#111111]">
                邮箱
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="h-[46.6px] w-full rounded-[13px] border border-[#1111111a] bg-white px-[18.8px] text-[15.75px] text-[#111111] outline-none placeholder:text-[#78746C] focus:border-[#f66612] focus:ring-2 focus:ring-[#f66612]/20"
              />
            </div>

            <div className="mb-[27px]">
              <label className="mb-2 block text-[15.75px] font-medium text-[#111111]">
                密码
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
                className="h-[46.6px] w-full rounded-[13px] border border-[#1111111a] bg-white px-[18.8px] text-[15.75px] text-[#111111] outline-none placeholder:text-[#78746C] focus:border-[#f66612] focus:ring-2 focus:ring-[#f66612]/20"
              />
            </div>

            {isRegister && (
              <div className="mb-[27px]">
                <label className="mb-2 block text-[15.75px] font-medium text-[#111111]">
                  确认密码
                </label>
                <input
                  type="password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="请再次输入密码"
                  className="h-[46.6px] w-full rounded-[13px] border border-[#1111111a] bg-white px-[18.8px] text-[15.75px] text-[#111111] outline-none placeholder:text-[#78746C] focus:border-[#f66612] focus:ring-2 focus:ring-[#f66612]/20"
                />
              </div>
            )}

            {isRegister && (
              <label className="mb-[18px] flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[#f66612]"
                />
                <span className="text-[13.5px] leading-relaxed text-[#78746C]">
                  我已阅读并同意
                  <Link href="#" className="text-[#f66612]">《用户协议》</Link>
                  和
                  <Link href="#" className="text-[#f66612]">《隐私政策》</Link>
                </span>
              </label>
            )}

            {error && <p className="mb-3 text-[13.5px] text-[#f66612]">{error}</p>}

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={loading}
                className="flex h-[45px] flex-1 items-center justify-center rounded-[13px] bg-[#f66612] text-[15.75px] font-semibold text-white shadow-[0_4px_6px_-4px_rgba(246,102,18,0.3),0_10px_15px_-3px_rgba(246,102,18,0.3)] transition-colors hover:bg-[#D85A10] disabled:opacity-70"
              >
                {loading ? "处理中…" : isRegister ? "注册并开始" : "登录"}
              </button>
              <button
                type="button"
                onClick={enterConsole}
                className="flex h-[45px] flex-1 items-center justify-center gap-2 rounded-[13px] bg-[#07C160] text-[15.75px] font-semibold text-white shadow-[0_4px_6px_-4px_rgba(7,193,96,0.3),0_10px_15px_-3px_rgba(7,193,96,0.3)] transition-colors hover:bg-[#06ad56]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/figma-auth/6.svg" alt="" className="h-[18px] w-[18px]" />
                微信登录
              </button>
            </div>
          </form>

          <p className="mt-[27px] text-center text-[13.5px] text-[#78746C]">
            {isRegister ? "已有账号？ " : "没有账号？ "}
            <button
              type="button"
              onClick={() => switchMode(isRegister ? "login" : "register")}
              className="text-[13.5px] font-medium text-[#f66612]"
            >
              {isRegister ? "去登录" : "去注册"}
            </button>
          </p>
        </div>
      </div>
    </div>

    <dialog
      ref={agreeDialogRef}
      closedby="any"
      aria-labelledby="agree-modal-title"
      className="m-0 max-w-[380px] rounded-[16px] bg-white p-6 shadow-xl backdrop:bg-black/40"
      onCancel={(e) => {
        e.preventDefault();
        setShowAgreeModal(false);
      }}
    >
      <h3
        id="agree-modal-title"
        className="text-[18px] font-bold text-[#111111]"
      >
        温馨提示
      </h3>
      <p className="mt-3 text-[14.4px] leading-relaxed text-[#78746C]">
        请阅读并同意《用户协议》和《隐私政策》后注册。是否确认继续？
      </p>
      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={() => setShowAgreeModal(false)}
          className="rounded-[9px] border border-[#1111111a] px-4 py-2 text-[14.4px] font-medium text-[#111111]"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => {
            setShowAgreeModal(false);
            enterConsole();
          }}
          className="rounded-[9px] bg-[#f66612] px-4 py-2 text-[14.4px] font-semibold text-white hover:bg-[#D85A10]"
        >
          确认
        </button>
      </div>
    </dialog>
    </>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
