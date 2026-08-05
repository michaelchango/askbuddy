"use client";

const FIELDS: { key: string; label: string; placeholder: string }[] = [
  { key: "background", label: "背景", placeholder: "需求产生的背景与目标…" },
  { key: "targetUsers", label: "目标用户", placeholder: "谁会使用这个功能？" },
  { key: "painPoints", label: "核心痛点", placeholder: "用户最痛的问题是什么？" },
  { key: "scope", label: "功能范围", placeholder: "第一版包含哪些功能？" },
  { key: "nonFunctional", label: "非功能需求", placeholder: "性能 / 安全 / 合规等" },
  { key: "constraints", label: "约束", placeholder: "技术栈 / 时间 / 资源约束" },
];

// 结构化需求卡片预览 / 编辑：随对话实时填充，可内联修正。
export function RequirementCardPreview({
  card,
  onChange,
}: {
  card: Record<string, string>;
  onChange?: (card: Record<string, string>) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">需求卡片</h2>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
          对话中 · 自动抽取
        </span>
      </div>

      {FIELDS.map((f) => {
        const val = card[f.key] ?? "";
        const filled = val.trim().length > 0 && !val.startsWith("（");
        return (
          <div
            key={f.key}
            className="rounded-lg border border-slate-200 bg-white p-3 transition-all duration-200 hover:border-[#f6661255] hover:shadow-sm"
          >
            <label className="mb-1 block text-xs font-medium text-slate-500">
              {f.label}
            </label>
            <textarea
              className="w-full resize-none bg-transparent text-sm leading-relaxed text-slate-800 outline-none"
              rows={val ? Math.min(4, Math.max(2, Math.ceil(val.length / 22))) : 1}
              value={val}
              placeholder={f.placeholder}
              onChange={(e) => onChange?.({ ...card, [f.key]: e.target.value })}
            />
            {!filled && (
              <span className="text-[11px] text-slate-400">AI 采集中…</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
