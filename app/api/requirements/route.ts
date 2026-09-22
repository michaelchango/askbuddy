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

// 数据库在境内，函数固定在香港区域，缩短每趟 SQL 跨网关往返（覆盖 Vercel 后台 region 设置）。
export const preferredRegion = "hkg1";

/** 每页条数上限，防止 pageSize 被放大成全表扫描。 */
const MAX_PAGE_SIZE = 100;

/**
 * 解析分页参数。三个参数都不传时返回 null —— 调用方据此保持「返回全量」的历史行为，
 * 这样既有调用方（多数页面仍一次取全部）不受本次改动影响。
 *
 * 背景：概览页 / 项目列表页 / 项目需求列表页原本都是一次拉全量需求再前端切片，
 * 数据量随使用线性增长；而生产环境前端部署在海外、数据库在境内，
 * 每次跨网关 SQL 往返约 1.7s，无上限的全量拉取会越来越慢。
 *
 * 关于 withTotal：统计总数本身是一次额外的跨网关往返（约 1.7s）。
 * 只有真正需要翻页控件的页面才传 page 参数；只想"取前 N 条"的页面（概览页、
 * 项目列表页）只传 limit，此时不查 total —— 否则省下的数据量收益还抵不过
 * 多出来这次查询的代价。
 */
function parsePaging(
  sp: URLSearchParams
): { page: number; pageSize: number; offset: number; withTotal: boolean } | null {
  const limitParam = sp.get("limit");
  const pageParam = sp.get("page");
  const pageSizeParam = sp.get("pageSize");
  if (limitParam == null && pageParam == null && pageSizeParam == null) return null;

  const pageSize = Math.min(
    Math.max(Number(pageSizeParam ?? limitParam ?? 20) || 20, 1),
    MAX_PAGE_SIZE
  );
  const page = Math.max(Number(pageParam ?? 1) || 1, 1);
  return { page, pageSize, offset: (page - 1) * pageSize, withTotal: pageParam != null };
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
    const data = await listRequirements(projectId, {
      limit: paging.pageSize,
      offset: paging.offset,
    });
    // 未传 page 时不要为算 total 多跑一次跨网关查询
    if (!paging.withTotal) return NextResponse.json({ ok: true, data });
    const total = await countRequirements(projectId);
    return NextResponse.json(paged(data, total, paging.page, paging.pageSize));
  }

  // 跨项目列表（概览页「最近需求」）。
  if (!paging) {
    const data = await listRequirementsForOwner(user.uid);
    return NextResponse.json({ ok: true, data });
  }

  // 先取项目（进程内缓存），当页数据与总数内部的 listProjects 共用同一份缓存。
  const data = await listRequirementsForOwner(user.uid, {
    limit: paging.pageSize,
    offset: paging.offset,
  });
  // 未传 page 时不要为算 total 多跑一次跨网关查询
  if (!paging.withTotal) return NextResponse.json({ ok: true, data });
  const total = await countRequirementsForOwner(user.uid);
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
