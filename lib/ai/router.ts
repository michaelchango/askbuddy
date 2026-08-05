// AI 调用统一入口（兼容层）。实际实现见 client.ts。
// 所有 AI 调用必须经此或 orchestrator，禁止在业务代码硬编码模型名。
export { callAI, streamAI } from "./client";
