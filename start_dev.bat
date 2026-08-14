@echo off
cd /d "%~dp0"

REM 启动前先对 cloudbase 网关库补建迁移所需的表/列（drizzle migrate 不会自动跑到 cloudbase 真实库）
REM 非 cloudbase 后端时该脚本会自动跳过，不阻塞启动
echo 正在同步数据库结构（cloudbase 网关迁移）...
call npx tsx scripts/db-migrate-cloudbase.ts
if errorlevel 1 (
  echo [警告] cloudbase 数据库迁移失败，请检查凭据或网络连接，dev server 仍将启动。
)

call npm run dev -- -H 0.0.0.0 > dev_server.log 2>&1
