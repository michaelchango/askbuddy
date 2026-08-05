// CloudBase 接入封装（MVP 阶段：USE_MOCK=true 走内存占位）
// 未来切换真实 CloudBase 仅替换本文件内部实现，业务代码不改动。

export const USE_MOCK = process.env.USE_MOCK === "true";

export interface AuthUser {
  uid: string;
  email: string;
}

/**
 * 获取当前登录用户。Mock 模式返回固定开发用户；
 * 真实模式应改为 CloudBase Auth 会话校验。
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  if (USE_MOCK) {
    return { uid: "mock-user-001", email: "dev@prdflow.local" };
  }
  // TODO: 接入 CloudBase 身份认证 verifySession()
  return null;
}
