@echo off
setlocal
title FiFTO Trading Secret — Server
cd /d "%~dp0"

set LOG=%~dp0startup-log.txt
echo [%date% %time%] Starting FiFTO... > %LOG%

echo [FiFTO] Releasing ports...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /R ":3001 "') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /R ":8008 "') do taskkill /f /pid %%a >nul 2>&1
echo [%date% %time%] Ports cleared >> %LOG%

set NODE="%ProgramFiles%\nodejs\node.exe"
set VITE=node_modules\vite\bin\vite.js

echo [FiFTO] Installing deps...
call "%ProgramFiles%\nodejs\npm.cmd" install --silent
echo [%date% %time%] npm install done >> %LOG%

echo [FiFTO] Starting Angel server...
start "FiFTO-Angel" /MIN %NODE% angel-server.mjs 1>>dev-server.out.log 2>>dev-server.err.log
echo [%date% %time%] Angel started >> %LOG%

timeout /t 3 /nobreak >nul

echo [FiFTO] Starting Vite...
start "FiFTO-Vite" /MIN %NODE% %VITE% --host 0.0.0.0 --port 8008 1>>vite.out.log 2>>vite.err.log
echo [%date% %time%] Vite started >> %LOG%

echo [FiFTO] Done. http://localhost:8008
echo [FiFTO] Logs: dev-server.out.log / dev-server.err.log / vite.out.log / vite.err.log
exit /b 0
