import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getProject } from "@/lib/services/projects";
import {
  listRequirements,
  listRequirementsForOwner,
  countRequirements,
  countRequirementsForOwner,
  createRequirement,
} from "@/lib/services/requirements";

/** 每页条数上限，防止 pageSize 被放大成全表扫描。 */
const MAX_PAGE_SIZE = 100;

/**
 * 解析分页参数。三个参数都不传时返回 null —— 调用方据此保持「返回全量」的历史行为，
 * 这样既有调用方（多数页面仍一次取全部）不受本次改动影响。
 *
 * 背景：概览页 / 项目列表页 / 项目需求列表页原本都是一次拉全量需求再前端切片，
 * 数据量随使用线性增长；而生产环境前端部署在海外、数据库在境内，
 * 每次跨网关 SQL 往返约 1.7s，无上限的全量拉取会越来越慢。
 */
function parsePaging(sp: URLSearchParams): { page: number; pageSize: number; offset: number } | null {
  const limitParam = sp.get("limit");
  const pageParam = sp.get("page");
  const pageSizeParam = sp.get("pageSize");
  if (limitParam == null && pageParam == null && pageSizeParam == null) return null;

  const pageSize = Math.min(
    Math.max(Number(pageSizeParam ?? limitParam ?? 20) || 20, 1),
    MAX_PAGE_SIZE
  );
  const page = Math.max(Number(pageParam ?? 1) || 1, 1);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** 分页响应的公共字段：data 仍是数组，老 fetcher（d.ok ? d.data : []）不受影响。 */
function paged(data: unknown[], total: number, page: number, pageSize: number) {
  return {
    ok: true as const,
    data,
    total,
    page,
    pageSize,
    totalPages: Math.max(Math.ceil(total / pageSize), 1),
  };
}

export async function GET(req: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const projectId = req.nextUrl.searchParams.get("projectId");
  const paging = parsePaging(req.nextUrl.searchParams);

  if (projectId) {
    // 体验模式安全：先校验 projectId 归属当前 user，否则被人塞个别人 projectId 也能读
    const project = await getProject(projectId);
    if (!project || project.ownerId !== user.uid) {
      return NextResponse.json({ ok: false, error: "project_not_found" }, { status: 404 });
    }
    // listRequirements 已按 updatedAt DESC 排序（idx_req_project 索引下推），
    // route 层不再做内存 sort，避免无意义的 CPU 浪费。
    if (!paging) {
      const data = await listRequirements(projectId);
      return NextResponse.json({ ok: true, data });
    }
    const [data, total] = await Promise.all([
      listRequirements(projectId, { limit: paging.pageSize, offset: paging.offset }),
      countRequirements(projectId),
    ]);
    return NextResponse.json(
      paged(data, total, paging.page, paging.pageSize)
    );
  }

  // 跨项目列表（概览页「最近需求」）。
  if (!paging) {
    const data = await listRequirementsForOwner(user.uid);
    return NextResponse.json({ ok: true, data });
  }

  // 先取项目（进程内缓存），再并行拿当页数据与总数，
  // 两次调用内部的 listProjects 共用同一份缓存，只真正查一次。
  const [data, total] = await Promise.all([
    listRequirementsForOwner(user.uid, { limit: paging.pageSize, offset: paging.offset }),
    countRequirementsForOwner(user.uid),
  ]);
  return NextResponse.json(paged(data, total, paging.page, paging.pageSize));
}

export async function POST(req: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  const projectId = body?.projectId;
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "projectId required" }, { status: 400 });
  }
  // 体验模式安全修复：防止别人塞个别人的 projectId 进来写需求。
  // 不存在 / 不归属当前 user 一律视为"不存在"，避免泄露对方 projectId 是否真实存在。
  const project = await getProject(projectId);
  if (!project || project.ownerId !== user.uid) {
    return NextResponse.json({ ok: false, error: "project_not_found" }, { status: 404 });
  }
  const data = await createRequirement({
    projectId,
    title: body.title ?? "", // 允许空标题，后续对话自动生成
    card: body.card,
  });
  return NextResponse.json({ ok: true, data }, { status: 201 });
}
