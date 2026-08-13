"use client";

import { useEffect, useRef } from "react";
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
  const ref = useRef<HTMLDialogElement>(null);

  // Sync the controlled `open` prop with the native dialog's modal state.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  // Native <dialog> already traps focus and handles Escape; we only need to
  // surface the cancel intent (Escape / backdrop dismiss) to the parent.
  const handleCancel = () => {
    // Guard against double-firing when close() is driven by the effect above.
    if (ref.current?.open) ref.current.close();
    onCancel();
  };

  return (
    <dialog
      ref={ref}
      closedby="any"
      aria-labelledby="confirm-dialog-title"
      className="m-0 max-w-[380px] rounded-[16px] border border-[#1111111a] bg-white p-[22px] shadow-[0_20px_60px_-12px_rgba(17,17,17,0.25)] backdrop:bg-black/30 backdrop:backdrop-blur-[1px]"
      // `closedby="any"` covers Escape + backdrop. For browsers without it
      // (e.g. Safari) the cancel event keeps the Escape-dismiss + parent sync.
      onCancel={(e) => {
        e.preventDefault();
        handleCancel();
      }}
    >
      <div className="flex items-start gap-[12px]">
        <span className="flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-full bg-[#FF64671a]">
          <AlertTriangle className="h-[18px] w-[18px] text-[#E5484D]" />
        </span>
        <div className="min-w-0 flex-1 pt-[2px]">
          <h3
            id="confirm-dialog-title"
            className="text-[15.75px] font-semibold text-[#111111]"
          >
            {title}
          </h3>
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
          onClick={handleCancel}
          className="h-[38px] rounded-[10px] border border-[#1111111a] bg-white px-[16px] text-[14px] font-medium text-[#111111] transition-colors hover:bg-[#F2F0EB]"
        >
          {cancelText}
        </button>
        <button
          type="button"
          onClick={() => {
            ref.current?.close();
            onConfirm();
          }}
          className="h-[38px] rounded-[10px] bg-[#E5484D] px-[16px] text-[14px] font-semibold text-white transition-colors hover:bg-[#cf3b40]"
        >
          {confirmText}
        </button>
      </div>
    </dialog>
  );
}
