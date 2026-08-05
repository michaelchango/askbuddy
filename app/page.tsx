import Link from "next/link";
import { SiteHeader } from "@/components/landing/site-header";
import { DemoSection } from "@/components/landing/demo-section";

function SectionLabel({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={`flex items-center justify-center gap-2 ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/figma-pc/1.svg" alt="" className="h-[18px] w-[18px]" />
      <span className="text-[13.5px] font-bold tracking-[2.7px] text-[#f66612]">
        {text}
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/figma-pc/1.svg" alt="" className="h-[18px] w-[18px]" />
    </div>
  );
}

const FEATURES = [
  {
    icon: "/figma-pc/2.svg",
    title: "对话式需求完善",
    desc: "AI 引导式访谈，将一句话描述丰富为结构化需求卡片，对话上下文持久保存，随时补充修正。",
  },
  {
    icon: "/figma-pc/3.svg",
    title: "智能调研分析",
    desc: "联网搜索竞品方案，自动抽取关键信息并标注来源，生成完整调研报告，支持一键重新生成。",
  },
  {
    icon: "/figma-pc/4.svg",
    title: "原型一键生成",
    desc: "基于需求与方案自动生成可交互 HTML 原型，支持对话式修改、多页面跳转与版本快照管理。",
  },
  {
    icon: "/figma-pc/5.svg",
    title: "PRD 自动输出",
    desc: "一键生成结构化 Markdown PRD，支持导出 Word，内容与原型版本关联，变更时自动提示。",
  },
  {
    icon: "/figma-pc/6.svg",
    title: "MCP Server 集成",
    desc: "标准 MCP 协议暴露需求、原型、PRD 资源，供 Cursor / Claude Code 等 AI 工具直接消费。",
  },
  {
    icon: "/figma-pc/7.svg",
    title: "版本血缘追溯",
    desc: "所有产出物版本快照，可对比回退。上游需求变更时自动标记下游产物可能过期，一键重新生成。",
  },
];

const HERO_ICONS = [
  { icon: "/figma-pc/25.svg", label: "对话完善", sub: "AI 引导访谈", tint: "#51A2FF" },
  { icon: "/figma-pc/27.svg", label: "调研分析", sub: "联网搜索摘要", tint: "#A684FF" },
  { icon: "/figma-pc/29.svg", label: "方案设计", sub: "用户故事 + 功能", tint: "#FFB900" },
  { icon: "/figma-pc/31.svg", label: "原型生成", sub: "可交互 HTML 原型", tint: "#FF8904" },
  { icon: "/figma-pc/33.svg", label: "PRD 输出", sub: "结构化文档 + 导出", tint: "#00D492" },
  { icon: "/figma-pc/35.svg", label: "MCP 调用", sub: "AI 工具直接消费", tint: "#00D3F3" },
];

// 注意：此处只列**已实现**的能力，未上线的必须显式标注「即将上线」，
// 不得出现无对应实现的功能项（M0 已下线虚构的 CLI 宣传）。
const DEV_FEATURES = [
  { icon: "/figma-pc/17.svg", text: "标准 MCP 协议，stdio 直连，开箱即用" },
  { icon: "/figma-pc/17.svg", text: "4 个工具：需求 / 调研 / 原型 / PRD" },
  { icon: "/figma-pc/17.svg", text: "API Token（PAT）管理，随时创建与撤销" },
  { icon: "/figma-pc/17.svg", text: "Webhook 通知外部系统（即将上线）" },
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white font-sans text-[#111111]">
      <SiteHeader />

      <main>
        {/* ===== Hero ===== */}
        <section className="relative overflow-hidden">
          <div className="pointer-events-none absolute left-1/2 top-0 h-[400px] w-[800px] -translate-x-1/2 rounded-full bg-[#f66612]/10 blur-[120px]" />
          <div className="pointer-events-none absolute left-1/2 top-36 h-[200px] w-[300px] -translate-x-1/2 rounded-full bg-[#FFB900]/10 blur-[80px]" />

          <div className="relative mx-auto max-w-[1130px] px-5 pb-20 pt-16 text-center sm:px-7">
            <h1 className="text-[40px] font-extrabold leading-[1.1] sm:text-[56px] lg:text-[81px]">
              <span className="text-[#111111]">AI 驱动的</span>
              <br />
              <span className="text-[#f66612]">产品工作流</span>
              <span className="text-[#111111]">平台</span>
            </h1>
            <p className="mx-auto mt-6 max-w-[756px] text-[16px] leading-relaxed text-[#78746C] sm:text-[18px] lg:text-[22.5px]">
              从对话完善需求，到调研、分析、原型生成、PRD 输出，全程 AI 协作。
              <br className="hidden sm:block" />
              所有产物可直接被 AI 编码工具消费。
            </p>

            <div className="mt-9 flex justify-center">
              <Link
                href="/login?mode=register"
                className="flex items-center rounded-[13px] bg-[#f66612] px-7 py-3.5 text-[18px] font-semibold text-white shadow-[0_4px_6px_-4px_rgba(246,102,18,0.25),0_10px_15px_-3px_rgba(246,102,18,0.25)] transition-colors hover:bg-[#D85A10]"
              >
                免费开始使用
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/figma-pc/24.svg" alt="" className="ml-2 inline h-4 w-4" />
              </Link>
            </div>

            {/* 六步能力：移动端网格 / PC 水平流水线（带箭头） */}
            <div className="mx-auto mt-16 grid max-w-[1130px] grid-cols-3 gap-x-3 gap-y-10 lg:flex lg:flex-nowrap lg:items-start lg:justify-center">
              {HERO_ICONS.flatMap((item, i) => [
                <div
                  key={`item-${i}`}
                  className="flex flex-col items-center text-center lg:w-[150px]"
                >
                  <span
                    className="flex h-[65px] w-[65px] items-center justify-center rounded-[18px] border"
                    style={{
                      backgroundColor: `${item.tint}1a`,
                      borderColor: `${item.tint}33`,
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.icon} alt="" className="h-[32px] w-[32px]" />
                  </span>
                  <p className="mt-4 text-[15.75px] font-bold text-[#111111]">{item.label}</p>
                  <p className="mt-1 text-[13.5px] text-[#78746C]">{item.sub}</p>
                </div>,
                i < HERO_ICONS.length - 1 ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={`arrow-${i}`}
                    src="/figma-pc/34.svg"
                    alt=""
                    className="hidden h-4 w-4 lg:mt-8 lg:block lg:mx-1 lg:w-6"
                  />
                ) : null,
              ])}
            </div>
          </div>
        </section>

        {/* ===== 功能特性 ===== */}
        <section id="features" className="scroll-mt-20 border-t border-[#1111111a] py-16 lg:py-24">
          <div className="mx-auto max-w-[1130px] px-5 sm:px-7">
            <SectionLabel text="功能特性" />
            <h2 className="relative mt-3 text-center text-[32px] font-black leading-tight sm:text-[40.5px] lg:text-[54px]">
              覆盖产品经理
              <br />
              <span className="relative inline-block">
                每一个核心环节
                <span className="absolute -bottom-0.5 left-0 h-[13.5px] w-full rounded-[4.5px] bg-[#f6661226]" />
              </span>
            </h2>

            <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <div
                  key={f.title}
                  className="rounded-[18px] border border-[#1111111a] bg-white p-7"
                >
                  <span className="flex h-[45px] w-[45px] items-center justify-center rounded-[13px] bg-[#f66612]/10">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={f.icon} alt="" className="h-6 w-6" />
                  </span>
                  <h3 className="mt-5 text-[18px] font-semibold text-[#111111]">{f.title}</h3>
                  <p className="mt-3 text-[15.75px] leading-relaxed text-[#78746C]">{f.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ===== 产品演示 ===== */}
        <section id="demo" className="scroll-mt-20 border-t border-[#1111111a] py-16 lg:py-24">
          <div className="mx-auto max-w-[1130px] px-5 sm:px-7">
            <SectionLabel text="产品演示" />
            <h2 className="mt-3 text-center text-[32px] font-black sm:text-[40.5px] lg:text-[54px]">
              <span className="font-light text-[#78746C]">看看它</span>
              <span className="font-black text-[#111111]">怎么工作</span>
              <span className="font-light text-[#78746C]">的</span>
            </h2>

            <div className="mt-10">
              <DemoSection />
            </div>
          </div>
        </section>

        {/* ===== 开发者集成（PC 左右两栏） ===== */}
        <section
          id="developers"
          className="scroll-mt-20 border-t border-[#1111111a] py-16 lg:py-24"
        >
          <div className="mx-auto max-w-[1130px] px-5 sm:px-7">
            <div className="lg:flex lg:items-start lg:gap-10">
              {/* 左栏：文案 + 能力清单 */}
              <div className="lg:w-[521px]">
                <SectionLabel text="开发者集成" className="lg:justify-start" />
                <h2 className="mt-3 text-center text-[32px] font-black leading-tight sm:text-[40.5px] lg:text-left lg:text-[54px]">
                  让 AI 工具
                  <br />
                  <span className="relative inline-block">
                    直接读取需求
                    <span className="absolute -bottom-0.5 left-0 h-[13.5px] w-full rounded-[4.5px] bg-[#f6661226]" />
                  </span>
                </h2>
                <p className="mx-auto mt-6 max-w-[522px] text-center text-[18px] leading-relaxed text-[#78746C] lg:text-left">
                  内置 MCP Server，Cursor、Claude Code 等 AI 编程助手可以直接拉取需求卡片、原型结构和
                  PRD，无需手动复制粘贴。
                </p>

                <div className="mx-auto mt-10 max-w-[522px] space-y-3 lg:mx-0">
                  {DEV_FEATURES.map((d) => (
                    <div key={d.text} className="flex items-center gap-3">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={d.icon} alt="" className="h-5 w-5 shrink-0" />
                      <span className="text-[15.75px] text-[#78746C]">{d.text}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* 右栏：终端卡片 */}
              <div className="mt-10 lg:mt-0 lg:w-[521px]">
                <div className="overflow-hidden rounded-[18px] border border-white/10 bg-[#1A1915]">
                  <div className="flex items-center gap-2 px-6 py-4">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/figma-pc/19.svg" alt="" className="h-[18px] w-[18px]" />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/figma-pc/20.svg" alt="" className="h-[18px] w-[18px]" />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/figma-pc/21.svg" alt="" className="h-[18px] w-[18px]" />
                    <span className="ml-2 font-mono text-[13.5px] text-[#9C9890]">
                      .cursor/mcp.json
                    </span>
                  </div>
                  {/* 以下为真实可用的 MCP 接入配置，与 docs/mcp-guide.md 保持一致。 */}
                  <pre className="overflow-x-auto px-6 pb-6 font-mono text-[13.5px] leading-6">
                    <span className="text-[#6B6B60]">
                      {"# Cursor / Claude Desktop 均使用同一份配置"}
                    </span>
                    {"\n"}
                    <span className="text-[#FFB900]">{"{"}</span>
                    {"\n"}
                    <span className="text-[#FFB900]">{'  "mcpServers": {'}</span>
                    {"\n"}
                    <span className="text-[#FFB900]">{'    "askbuddy": {'}</span>
                    {"\n"}
                    <span className="text-[#00D3F3]">{'      "command": "npx",'}</span>
                    {"\n"}
                    <span className="text-[#00D3F3]">
                      {'      "args": ["tsx", "<AskBuddy 仓库>/mcp/server.ts"],'}
                    </span>
                    {"\n"}
                    <span className="text-[#00D3F3]">{'      "env": {'}</span>
                    {"\n"}
                    <span className="text-[#00D492]">
                      {'        "ASKBUDDY_BASE_URL": "http://localhost:3000",'}
                    </span>
                    {"\n"}
                    <span className="text-[#00D492]">
                      {'        "ASKBUDDY_TOKEN": "<你的 PAT>"'}
                    </span>
                    {"\n"}
                    <span className="text-[#00D3F3]">{"      }"}</span>
                    {"\n"}
                    <span className="text-[#FFB900]">{"    }"}</span>
                    {"\n"}
                    <span className="text-[#FFB900]">{"  }"}</span>
                    {"\n"}
                    <span className="text-[#FFB900]">{"}"}</span>
                    {"\n\n"}
                    <span className="text-[#6B6B60]">{"# 连接后可调用 4 个工具"}</span>
                    {"\n"}
                    <span className="text-[#9C9890]">
                      {"# requirement_get / research / prototype / prd"}
                    </span>
                  </pre>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ===== 开始使用 CTA ===== */}
        <section
          id="cta"
          className="relative overflow-hidden border-t border-[#1111111a] py-20 lg:py-24"
        >
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-[300px] w-[700px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#f66612]/10 blur-[100px]" />
          <div className="pointer-events-none absolute right-0 top-0 h-[200px] w-[400px] rounded-full bg-[#FFB900]/10 blur-[80px]" />

          <div className="relative mx-auto max-w-[756px] px-5 text-center">
            <SectionLabel text="开始使用" />
            <h2 className="mt-4 text-[30px] font-black leading-tight sm:text-[40.5px] lg:text-[54px]">
              告别割裂的工具链
              <br />
              让每个想法<span className="text-[#f66612]">高效落地</span>
            </h2>
            <p className="mx-auto mt-6 max-w-[756px] text-[18px] leading-relaxed text-[#78746C] sm:text-[20.25px]">
              需求、原型、文档一气呵成，全程 AI 协作，从想法到开发就绪。
            </p>

            <div className="mt-10 flex justify-center">
              <Link
                href="/login?mode=register"
                className="flex items-center rounded-[13px] bg-[#f66612] px-9 py-4 text-[20.25px] font-semibold text-white shadow-[0_4px_6px_-4px_rgba(246,102,18,0.3),0_10px_15px_-3px_rgba(246,102,18,0.3)] transition-colors hover:bg-[#D85A10]"
              >
                免费注册
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/figma-pc/22.svg" alt="" className="ml-2 inline h-5 w-5" />
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* ===== Footer ===== */}
      <footer className="border-t border-[#1111111a] py-9">
        <div className="mx-auto flex max-w-[1130px] flex-col items-center gap-4 px-5 sm:flex-row sm:justify-between sm:px-7">
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-orange.png" alt="AskBuddy" className="h-[28px] w-auto" />
            <span className="text-[15.75px] font-bold text-[#111111]">AskBuddy</span>
            <span className="text-[15.75px] text-[#78746C]">© 2026</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[15.75px] text-[#78746C]">
            <a href="#" className="hover:text-[#111111]">隐私政策</a>
            <a href="#" className="hover:text-[#111111]">服务条款</a>
            <a href="#" className="hover:text-[#111111]">联系我们</a>
            <a href="#" className="hover:text-[#111111]">文档</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
