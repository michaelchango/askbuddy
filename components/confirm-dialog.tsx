"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = "删除",
  cancelText = "取消",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-[1px]"
        onClick={onCancel}
      />
      <div className="relative w-full max-w-[380px] rounded-[16px] border border-[#1111111a] bg-white p-[22px] shadow-[0_20px_60px_-12px_rgba(17,17,17,0.25)]">
        <div className="flex items-start gap-[12px]">
          <span className="flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-full bg-[#FF64671a]">
            <AlertTriangle className="h-[18px] w-[18px] text-[#E5484D]" />
          </span>
          <div className="min-w-0 flex-1 pt-[2px]">
            <h3 className="text-[15.75px] font-semibold text-[#111111]">{title}</h3>
            {description && (
              <p className="mt-[6px] text-[13.5px] leading-relaxed text-[#78746C]">
                {description}
              </p>
            )}
          </div>
        </div>
        <div className="mt-[20px] flex justify-end gap-[10px]">
          <button
            type="button"
            onClick={onCancel}
            className="h-[38px] rounded-[10px] border border-[#1111111a] bg-white px-[16px] text-[14px] font-medium text-[#111111] transition-colors hover:bg-[#F2F0EB]"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-[38px] rounded-[10px] bg-[#E5484D] px-[16px] text-[14px] font-semibold text-white transition-colors hover:bg-[#cf3b40]"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
