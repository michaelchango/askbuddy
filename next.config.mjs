import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 云托管（容器型）部署需要 standalone 产物；Vercel 会忽略该选项，不影响现有部署。
  output: "standalone",
  reactStrictMode: true,
  webpack: (config, { dir }) => {
    // 显式注册 @ → 项目根 的 webpack alias。
    // 背景：Next 14.2.35 依赖内置的 tsconfig-paths 插件把 tsconfig.json 的
    // paths 自动转成 webpack alias，但在 Vercel（Node 24 + npm 11/12）环境下
    // 该转换静默失效，表现为大量 "Module not found: Can't resolve '@/...'"。
    // 这里显式挂一层 alias，不再依赖 tsconfig 自动转换（tsconfig 保留供 TS 使用）。
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      "@": path.resolve(dir, "."),
    };
    return config;
  },
  // CloudBase Webify 部署时无需额外配置；如需自定义域名再补充
};

export default nextConfig;
