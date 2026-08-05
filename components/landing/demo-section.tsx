"use client";

import { useState } from "react";

const TABS = [
  {
    label: "对话完善需求",
    title: "对话完善需求",
    desc: "用 AI 对话，把一句想法变成完整需求卡片",
  },
  {
    label: "一键生成原型",
    title: "一键生成原型",
    desc: "描述需求，AI 自动产出可交互 HTML 原型",
  },
  {
    label: "PRD 自动生成",
    title: "PRD 自动生成",
    desc: "基于需求与原型，一键产出结构化 PRD",
  },
];

export function DemoSection() {
  const [active, setActive] = useState(0);
  const tab = TABS[active];

  return (
    <div>
      {/* 步骤切换 pills */}
      <div className="mx-auto flex w-fit flex-wrap justify-center gap-2">
        {TABS.map((t, i) => (
          <button
            key={t.label}
            type="button"
            onClick={() => setActive(i)}
            className={
              i === active
                ? "flex items-center gap-2 rounded-[13px] bg-[#f66612] px-4 py-2.5 text-[15.75px] font-medium text-white shadow-[0_4px_6px_-4px_rgba(246,102,18,0.2),0_10px_15px_-3px_rgba(246,102,18,0.2)]"
                : "flex items-center gap-2 rounded-[13px] border border-[#1111111a] bg-[#F9F8F5] px-4 py-2.5 text-[15.75px] font-medium text-[#78746C]"
            }
          >
            <span
              className={
                i === active
                  ? "flex h-[22px] w-[22px] items-center justify-center rounded-full bg-white/20 text-[10px] font-bold"
                  : "flex h-[22px] w-[22px] items-center justify-center rounded-full bg-[#F2F0EB] text-[10px] font-bold"
              }
            >
              {i + 1}
            </span>
            {t.label}
          </button>
        ))}
      </div>

      {/* 视频播放器占位 */}
      <div className="mx-auto mt-8 max-w-[1105px] overflow-hidden rounded-[18px] border border-[#1111111a] bg-white shadow-[0_1px_2px_-1px_rgba(0,0,0,0.1),0_1px_3px_rgba(0,0,0,0.1)]">
        {/* 浏览器栏 */}
        <div className="flex items-center gap-3 border-b border-[#1111111a] px-[22px] py-[14px]">
          <div className="flex gap-[6px]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/figma-pc/8.svg" alt="" className="h-[13.5px] w-[13.5px]" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/figma-pc/9.svg" alt="" className="h-[13.5px] w-[13.5px]" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/figma-pc/10.svg" alt="" className="h-[13.5px] w-[13.5px]" />
          </div>
          <div className="flex h-[27px] flex-1 items-center justify-center rounded-[9px] bg-[#F2F0EB] text-[13.5px] text-[#78746C]">
            产品演示 · 演示视频
          </div>
        </div>

        {/* 播放区 */}
        <div className="relative flex h-[280px] items-center justify-center bg-[#F2F0EB66] sm:h-[620px]">
          <div className="flex h-[72px] w-[72px] items-center justify-center rounded-full border border-[#f6661233] bg-[#f6661233]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/figma-pc/11.svg" alt="" className="h-[18px] w-[18px]" />
          </div>
          <div className="absolute bottom-[40px] text-center">
            <h3 className="text-[18px] font-semibold text-[#111111]">{tab.title}</h3>
            <p className="mt-1 text-[15.75px] text-[#78746C]">{tab.desc}</p>
            <div className="mx-auto mt-3 w-[177.74px] rounded-[4.5px] border border-[#1111110d] px-[14.65px] py-[6.89px] text-[13.5px] text-[#78746C99]">
              视频即将上线，敬请期待
            </div>
          </div>
        </div>

        {/* 进度条 */}
        <div className="flex items-center gap-3 border-t border-[#1111111a] px-[22px] py-[14px]">
          <div className="h-[4.49px] flex-1 rounded-full bg-[#F2F0EB]" />
          <span className="font-mono text-[13.5px] text-[#78746C]">0:00</span>
        </div>
      </div>

      {/* 分页圆点 */}
      <div className="mt-5 flex justify-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/figma-pc/12.svg" alt="" className="h-[9px] w-[9px]" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/figma-pc/13.svg" alt="" className="h-[9px] w-[9px]" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/figma-pc/13.svg" alt="" className="h-[9px] w-[9px]" />
      </div>
    </div>
  );
}
