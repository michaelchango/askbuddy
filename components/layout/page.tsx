import type { ReactNode } from "react";

/**
 * 所有主内容区页面的统一外容器：固定相同的内边距，
 * 保证「左上角主标题」在控制台与项目内各页面位置完全一致。
 */
export function PageContainer({ children }: { children: ReactNode }) {
  return (
    <div className="px-9 pt-[18px] pb-9 font-[Plus_Jakarta_Sans]">
      {children}
    </div>
  );
}

/**
 * 统一的主标题区：标题永远左上角同一位置（首行、字号/字重一致），
 * subtitle 为可选副标题，actions 为右上角操作区（如按钮）。
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[27px] font-bold leading-[1.2] text-[#111111]">
          {title}
        </h1>
        {subtitle != null && (
          <p className="mt-[4.5px] max-w-[680px] text-[15.75px] leading-relaxed text-[#78746C]">
            {subtitle}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-[11.25px]">
          {actions}
        </div>
      )}
    </div>
  );
}
