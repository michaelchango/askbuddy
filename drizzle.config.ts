// drizzle-kit 配置。
// 注意：drizzle-kit 以独立进程运行，不经过 Next.js 的环境加载流程，
// 因此这里显式用 @next/env 载入 .env.local（与 npm run dev 读到的是同一份配置）。
import { loadEnvConfig } from "@next/env";
import type { Config } from "drizzle-kit";

loadEnvConfig(process.cwd());

// drizzle-kit 的 `generate` 子命令【不连接数据库】，只用 schema 文件离线生成迁移 SQL；
// 只有 `migrate` / `studio` 才需要真实连接。
// 因此 DATABASE_URL 缺失时退化为占位串，让 `npm run db:generate` 能离线跑；
// 真正连库的阶段（migrate.ts / drizzle-kit migrate）会拒绝占位串并提示填真实连接串。
const OFFLINE_PLACEHOLDER = "postgresql://__offline__:__offline__@localhost:5432/askbuddy?sslmode=disable";
const url = process.env.DATABASE_URL?.trim() || OFFLINE_PLACEHOLDER;

export default {
  schema: "./db/drizzle/schema.ts",
  out: "./db/drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
} satisfies Config;
