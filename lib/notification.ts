'use client';

/**
 * 浏览器桌面通知工具模块
 *
 * 基于浏览器原生 Notification API，零依赖。
 * 用于在输出物生成完成时向用户推送桌面通知。
 */

const NOTIFICATION_TITLE = '任务已完成';
const NOTIFICATION_ICON = '/logo-orange.png';

/** 检测当前浏览器是否支持 Notification API */
export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * 请求通知权限。
 * 必须由用户手势触发（如点击按钮），否则浏览器不会弹出授权提示。
 * 已授权或已拒绝时直接返回原状态，不做重复请求。
 */
export async function requestPermission(): Promise<NotificationPermission> {
  // ===== 诊断日志：帮助定位权限框不弹出的问题 =====
  const secure = typeof window !== 'undefined' ? window.isSecureContext : false;
  const supported = isNotificationSupported();
  const current = supported ? Notification.permission : 'unsupported';
  console.info('[Notification] 请求权限诊断:', {
    supported,
    secureContext: secure,
    currentPermission: current,
    origin: typeof window !== 'undefined' ? window.location.origin : 'N/A',
  });

  if (!supported) {
    console.warn('[Notification] 浏览器不支持 Notification API');
    return 'denied';
  }
  if (!secure) {
    console.warn(
      '[Notification] 当前非安全上下文（非 HTTPS / 非 localhost），浏览器禁用 Notification API',
    );
    return 'denied';
  }
  if (current === 'granted' || current === 'denied') {
    console.info(`[Notification] 权限已决定为 "${current}"，不再弹框`);
    return current;
  }
  try {
    console.info('[Notification] 调用 requestPermission()，等待用户选择...');
    const result = await Notification.requestPermission();
    console.info(`[Notification] 用户选择: ${result}`);
    return result;
  } catch (e) {
    console.error('[Notification] requestPermission 抛错:', e);
    return 'denied';
  }
}

/** 页面是否处于"活跃"状态：可见且聚焦。活跃时不应打扰用户 */
export function isPageActive(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'visible' && document.hasFocus();
}

type NotifyOptions = {
  title: string; // 通知标题
  body: string; // 通知正文
  url: string; // 点击后跳转的链接
};

/**
 * 核心发送逻辑：
 * - 不支持 / 未授权 → 静默跳过
 * - 页面活跃中 → 跳过（不打扰正在使用的用户）
 * - 权限为 default 时尝试请求（能弹出授权框则弹出，不能则静默跳过）
 * - 否则弹出通知，点击后聚焦窗口并跳转
 */
async function showNotification({ title, body, url }: NotifyOptions): Promise<void> {
  if (!isNotificationSupported()) return;
  if (isPageActive()) return;

  // 权限未决定时尝试请求（如果调用处保留了用户手势，可弹出授权框）
  if (Notification.permission === 'default') {
    await requestPermission();
  }
  if (Notification.permission !== 'granted') return;

  const notification = new Notification(title, {
    body,
    icon: NOTIFICATION_ICON,
    tag: url, // 同一条需求的多次通知合并为一条
  });

  notification.onclick = () => {
    window.focus();
    window.location.href = url;
    notification.close();
  };
}

/** 正常流程：输出物完成通知 */
export function notifyOutputComplete(
  requirementTitle: string,
  outputLabel: string,
  requirementId: string,
): Promise<void> {
  const reqTitle = requirementTitle.trim() || '未命名需求';
  const body = `「${reqTitle}」的「${outputLabel}」已完成，您可以点击查看详情。`;
  const url = `/dashboard/requirements/${requirementId}`;
  return showNotification({ title: NOTIFICATION_TITLE, body, url });
}

/** 变更流程：需求变更完成通知（整次变更只发一次） */
export function notifyChangeComplete(
  requirementTitle: string,
  requirementId: string,
): Promise<void> {
  const reqTitle = requirementTitle.trim() || '未命名需求';
  const body = `「${reqTitle}」已完成需求变更，您可以点击查看详情。`;
  const url = `/dashboard/requirements/${requirementId}`;
  return showNotification({ title: NOTIFICATION_TITLE, body, url });
}
