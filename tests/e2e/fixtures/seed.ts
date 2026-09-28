// e2e 公共夹具（M5-D5）。
//
// 两件事刻意做成公共夹具，避免 5 个场景各写一遍（写歪一处就是难查的 flaky）：
//   1. **seed / introspect**：所有场景都从 seed 预设起步，并用内省端点断言库内状态
//      —— 而不是去 UI 上找徽标推状态。UI 只用来断言「用户能看到的东西」。
//   2. **parseSse**：对话与重算都是 SSE，断言 payload 必须先把它解析成事件数组。

import { expect, type APIRequestContext, type Page } from "@playwright/test";

export type Preset =
  | "empty"
  | "card-ready"
  | "full-flow"
  | "review-blocked"
  | "draft-devcontext";

export interface SeedResult {
  preset: string;
  projectId: string;
  requirementId: string | null;
  /** withToken=true 时返回（05 的 MCP 冒烟用）。 */
  token?: string | null;
}

/** 重置内存库到指定预设（seed 端点内部会先清空，用例之间不互相污染）。 */
export async function seed(
  request: APIRequestContext,
  preset: Preset,
  opts: { withToken?: boolean } = {}
): Promise<SeedResult> {
  const res = await request.post("/api/test/seed", {
    data: { preset, withToken: opts.withToken === true },
    timeout: 180_000,
  });
  expect(res.ok(), `seed(${preset}) 失败：${res.status()} ${await res.text()}`).toBeTruthy();
  const body = (await res.json()) as { ok: boolean; data: SeedResult };
  return body.data;
}

export interface StepSnapshot {
  step: string;
  state: string;
  awaitingConfirm: boolean;
}

export interface AuditRow {
  from: string | null;
  to: string;
  actor: string;
  source: string;
  reason: string | null;
}

export interface DevContextSnapshot {
  exists: boolean;
  version?: number;
  status?: string;
  completeness_score?: number;
  maybe_stale?: boolean;
  stale_sections?: string[];
  stale_reason?: Record<string, string[]>;
  content?: Record<string, unknown>;
  versions?: Array<{ version: number; status: string; changelog: unknown }>;
}

export interface Snapshot {
  requirement: { id: string; title: string; currentVersion: number; lifecycle: string };
  steps: StepSnapshot[];
  audit: AuditRow[];
  devContext: DevContextSnapshot;
}

/** 只读内省：直接读库内真实状态（不经过 UI 推测）。 */
export async function introspect(
  request: APIRequestContext,
  requirementId: string
): Promise<Snapshot> {
  const res = await request.get(`/api/test/seed?requirementId=${requirementId}`, {
    timeout: 90_000,
  });
  expect(res.ok(), `introspect 失败：${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { ok: boolean; data: Snapshot };
  return body.data;
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** 把 SSE 文本解析成事件数组（`event:` / `data:` 成对取）。 */
export function parseSse(text: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    const eventLine = block.split("\n").find((l) => l.startsWith("event:"));
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    if (!eventLine || !dataLine) continue;
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
    } catch {
      continue;
    }
    out.push({ event: eventLine.slice(6).trim(), data });
  }
  return out;
}

/**
 * 发一条对话消息（SSE 一次性读完）。
 *
 * 用 HTTP 而不是在输入框里敲字：本套 e2e 的验收目标是**状态机与血缘行为**，
 * 不是输入框的交互细节；敲字要处理受控组件、防抖、以及"发送中"禁用态，
 * 只会引入 flaky，换不来更强的断言。UI 交互本身由场景 04 的按钮点击覆盖。
 */
export async function sendMessage(
  request: APIRequestContext,
  requirementId: string,
  message: string
): Promise<SseEvent[]> {
  const res = await request.post(`/api/requirements/${requirementId}/conversation`, {
    data: { message },
    timeout: 180_000,
  });
  expect(res.ok(), `conversation 失败：${res.status()}`).toBeTruthy();
  return parseSse(await res.text());
}

/** 触发定向重算（SSE 一次性读完）。 */
export async function refreshDevContext(
  request: APIRequestContext,
  requirementId: string,
  data: { mode?: "targeted" | "full"; sections?: string[]; changeNote?: string } = {}
): Promise<SseEvent[]> {
  const res = await request.post(`/api/requirements/${requirementId}/dev-context/refresh`, {
    data,
    timeout: 180_000,
  });
  expect(res.ok(), `refresh 失败：${res.status()}`).toBeTruthy();
  return parseSse(await res.text());
}

/** e2e 用的会话昵称 = seed 数据的 ownerId（与 seed 路由里的 MOCK_UID 一致）。 */
export const E2E_UID = "mock-user-001";

/**
 * 带上会话 Cookie —— 否则受守卫的路由会把浏览器重定向到 `/try` 落地页。
 *
 * ⚠️ Cookie 值必须**等于 seed 数据的属主 uid**：`getSession()` 用昵称当 uid，
 * 而所有归属校验都是 `project.ownerId === user.uid`。随便填一个（如 "e2e"）会让
 * seed 出来的数据一律 404 —— 这个坑很隐蔽，表现为「页面能打开但什么都没有」。
 */
export async function useE2eSession(page: Page): Promise<void> {
  await page.context().addCookies([
    { name: "askbuddy_session", value: E2E_UID, url: "http://127.0.0.1:3100" },
  ]);
}

/** 打开需求工作台（自动带上会话）。 */
export async function gotoRequirement(page: Page, requirementId: string): Promise<void> {
  await useE2eSession(page);
  await page.goto(`/dashboard/requirements/${requirementId}`, { waitUntil: "domcontentloaded" });
}

/**
 * 切到 PRD 视图 —— 「开发上下文」面板**只在 selected.type === 'prd' 时挂载**
 * （见 requirement-shell 的 `{selected.type === "prd" && <DevContextPanel …/>}`），
 * 所以任何断言 DC 面板的用例都必须先切过来，否则元素根本不在 DOM 里。
 */
export async function openPrdView(page: Page): Promise<void> {
  const entry = page.locator("aside nav").getByRole("button", { name: /需求文档/ });
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  await expect(page.getByText("开发上下文（供 AI 读取）")).toBeVisible({ timeout: 30_000 });
}

/** 生命周期徽标（组件里带 title="需求生命周期"，是稳定的语义锚点）。 */
export function lifecycleBadge(page: Page) {
  return page.locator('[title="需求生命周期"]');
}

/** 断言徽标文案（生命周期流转的直接观测点）。 */
export async function expectLifecycle(page: Page, label: string): Promise<void> {
  await expect(lifecycleBadge(page)).toHaveText(label, { timeout: 30_000 });
}
