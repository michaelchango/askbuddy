"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useSWRConfig } from "swr";
import type { Project } from "@/types";

const projectSchema = z.object({
  name: z.string().trim().min(1, "请输入项目名称"),
  description: z.string().trim().min(1, "请输入项目简介"),
});

type ProjectFormValues = z.infer<typeof projectSchema>;

/**
 * 新建项目表单（仅字段 + 取消/提交按钮）。
 * 标题/副标题由调用方决定（页面态显示，引导页浮现态隐藏）。
 * 提交成功后调用 onSuccess，取消时调用 onCancel。
 */
export function ProjectNewForm({
  onCancel,
  onSuccess,
}: {
  onCancel: () => void;
  onSuccess: (project: Project) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const { mutate } = useSWRConfig();
  const {
    register,
    handleSubmit,
    formState: { errors, isValid },
  } = useForm<ProjectFormValues>({
    resolver: zodResolver(projectSchema),
    mode: "onChange",
    defaultValues: { name: "", description: "" },
  });

  const nameReg = register("name");

  async function onSubmit(values: ProjectFormValues) {
    setSaving(true);
    setNameError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: values.name, description: values.description }),
      });
      if (res.ok) {
        const created = (await res.json()).data as Project;
        onSuccess(created);
        // 刷新全局 /api/projects 缓存，使 DashboardShell 的左侧菜单立即显示
        mutate("/api/projects");
        return;
      }
      const d = await res.json().catch(() => ({}));
      if (d.error === "name_exists") {
        setNameError(d.message ?? "已存在同名项目，请更换项目名称");
      } else {
        setNameError("创建失败，请稍后重试");
      }
    } catch {
      setNameError("网络错误，请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="mt-[36px] max-w-[560px] w-full">
      <label className="block text-[15.75px] font-semibold text-[#111111]">
        项目名称<span className="ml-1 text-brand">*</span>
      </label>
      <input
        {...nameReg}
        onChange={(e) => {
          nameReg.onChange(e);
          if (nameError) setNameError(null);
        }}
        placeholder="请输入项目名称"
        className={
          "mt-[9px] h-[45px] w-full rounded-[13px] border bg-white px-[18px] text-[15.75px] text-[#111111] outline-none transition-colors placeholder:text-[#78746C] focus:border-brand " +
          (errors.name || nameError ? "border-brand" : "border-[#1111111a]")
        }
      />
      {errors.name && (
        <p className="mt-[6px] text-[12px] text-brand">{errors.name.message}</p>
      )}
      {nameError && (
        <p className="mt-[6px] text-[12px] text-brand">{nameError}</p>
      )}

      <label className="mt-[18px] block text-[15.75px] font-semibold text-[#111111]">
        项目简介<span className="ml-1 text-brand">*</span>
      </label>
      <textarea
        rows={4}
        {...register("description")}
        placeholder="简要描述项目目标、范围与价值"
        className={
          "mt-[9px] w-full resize-none rounded-[13px] border bg-white p-[18px] text-[15.75px] leading-relaxed text-[#111111] outline-none transition-colors placeholder:text-[#78746C] focus:border-brand " +
          (errors.description ? "border-brand" : "border-[#1111111a]")
        }
      />
      {errors.description && (
        <p className="mt-[6px] text-[12px] text-brand">{errors.description.message}</p>
      )}

      <div className="mt-[27px] flex gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="flex h-[45px] flex-1 items-center justify-center rounded-[13px] border border-[#1111111a] bg-white text-[15.75px] font-medium text-[#111111] transition-colors hover:bg-[#F2F0EB]"
        >
          取消
        </button>
        <button
          type="submit"
          disabled={saving || !isValid}
          className="flex h-[45px] flex-1 items-center justify-center rounded-[13px] bg-brand text-[15.75px] font-semibold text-white shadow-[0_4px_6px_-4px_rgba(246,102,18,0.3),0_10px_15px_-3px_rgba(246,102,18,0.3)] transition-colors hover:bg-brand/90 disabled:opacity-70"
        >
          {saving ? "创建中…" : "创建项目"}
        </button>
      </div>
    </form>
  );
}
