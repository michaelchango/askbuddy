"use client";

import { useState } from "react";
import type { Requirement } from "@/types";

export interface LibraryFilterValues {
  requirementId: string;
}

interface LibraryFilterProps {
  requirements: Requirement[];
  onChange: (values: LibraryFilterValues) => void;
}

const DEFAULT: LibraryFilterValues = { requirementId: "" };

export function LibraryFilter({ requirements, onChange }: LibraryFilterProps) {
  const [values, setValues] = useState<LibraryFilterValues>(DEFAULT);

  function update(patch: Partial<LibraryFilterValues>) {
    const next = { ...values, ...patch };
    setValues(next);
    onChange(next);
  }

  function clear() {
    setValues(DEFAULT);
    onChange(DEFAULT);
  }

  const hasFilter = !!values.requirementId;

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* 需求下拉 */}
      <div className="flex items-center gap-1.5">
        <label className="text-[13px] font-medium text-[#78746C]">需求</label>
        <select
          value={values.requirementId}
          onChange={(e) => update({ requirementId: e.target.value })}
          className="h-[36px] min-w-[180px] rounded-[8px] border border-[#1111111a] bg-white px-[10px] text-[13px] text-[#111111] outline-none transition-colors focus:border-[#f66612]"
        >
          <option value="">全部需求</option>
          {requirements.map((r) => (
            <option key={r.id} value={r.id}>
              {r.title}
            </option>
          ))}
        </select>
      </div>

      {hasFilter && (
        <button
          type="button"
          onClick={clear}
          className="h-[36px] rounded-[8px] border border-[#1111111a] bg-white px-3 text-[13px] font-medium text-[#78746C] transition-colors hover:bg-[#F2F0EB] hover:text-[#111111]"
        >
          清除筛选
        </button>
      )}
    </div>
  );
}
