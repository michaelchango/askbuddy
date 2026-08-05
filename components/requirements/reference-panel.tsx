"use client";

import { useState } from "react";
import { Plus, Check } from "lucide-react";
import type { OutputMeta, OutputType } from "@/lib/services/outputs";
import { cn } from "@/lib/utils";

export interface PickedReference {
  type: OutputType;
  label: string;
  version: number;
}

// 引用上下文面板：列出已生成的输出物，可切换版本后引用。
export function ReferencePanel({
  outputs,
  picked,
  onPick,
  onRemove,
}: {
  outputs: OutputMeta[]; // 仅已生成的
  picked: PickedReference[];
  onPick: (ref: PickedReference) => void;
  onRemove: (type: OutputType) => void;
}) {
  const [ver, setVer] = useState<Record<string, number>>(
    Object.fromEntries(outputs.map((o) => [o.type, o.version ?? 1]))
  );

  return (
    <div className="absolute bottom-full left-0 z-30 mb-2 w-[190px] rounded-xl border border-slate-200 bg-white p-2 shadow-lg">
      <div className="max-h-[260px] space-y-1 overflow-auto">
        {outputs.length === 0 && (
          <div className="px-2 py-3 text-center text-[13px] text-slate-400">暂无可引用的输出物</div>
        )}
        {outputs.map((o) => {
          const added = picked.some((p) => p.type === o.type);
          const curVer = ver[o.type] ?? o.version ?? 1;
          return (
            <div
              key={o.type}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50"
            >
              <span className="flex-1 text-[13.5px] text-slate-700">{o.label}</span>
              {o.version && o.version > 1 ? (
                <select
                  value={curVer}
                  onChange={(e) => setVer((s) => ({ ...s, [o.type]: Number(e.target.value) }))}
                  className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[11px] text-slate-600"
                >
                  {Array.from({ length: o.version }, (_, i) => o.version! - i).map((v) => (
                    <option key={v} value={v}>
                      v{v}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="font-mono text-[10px] text-slate-400">v{curVer}</span>
              )}
              <button
                onClick={() =>
                  added
                    ? onRemove(o.type)
                    : onPick({ type: o.type, label: o.label, version: curVer })
                }
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-md",
                  added ? "bg-[#f66612] text-white" : "border border-slate-200 text-slate-500 hover:bg-slate-100"
                )}
              >
                {added ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
