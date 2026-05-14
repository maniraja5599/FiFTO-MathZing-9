@echo off
setlocal
title FiFTO Trading Secret — Server
cd /d "%~dp0"

echo [FiFTO] Releasing ports 3001 and 8008 if in use...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /R ":3001 "') do (
  taskkill /f /pid %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /R ":8008 "') do (
  taskkill /f /pid %%a >nul 2>&1
)

echo [FiFTO] Clearing old log files...
del /q dev-server.out.log dev-server.err.log vite.out.log vite.err.log >nul 2>&1

echo [FiFTO] Starting FiFTO Trading Secret...
echo [FiFTO] Vite  : http://localhost:8008
echo [FiFTO] Angel : http://127.0.0.1:3001
echo.

start "FiFTO Angel Server" /min cmd /c "cd /d "%~dp0" && node angel-server.mjs 1>>dev-server.out.log 2>>dev-server.err.log"
timeout /t 3 /nobreak >nul
start "FiFTO Vite" /min cmd /c "cd /d "%~dp0" && npx vite --host 0.0.0.0 --port 8008 1>>vite.out.log 2>>vite.err.log"

echo [FiFTO] Both servers launched in minimized windows.
echo [FiFTO] Logs:
echo   dev-server.out.log / dev-server.err.log
echo   vite.out.log / vite.err.log
exit /b 0
