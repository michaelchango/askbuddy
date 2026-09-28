// 场景 03：DevContext 导出（5 种格式）+ 内容一致性（M5-D5）。
//
// 断言分两层：
//   ① 每种格式都能真的下载到非空产物（导出链路没断）；
//   ② **5 种格式是同一份 DevContext 的不同投影** —— 抽取各自的业务规则条数，
//      必须相等。这一条比"每个文件非空"有用得多：它能抓到「某个渲染器读了旧的
//      字段名/漏了一段」这类静默错位。

import { expect, test, type Download, type Page } from "@playwright/test";
import { DevContextSchema } from "@/lib/schemas/devcontext";
import { gotoRequirement, openPrdView, seed } from "./fixtures/seed";

const FORMATS = [
  { label: "Markdown (.md)", ext: ".md" },
  { label: "CLAUDE.md", ext: ".md" },
  { label: ".cursorrules", ext: "" },
  { label: "结构化 Prompt (.txt)", ext: ".txt" },
  { label: "JSON (.json)", ext: ".json" },
];

async function readDownload(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

/** 打开导出菜单并点击某一项，返回下载内容。 */
async function exportAs(page: Page, label: string): Promise<string> {
  await page.getByRole("button", { name: "导出开发上下文" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    page.getByText(label, { exact: true }).click(),
  ]);
  return readDownload(download);
}

test.describe("场景 03 · 导出五格式", () => {
  test("5 种格式都能导出，且业务规则条数互相一致", async ({ page, request }) => {
    const { requirementId } = await seed(request, "full-flow");
    const rid = requirementId as string;

    await gotoRequirement(page, rid);
    await openPrdView(page);

    const contents: Record<string, string> = {};
    for (const f of FORMATS) {
      const text = await exportAs(page, f.label);
      expect(text.length, `${f.label} 导出内容为空`).toBeGreaterThan(0);
      contents[f.label] = text;
    }

    // ---------- JSON：必须能过 M2 的 Zod schema（复用真实 schema，不另写断言） ----------
    const json = JSON.parse(contents["JSON (.json)"]) as Record<string, unknown>;
    const parsed = DevContextSchema.safeParse(json);
    expect(
      parsed.success,
      parsed.success ? "" : `JSON 导出未通过 schema：${JSON.stringify(parsed.error.issues.slice(0, 3))}`
    ).toBe(true);

    // ---------- 一致性：同一份 DevContext 的不同投影，业务规则条数应相等 ----------
    const ruleCount = (Array.isArray(json.business_rules) ? json.business_rules.length : 0);
    expect(ruleCount).toBeGreaterThan(0);

    for (const [label, text] of Object.entries(contents)) {
      if (label === "JSON (.json)") continue;
      const hits = text.match(/BR-\d{3}/g) ?? [];
      // Markdown 系列每个规则至少出现一次（可能存在引用重复，故用「去重后条数」比较）
      const distinct = new Set(hits);
      expect(
        distinct.size,
        `${label} 里的业务规则条数（${distinct.size}）与 JSON 不一致（${ruleCount}）`
      ).toBe(ruleCount);
    }

    // ---------- Markdown 投影至少要有章节标题（不是一段纯文本） ----------
    expect(contents["Markdown (.md)"]).toMatch(/^##/m);
  });
});
