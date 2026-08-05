@echo off
cd /d "%~dp0"
call npm run dev -- -H 0.0.0.0 > dev_server.log 2>&1
