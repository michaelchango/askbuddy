import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800", "900"],
  display: "swap",
  variable: "--font-plus-jakarta",
});

export const metadata: Metadata = {
  title: "AskBuddy — AI 驱动产品工作流协同平台",
  description:
    "从对话完善需求，到调研、分析、原型生成、PRD 输出，全程 AI 协作。所有产物可直接被 AI 编码工具消费。",
  icons: {
    icon: "/logo-orange-nomargin.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className={plusJakartaSans.variable}>
      <body>{children}</body>
    </html>
  );
}
