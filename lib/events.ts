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
  /** 自动推进生成失败，通知对话面板显示可恢复错误 */
  GEN_ERROR: "askbuddy:gen-error",
  /** 定位来源：从产物条目跳回产生它的那轮对话并高亮 */
  LOCATE_SOURCE: "askbuddy:locate-source",
  /** 按钮手动进入下一阶段：shell 派发推进提示，panel 无 rid 守卫必收 */
  PROCEED_TIP: "askbuddy:proceed-tip",
} as const;

export type EvtName = (typeof EVT)[keyof typeof EVT];

/**
 * 最近派发的 GEN_MESSAGE 内容兜底缓存。
 *
 * 背景：requirement-shell 与 conversation-panel 通过 window CustomEvent 通信，
 * 若事件派发时 panel 尚未 ready（rid 为 null 或正在 mount），消息会丢失。
 * 此处缓存最近按 requirementId 派发的消息文本；panel 在 rid 就绪后主动 flush，
 * 避免变更流程中「XX 已更新」的提示偶发消失。
 */
export const pendingGenMessages = new Map<string, string[]>();
