// 需求生命周期状态机单测（M5-D1）。
//
// 两条刻意偏离 askbuddy-legacy 的设计必须钉死（防止后人"修正"回去）：
//   1. dialoguing 独立成态；
//   2. completed → designing 放开（变更打回返工）。
// deriveLifecycle 永不产出人工态（review/completed）——HITL 主权。

import { test } from "vitest";
import assert from "node:assert/strict";
import {
  LIFECYCLE_KEYS,
  LIFECYCLE_TRANSITIONS,
  LifecycleTransitionError,
  assertTransition,
  availableTransitions,
  canTransition,
  deriveLifecycle,
  isEditable,
  isTerminal,
  type RequirementLifecycle,
} from "@/lib/requirement-lifecycle";

const ALL: RequirementLifecycle[] = [
  "created",
  "dialoguing",
  "designing",
  "review",
  "completed",
  "archived",
];

test("迁移矩阵全枚举：6×6 组 canTransition 与邻接表逐一对照", () => {
  for (const from of ALL) {
    for (const to of ALL) {
      const expected = LIFECYCLE_TRANSITIONS[from].includes(to);
      assert.equal(
        canTransition(from, to),
        expected,
        `${from} → ${to} 应为 ${expected}`
      );
    }
  }
  // 邻接表必须覆盖全部 6 态（新增状态漏配这里会炸）
  assert.deepEqual(Object.keys(LIFECYCLE_TRANSITIONS).sort(), [...ALL].sort());
});

test("archived 是形式终态：availableTransitions 恒为空", () => {
  assert.deepEqual(availableTransitions("archived"), []);
  assert.ok(isTerminal("archived"));
  assert.ok(!isTerminal("completed"));
});

test("非法迁移：assertTransition 抛 LifecycleTransitionError 且 message 含允许列表", () => {
  assert.throws(
    () => assertTransition("created", "completed"),
    (e: unknown) => {
      assert.ok(e instanceof LifecycleTransitionError);
      assert.ok(/dialoguing \/ archived/.test(e.message));
      return true;
    }
  );
});

test("★ completed → designing 合法（刻意偏离 askbuddy-legacy，变更打回返工）", () => {
  assert.ok(canTransition("completed", "designing"));
  assert.ok(canTransition("review", "designing")); // 打回
  assert.ok(canTransition("review", "completed")); // 通过
});

test("isEditable：仅 completed / archived 不可编辑", () => {
  assert.ok(isEditable("created"));
  assert.ok(isEditable("dialoguing"));
  assert.ok(isEditable("designing"));
  assert.ok(isEditable("review"));
  assert.ok(!isEditable("completed"));
  assert.ok(!isEditable("archived"));
});

test("deriveLifecycle 判定顺序：archivedAt 优先于一切", () => {
  const steps = [
    { step: "dialoguing" as const, state: "done" as const },
    { step: "prd_writing" as const, state: "in_progress" as const },
  ];
  assert.equal(
    deriveLifecycle({ archivedAt: "2026-01-01", hasConversation: true, steps }),
    "archived"
  );
});

test("deriveLifecycle：全部 not_started 且无对话 → created", () => {
  assert.equal(
    deriveLifecycle({
      archivedAt: null,
      hasConversation: false,
      steps: [
        { step: "dialoguing", state: "not_started" },
        { step: "research_analysis", state: "not_started" },
      ],
    }),
    "created"
  );
  // 无步骤行（惰性初始化前）等价于 created
  assert.equal(
    deriveLifecycle({ archivedAt: null, hasConversation: false, steps: [] }),
    "created"
  );
});

test("deriveLifecycle：有对话但访谈未 done → dialoguing", () => {
  assert.equal(
    deriveLifecycle({
      archivedAt: null,
      hasConversation: true,
      steps: [
        { step: "dialoguing", state: "in_progress" },
        { step: "research_analysis", state: "not_started" },
      ],
    }),
    "dialoguing"
  );
});

test("deriveLifecycle：访谈 done（即使后续未推进）→ designing", () => {
  assert.equal(
    deriveLifecycle({
      archivedAt: null,
      hasConversation: true,
      steps: [
        { step: "dialoguing", state: "done" },
        { step: "research_analysis", state: "not_started" },
      ],
    }),
    "designing"
  );
  // 完整四步全 done → 仍是 designing（completed 是人工决策，系统不自动进入）
  assert.equal(
    deriveLifecycle({
      archivedAt: null,
      hasConversation: true,
      steps: [
        { step: "dialoguing", state: "done" },
        { step: "research_analysis", state: "done" },
        { step: "design", state: "done" },
        { step: "prd_writing", state: "done" },
      ],
    }),
    "designing"
  );
});

test("★ deriveLifecycle 永不产出人工态（100 组伪随机步骤组合，种子固定）", () => {
  // LCG 伪随机：种子固定 → 结果可复现（确定性纪律）
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const states = ["not_started", "in_progress", "done", "pending_update"] as const;
  for (let i = 0; i < 100; i++) {
    const steps = ["dialoguing", "research_analysis", "design", "prd_writing"].map(
      (step) => ({
        step: step as "dialoguing",
        state: states[Math.floor(rand() * states.length)],
      })
    );
    const result = deriveLifecycle({
      archivedAt: rand() > 0.9 ? "2026-01-01" : null,
      hasConversation: rand() > 0.5,
      steps,
    });
    assert.ok(
      result === "created" || result === "dialoguing" || result === "designing" || result === "archived",
      `自动派生不得产出人工态：${result}`
    );
  }
});
