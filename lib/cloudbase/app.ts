// CloudBase 应用单例：AI 与 DB 共用同一 init，避免重复初始化。
import tcb from "@cloudbase/node-sdk";
import { USE_MOCK } from "./index";

let _app: any = null;

export function getCloudApp() {
  if (!_app) {
    const env = process.env.CLOUDBASE_ENV_ID;
    const secret = process.env.CLOUDBASE_SECRET;
    if (!env || !secret) {
      throw new Error(
        "CloudBase 未配置：请在 .env.local 设置 CLOUDBASE_ENV_ID 与 CLOUDBASE_SECRET"
      );
    }
    _app = tcb.init({ env, accessKey: secret });
  }
  return _app;
}

let _ai: any = null;

// 返回 CloudBase AI 模型服务入口（createModel("cloudbase")）。
export function getCloudAI() {
  const app = getCloudApp();
  if (!_ai) _ai = app.ai();
  return _ai;
}
