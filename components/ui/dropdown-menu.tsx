"use client";

import { useState, type ReactNode } from "react";

/**
 * 统一的「…」下拉菜单规范组件。
 *
 * 设计要点（项目内所有同类菜单都应使用本组件，保持一致）：
 * - 触发按钮：28×28、rounded-[7px]，hover 时底色 #F2F0EB。
 * - 弹窗面板：rounded-[10px]、细边框、轻投影，外层 p-1 留出内边距。
 * - 菜单项：悬浮高亮为「内嵌圆角框」（左右留有边距），而非顶到底的整行背景；
 *   文字左对齐，图标与文字 gap-2。
 *
 * 之后新增任何「…」小菜单，直接复用本组件即可，无需再手写定位/样式。
 */

export interface DropdownMenuItemDef {
  label: string;
  icon?: ReactNode;
  /** 危险操作（如删除），文字与悬浮框使用红色调。 */
  danger?: boolean;
  /** 禁用态：灰显且点击不触发 onSelect（用于尚无内容时的导出项）。 */
  disabled?: boolean;
  onSelect: () => void;
}

export interface DropdownMenuProps {
  /** 触发按钮内的图标，如 <MoreHorizontal /> 或 <img src=... />。 */
  icon: ReactNode;
  items: DropdownMenuItemDef[];
  ariaLabel?: string;
  /** 面板宽度（px），默认 160。 */
  width?: number;
  /** 水平对齐方向，默认 right（贴齐触发按钮右缘，向左展开）。 */
  align?: "left" | "right";
  /**
   * 根容器额外类名。卡片场景需传入 "absolute right-[12px] top-[12px] z-30"
   * 以将菜单定位到卡片右上角；普通列表场景留空即可。
   */
  className?: string;
}

export function DropdownMenu({
  icon,
  items,
  ariaLabel = "更多操作",
  width = 160,
  align = "right",
  className = "",
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  // 根容器默认定位上下文为 relative；调用方传入 absolute 等定位类名时（如卡片
  // 右上角）直接采用，避免 "relative" 与 "absolute" 同时存在时后者被前者覆盖。
  const rootClassName = className || "relative";

  return (
    <div className={rootClassName}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          // 阻止事件冒泡/默认行为：当触发按钮位于可点击父元素
          // （如整行 <Link>）内部时，避免误触发父级导航。
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex h-[28px] w-[28px] items-center justify-center rounded-[7px] text-[#78746C] transition-colors hover:bg-[#F2F0EB] hover:text-[#111111]"
      >
        {icon}
      </button>

      {open && (
        <>
          {/* 点击空白处关闭 */}
          <div
            className="fixed inset-0 z-20"
            onClick={(e) => {
              // 阻止默认/冒泡：当菜单位于 <Link> 等可点击父元素内时，
              // 点击遮罩关闭的同时不可触发父级导航。
              e.preventDefault();
              e.stopPropagation();
              close();
            }}
            aria-hidden
          />
          <div
            role="menu"
            style={{ width }}
            className={`absolute z-30 overflow-hidden rounded-[10px] border border-[#1111111a] bg-white p-1 shadow-[0_8px_24px_rgba(0,0,0,0.12)] ${
              align === "right" ? "right-0" : "left-0"
            } top-[34px]`}
          >
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                onClick={(e) => {
                  // 阻止默认/冒泡：菜单项位于 <Link> 内时，点击菜单项
                  // 不应冒泡触发父级导航（如需求详情页）。
                  e.preventDefault();
                  e.stopPropagation();
                  if (it.disabled) return;
                  close();
                  it.onSelect();
                }}
                className={`flex w-full items-center gap-2 rounded-[6px] px-[10px] py-[8px] text-left text-[13.5px] font-medium transition-colors ${
                  it.disabled
                    ? "cursor-not-allowed text-slate-300"
                    : it.danger
                      ? "text-[#E5484D] hover:bg-[#F2F0EB]"
                      : "text-[#111111] hover:bg-[#F2F0EB]"
                }`}
              >
                {it.icon}
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
