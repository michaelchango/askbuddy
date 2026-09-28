# CloudBase 云托管（容器型）部署用 Dockerfile。
# 多阶段构建出 Next.js standalone 产物，最终镜像只含运行所需文件。
# 说明：构建期用 DB_SETUP_SKIP=1 跳过 prebuild 的建库脚本（表已存在，构建机不应连生产库）。

# ---- 依赖安装 ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- 构建 ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DB_SETUP_SKIP=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- 运行 ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
