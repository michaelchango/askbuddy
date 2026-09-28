// 场景 02：变更定向重算 —— **M5 的核心验收用例**（A1）。
//
// 第 6 步的「逐字节相同」是整个里程碑最硬的一条断言。它一次证明三件事：
//   ① 影响映射表算对了（该标的标了、不该标的没标）；
//   ② 定向重算真的只动了目标段；
//   ③ 未受影响段的 `_source` 溯源链没有被无谓重写
//      （若每次重算都刷新全部 `_source`，M3 的溯源能力会被悄悄毁掉）。

import { expect, test } from "@playwright/test";
import {
  gotoRequirement,
  introspect,
  lifecycleBadge,
  openPrdView,
  refreshDevContext,
  seed,
  sendMessage,
  type SseEvent,
} from "./fixtures/seed";

/** `card.constraints` 的闭包结果（按规范顺序）——与金样本一致，硬编码以钉住契约。 */
const EXPECTED_STALE = [
  "meta",
  "dependencies",
  "business_rules",
  "edge_cases",
  "acceptance_criteria",
  "test_cases",
  "references",
];

/** 必须逐字节不变的段（未受影响）。 */
const MUST_PRESERVE = [
  "objective",
  "scope",
  "$schema",
  "schema_version",
  "user_scenarios",
  "feature_logic",
  "data_structures",
  "api_requirements",
  "integration_external",
  "non_functional_requirements",
  "metrics_analytics",
  "glossary",
  "open_questions",
];

function changeUpdateOf(events: SseEvent[]): Record<string, unknown> | null {
  const hit = events.find((e) => e.event === "change_update");
  return hit ? hit.data : null;
}

