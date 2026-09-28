"use client";

// 需求生命周期控件（M5-D1）：徽标 + 迁移按钮。
//
// 数据自含：SWR 拉 GET /api/requirements/{id}/lifecycle（当前态 + 可去哪 + 每条路的
// blockers 一次拿全）。被 block 的按钮【置灰但仍显示】+ tooltip 列出原因——
// 用户需要知道「为什么不能交付」，这比「按钮消失」有用得多。
// 迁移成功后：mutate 自身 + 全局 mutate shell 的 requirement SWR key，驱动整页刷新。

import { useState } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import {
  LIFECYCLE_LABELS,
  type RequirementLifecycle,
} from "@/lib/requirement-lifecycle";

interface GateBlocker {
  code: string;
  message: string;
  hint?: string;
  severity: "block" | "warn";
}

interface LifecycleData {
  lifecycle: RequirementLifecycle;
  available: RequirementLifecycle[];
  blockers: Partial<Record<RequirementLifecycle, GateBlocker[]>>;
}

const BADGE_STYLES: Record<RequirementLifecycle, string> = {
  created: "bg-[#F2F0EB] text-[#78746C]",
  dialoguing: "bg-[#3B82F61A] text-[#3B82F6]",
  designing: "bg-[#8B5CF61A] text-[#8B5CF6]",
  review: "bg-[#F59E0B1A] text-[#D97706]",
  completed: "bg-[#22C55E1A] text-[#16A34A]",
  archived: "bg-[#F2F0EB] text-[#A8A29E]",
};

/** available 里的目标态 → 按钮文案（人工决策动作）。 */
const ACTION_LABELS: Partial<Record<RequirementLifecycle, string>> = {
  review: "提交复核",
  completed: "通过并交付",
  designing: "打回修改",
  archived: "归档",
};

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const j = await res.json();
  return j.ok ? (j.data as LifecycleData) : null;
};

export function LifecycleControls({ requirementId }: { requirementId: string }) {
  const { data, mutate } = useSWR<LifecycleData | null>(
    "/api/requirements/" + requirementId + "/lifecycle",
    fetcher
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  if (!data) return null;

  async function transition(to: string, reason?: string) {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/requirements/" + requirementId + "/lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, reason }),
      });
      const j = await res.json();
      if (!j.ok) {
        const msgs = (j.data?.blockers as GateBlocker[] | undefined)
          ?.filter((b) => b.severity === "block")
          .map((b) => b.message);
        setErr(msgs?.join("；") || j.message || "操作失败");
        return;
      }
      await mutate();
      // 联动刷新 shell 的需求数据（其 SWR key 固定为该 URL）
      await globalMutate("/api/requirements/" + requirementId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onClick(to: RequirementLifecycle) {
    // 归档需确认（终态语义）
    if (to === "archived" && !confirm("确定归档该需求？归档后可从列表筛选中恢复。")) {
      return;
    }
    // 已交付需求手动返工：必须留 reason（审计要求，服务端强校验）
    if (data?.lifecycle === "completed" && to === "designing") {
      const reason = prompt("请说明返工原因（将记入状态审计）：");
      if (reason === null) return;
      await transition(to, reason);
      return;
    }
    await transition(to);
  }

  const isArchived = data.lifecycle === "archived";

  return (
    <div className="flex items-center gap-2">
      <span
        className={
          "flex h-9 items-center rounded-[9px] px-3 text-[13px] font-medium " +
          BADGE_STYLES[data.lifecycle]
        }
        title="需求生命周期"
      >
        {LIFECYCLE_LABELS[data.lifecycle]}
      </span>

      {isArchived ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => transition("restore")}
          className="flex h-9 items-center gap-1.5 rounded-[9px] px-3 text-[13.5px] font-medium text-[#78746C] transition-colors hover:bg-[#F2F0EB] disabled:opacity-50"
        >
          重新打开
        </button>
      ) : (
        data.available.map((to) => {
          const blockers = data.blockers[to] ?? [];
          const blocking = blockers.filter((b) => b.severity === "block");
          const warns = blockers.filter((b) => b.severity === "warn");
          const disabled = busy || blocking.length > 0;
          const title =
            blocking.length > 0
              ? "暂时无法" +
                (ACTION_LABELS[to] ?? "操作") +
                "：" +
                blocking.map((b) => b.message).join("；")
              : warns.length > 0
                ? "注意：" + warns.map((b) => b.message).join("；")
                : ACTION_LABELS[to];
          return (
            <button
              key={to}
              type="button"
              disabled={disabled}
              title={title}
              onClick={() => onClick(to)}
              className="flex h-9 items-center rounded-[9px] border border-[#E7E5E0] px-3 text-[13.5px] font-medium text-[#37352F] transition-colors hover:bg-[#F2F0EB] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {ACTION_LABELS[to] ?? to}
            </button>
          );
        })
      )}

      {err && (
        <span role="alert" className="text-[12.5px] text-[#DC2626]">
          {err}
        </span>
      )}
    </div>
  );
}
