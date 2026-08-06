/**
 * 修正验证：app.rdb() 在「仅 API Key 初始化」下，传 { database: 'public' } 应能正常 CRUD。
 * 同时对比默认(不传)的 schema 错误，确认根因。
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

async function main() {
  const tcb = (await import("@cloudbase/node-sdk")).default;
  const env = process.env.CLOUDBASE_ENV_ID!;
  const secret = process.env.CLOUDBASE_SECRET!;
  const app = tcb.init({ env, accessKey: secret });

  // 1) 默认（schema=envId）→ 预期 PGRST106
  try {
    const bad = await (app as any).rdb().from("my_table").select("*").limit(1);
    console.log("[默认] ", JSON.stringify(bad).slice(0, 160));
  } catch (e: any) {
    console.log("[默认] 失败:", (e?.message ?? e).split("\n")[0]);
  }

  // 2) 修正：database: 'public'
  try {
    const ok = await (app as any).rdb({ database: "public" }).from("my_table").select("*").limit(1);
    console.log("[public] ✓", JSON.stringify(ok).slice(0, 200));
  } catch (e: any) {
    console.log("[public] 失败:", (e?.message ?? e).split("\n")[0], "code:", e?.code);
  }
}
main();