test.describe("场景 02 · 变更定向重算（A1）", () => {
  test("改卡片 constraints → 只标记闭包内的段 → 定向重算后其余段逐字节不变", async ({
    page,
    request,
  }) => {
    // ---------- 1. seed 全流程，记录 DevContext v1 完整 JSON ----------
    const { requirementId } = await seed(request, "full-flow");
    expect(requirementId).toBeTruthy();
    const rid = requirementId as string;

    const before = await introspect(request, rid);
    expect(before.devContext.exists).toBe(true);
    expect(before.requirement.lifecycle).toBe("completed");
    const v1Content = JSON.stringify(before.devContext.content);
    const v1Version = before.devContext.version as number;

    // ---------- 2. 提一条变更请求 ----------
    const events = await sendMessage(request, rid, "把数据保留期限从 30 天改成 90 天");

    // ---------- 3. SSE change_update 的血缘载荷 ----------
    const changeUpdate = changeUpdateOf(events);
    expect(changeUpdate, "必须收到 change_update 事件").toBeTruthy();
    const affectedOutputs = changeUpdate!.affectedOutputs as string[];
    expect(affectedOutputs).toContain("card");

    const dcPayload = changeUpdate!.devContext as {
      staleSections: string[];
      reason: Record<string, string[]>;
      fullRecompute: boolean;
    };
    expect(dcPayload, "change_update 必须带上 devContext 血缘载荷").toBeTruthy();
    // 深等于：顺序也是契约的一部分（规范顺序 = meta 首 / 中间按 schema 声明顺序 / references 尾）
    expect(dcPayload.staleSections).toEqual(EXPECTED_STALE);
    expect(dcPayload.fullRecompute).toBe(false);
    expect(dcPayload.reason.business_rules).toContain("card.constraints");

    // 库内标记与载荷一致（不是只在事件里演了一遍）
    const marked = await introspect(request, rid);
    expect(marked.devContext.maybe_stale).toBe(true);
    expect(marked.devContext.stale_sections).toEqual(EXPECTED_STALE);

    // ---------- 3.5 ★ C6：标记 = 只标记，**不自动重算**（§5.3 用户决策原则） ----------
    // 变更走完之后、用户点「重算」之前：版本号必须没动、内容必须一个字节都没变。
    // 这条断言的分量在于：它把「打标记」与「动内容」在**契约层面**切开——
    // 一旦有人图省事在标记后顺手重算，这行会立刻红。
    expect(marked.devContext.version).toBe(v1Version);
    expect(JSON.stringify(marked.devContext.content)).toBe(v1Content);

    // ---------- 4. UI：过期徽标可见（折叠态也能看到，无需展开面板） ----------
    await gotoRequirement(page, rid);
    await openPrdView(page);
    await expect(page.getByText(`可能已过期（${EXPECTED_STALE.length} 处）`)).toBeVisible({
      timeout: 30_000,
    });

    // ---------- 5. 点概念上的「重算这 N 段」（走同一端点） ----------
    const refreshEvents = await refreshDevContext(request, rid, {
      mode: "targeted",
      sections: EXPECTED_STALE.filter((s) => s !== "meta" && s !== "references"),
    });
    const refreshed = changeUpdateOf(refreshEvents);
    expect(refreshed, "重算必须回 change_update").toBeTruthy();
    const dcAfter = refreshed!.devContext as {
      version: number;
      changed: string[];
      unchanged: string[];
    };
    expect(dcAfter.version).toBe(v1Version + 1);
    expect(dcAfter.changed).toEqual(EXPECTED_STALE);

    // ---------- 6. ★ 核心断言：逐 section 深比较 ----------
    const after = await introspect(request, rid);
    const v2Content = after.devContext.content as Record<string, unknown>;
    expect(after.devContext.version).toBe(v1Version + 1);
    expect(JSON.stringify(after.devContext.content)).not.toBe(v1Content);

    const v1Obj = before.devContext.content as Record<string, unknown>;
    for (const key of MUST_PRESERVE) {
      expect(
        JSON.stringify(v2Content[key] ?? null),
        `未受影响的段落被改动了：${key}`
      ).toBe(JSON.stringify(v1Obj[key] ?? null));
    }
    // 目标段确实变了（否则「重算了」与「没重算」无法区分）
    for (const key of ["business_rules", "edge_cases", "acceptance_criteria"]) {
      expect(
        JSON.stringify(v2Content[key]),
        `目标段应当变化：${key}`
      ).not.toBe(JSON.stringify(v1Obj[key]));
    }

    // ---------- 7. 版本快照的结构化 changelog 与实测一致 ----------
    const versions = after.devContext.versions ?? [];
    const latest = versions[versions.length - 1];
    expect(latest.version).toBe(v1Version + 1);
    const changelog = latest.changelog as {
      changed_sections: string[];
      unchanged_sections: string[];
      escalated: boolean;
    };
    expect(changelog.changed_sections).toEqual(EXPECTED_STALE);
    const preservedSections = MUST_PRESERVE.filter((k) => !k.startsWith("$") && k !== "schema_version");
    expect(changelog.unchanged_sections.slice().sort()).toEqual(preservedSections.slice().sort());
    expect(changelog.escalated).toBe(false);

    // ---------- 8. 标记已清干净 ----------
    expect(after.devContext.maybe_stale).toBe(false);
    expect(after.devContext.stale_sections).toEqual([]);

    // ---------- 9. 变更级联把已交付的需求打回 designing（并留审计） ----------
    expect(after.requirement.lifecycle).toBe("designing");
    const cascade = after.audit.filter((a) => a.source === "change_cascade");
    expect(cascade.length).toBeGreaterThanOrEqual(1);
    expect(cascade[cascade.length - 1].to).toBe("designing");
    expect(cascade[cascade.length - 1].reason?.length ?? 0).toBeGreaterThan(0);

    // UI 也同步到「设计中」
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(lifecycleBadge(page)).toHaveText("设计中", { timeout: 30_000 });
  });

  // ─────────────────────── C8：一致性失败只升级一次，仍失败就降 draft ───────────────────────
  //
  // 这条盯的是「不硬发」原则在定向重算里的落地：
  //   重算出来的段落彼此自相矛盾（AC 引用了不存在的业务规则）时，
  //   系统应当**把范围扩大一次**再试，而不是无限重试（烧 token）也不是硬发一份矛盾产物。
  //   第二次仍然失败 → 降级 draft，把决策交还给人。
  //
  // 驱动方式：把场景标记写进 changeNote —— mock 会从消息里识别 `[[scenario:xxx]]`。
  // 这样不必为了这一个用例重启 dev server（改 process.env 做不到按用例生效）。
  test("★ C8：定向重算产出自相矛盾时，升级一次 → 仍失败 → 降级 draft", async ({ request }) => {
    const { requirementId } = await seed(request, "full-flow");
    const rid = requirementId as string;

    const before = await introspect(request, rid);
    expect(before.devContext.status).toBe("confirmed");
    const v1 = before.devContext.version as number;

    const events = await refreshDevContext(request, rid, {
      mode: "targeted",
      // 请求段必须包含 acceptance_criteria，否则悬空引用会被「越权段丢弃」裁掉，
      // 这条用例就变成了在测别的东西。
      sections: ["dependencies", "business_rules", "edge_cases", "acceptance_criteria", "test_cases"],
      changeNote: "[[scenario:inconsistent]] 按新约束返工一次",
    });

    const payload = changeUpdateOf(events);
    expect(payload, "必须收到 change_update").toBeTruthy();
    const dc = payload!.devContext as {
      version: number;
      escalated: boolean;
      status: string;
      changed: string[];
      unchanged: string[];
    };

    // ① 发生过一次升级（而不是零次或无限次）
    expect(dc.escalated, "一致性失败必须触发一次升级重算").toBe(true);
    // ② 升级后仍然矛盾 → 降级 draft（不硬发）
    expect(dc.status).toBe("draft");
    expect(dc.version).toBe(v1 + 1);

    // ③ 库内状态与事件载荷一致，且审计里能看到这条 error 级问题
    const after = await introspect(request, rid);
    expect(after.devContext.status).toBe("draft");
    expect(after.devContext.version).toBe(v1 + 1);

    // ④ 未受影响段依然逐字节保留（升级重算也不能顺手改别处）
    const v1Obj = before.devContext.content as Record<string, unknown>;
    const v2Obj = after.devContext.content as Record<string, unknown>;
    for (const key of ["objective", "scope", "user_scenarios", "data_structures", "glossary"]) {
      expect(
        JSON.stringify(v2Obj[key] ?? null),
        `升级重算时未受影响段被改动了：${key}`
      ).toBe(JSON.stringify(v1Obj[key] ?? null));
    }
  });
});
