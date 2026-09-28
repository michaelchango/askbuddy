/**
 * 环境变量加载模块（必须在其他 import 之前 import）。
 *
 * 【为什么单独成文件】ESM 的 import 提升会先于模块体执行，若在脚本体内先 import
 * lib/ai/embedding 再调用 loadEnvConfig，embedding.ts 的模块级常量
 * （SECRET_ID/SECRET_KEY）会在 loadEnvConfig 之前求值 → 恒为 undefined →
 * 静默降级为确定性 mock，导致「以为在测真实 API，其实在测 mock」。
 *
 * 正确用法：
 *   import "./_env";            // 必须放在第一个
 *   import { embedText } from "@/lib/ai/embedding";
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
