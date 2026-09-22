/**
 * 会话相关的纯常量（无副作用、无 Node/Next 运行时依赖）。
 *
 * 为什么单独一个文件：
 * `middleware.ts` 运行在 Edge Runtime，无法 import 依赖 `next/headers` 的
 * `lib/auth/session.ts`；而 Cookie 名必须在 middleware（守卫）与 session（读取）
 * 两侧完全一致，任何一侧漏改都会表现为「登录成功却被反复打回 /login」。
 * 因此把常量下沉到这里，两侧统一引用，禁止再写裸字符串。
 */

/** 会话 Cookie 名（改名前为 prd_session，改名后旧 Cookie 自然失效，用户重新登录即可）。 */
export const SESSION_COOKIE = "askbuddy_session";

/** 体验模式：Cookie 有效期（30 天，过期需重填昵称）。 */
export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/** 体验模式：昵称最大字符数（与 /api/auth/login 校验同步）。 */
export const NICK_MAX_LEN = 20;
