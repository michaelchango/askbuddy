// CloudBase 接入封装（MVP 阶段：USE_MOCK=true 走内存占位）
// 未来切换真实 CloudBase 仅替换本文件内部实现，业务代码不改动。

export const USE_MOCK = process.env.USE_MOCK === "true";

export type DbBackendName = "mock" | "nosql" | "postgres" | "cloudbase";

/**
 * 解析数据库后端。优先级：USE_MOCK > DB_BACKEND > 默认 nosql。
 *
 * 【为什么 USE_MOCK 优先且语义不可改】
 * USE_MOCK 不只被数据库消费，storage / auth / ai 三处都在读它来决定走不走真实服务。
 * 若把它降级为 DB_BACKEND 的一个取值，本地 `USE_MOCK=true` 的开发者会在毫无察觉的
 * 情况下开始往真实库写数据。所以这里保持「USE_MOCK=true 一票否决」。
 *
 * 【为什么默认 nosql 而不是 postgres】
 * M1 合入主干时必须保证「不设任何新环境变量 = 行为与合入前逐字节一致」，
 * 否则同事拉下代码就会连不上库。切换 PG 是一个显式动作：DB_BACKEND=postgres 或 cloudbase。
 */
export function resolveDbBackend(): DbBackendName {
  if (USE_MOCK) return "mock";
  const raw = (process.env.DB_BACKEND ?? "").trim().toLowerCase();
  if (raw === "" || raw === "nosql") return "nosql";
  if (raw === "postgres" || raw === "postgresql" || raw === "pg") return "postgres";
  // cloudbase：CloudBase PostgreSQL 经公网网关 SQL 执行接口（B 通道），不依赖 DATABASE_URL。
  if (raw === "cloudbase") return "cloudbase";
  if (raw === "mock") return "mock";
  throw new Error(
    `DB_BACKEND 取值非法："${process.env.DB_BACKEND}"。` +
      `合法值：mock | nosql | postgres | cloudbase（留空等同 nosql）。`
  );
}

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
    // ⚠️ uid 保持 "mock-user-001" 不变：存量数据以该 uid 归属，不可随品牌改名。
    return { uid: "mock-user-001", email: "dev@askbuddy.local" };
  }
  // TODO: 接入 CloudBase 身份认证 verifySession()
  return null;
}
