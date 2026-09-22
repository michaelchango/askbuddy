"use client";

import { useState } from "react";
import Link from "next/link";

// PC 顶部菜单项；移动端收进汉堡抽屉
const NAV = [
  { href: "#features", label: "功能" },
  { href: "#developers", label: "集成" },
  { href: "#cta", label: "定价" },
  { href: "#", label: "文档" },
];

export function SiteHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-[#1111111a] bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-[68px] max-w-[1159px] items-center px-5 sm:px-9">
        {/* Logo */}
        <a href="/" className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-orange.png" alt="AskBuddy" className="h-[44px] w-auto" />
          <span className="text-[28px] font-bold text-[#111111]">AskBuddy</span>
        </a>

        {/* PC 顶部菜单：紧贴 Logo（间距 54px）。设计稿相邻项左缘间距 72px，
            每项文字宽约 36px，故盒子间隙取 36px */}
        <nav className="ml-[54px] hidden items-center gap-[36px] lg:flex">
          {NAV.map((item) => (
            <a
              key={item.label}
              href={item.href}
              className="text-[18px] font-normal text-[#78746C] transition-colors hover:text-[#111111]"
            >
              {item.label}
            </a>
          ))}
        </nav>

        {/* 右侧：登录 + 免费开始 + 汉堡（PC 推到最右，间距 18px 对齐设计稿） */}
        <div className="ml-auto flex items-center gap-[18px]">
          <Link
            href="/login"
            className="text-[18px] font-medium text-[#78746C] transition-colors hover:text-[#111111]"
          >
            登录
          </Link>
          <Link
            href="/try"
            className="flex h-[38px] items-center rounded-[6px] bg-[#f66612] px-[18px] text-[18px] font-semibold text-white shadow-[0_4px_6px_-4px_rgba(246,102,18,0.25),0_10px_15px_-3px_rgba(246,102,18,0.25)] transition-colors hover:bg-[#D85A10]"
          >
            免费开始
          </Link>

          <button
            type="button"
            aria-label="打开菜单"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-[#F2F0EB] lg:hidden"
          >
            {open ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="#111111"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/figma-pc/32.svg" alt="" className="h-4 w-4" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/figma-pc/33.svg" alt="" className="h-4 w-4" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/figma-pc/34.svg" alt="" className="h-4 w-4" />
              </>
            )}
          </button>
        </div>
      </div>

      {/* 移动端抽屉菜单 */}
      {open && (
        <div className="border-t border-[#1111111a] bg-white lg:hidden">
          <nav className="mx-auto flex max-w-[1130px] flex-col px-5 py-2">
            {NAV.map((item) => (
              <a
                key={item.label}
                href={item.href}
                onClick={() => setOpen(false)}
                className="border-b border-[#1111110d] py-3 text-[16px] font-medium text-[#111111]"
              >
                {item.label}
              </a>
            ))}
            <div className="flex items-center gap-3 py-4">
              <Link
                href="/login"
                className="flex-1 rounded-[9px] border border-[#1111111a] py-2.5 text-center text-[15px] font-semibold text-[#111111]"
              >
                登录
              </Link>
              <Link
                href="/try"
                className="flex-1 rounded-[9px] bg-[#f66612] py-2.5 text-center text-[15px] font-semibold text-white"
              >
                免费开始
              </Link>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
