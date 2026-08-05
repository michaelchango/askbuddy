/**
 * 跨组件 DOM 自定义事件名集中定义。
 *
 * 这些事件通过 window.dispatchEvent / addEventListener 在
 * requirement-shell、conversation-panel、prototype-panel 之间传递。
 * 由于 dispatch 与 listen 分散在不同文件，用字面量极易出现单侧改动
 * 导致的「静默失效」，故统一在此常量化，禁止再写裸字符串。
 */
export const EVT = {
  /** 向对话面板回灌一条生成中/生成完成的消息 */
  GEN_MESSAGE: "askbuddy:gen-message",
  /** 变更分析完成回执 */
  CHANGE_COMPLETE: "askbuddy:change-complete",
  /** 变更分析过程中的增量更新 */
  CHANGE_UPDATE: "askbuddy:change-update",
  /** 请求进入修改态（原型/产出物） */
  REQUEST_MODIFY: "askbuddy:request-modify",
  /** 「继续下一步」提示卡 */
  PROCEED_PROMPT: "askbuddy:proceed-prompt",
} as const;

export type EvtName = (typeof EVT)[keyof typeof EVT];
