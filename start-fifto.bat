@echo off
title FiFTO Trading Secret — Server
cd /d "%~dp0"

echo [FiFTO] Releasing ports 3001 and 8008 if in use...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /R ":3001 "') do (
  taskkill /f /pid %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /R ":8008 "') do (
  taskkill /f /pid %%a >nul 2>&1
)

echo [FiFTO] Starting FiFTO Trading Secret...
echo [FiFTO] Vite  : http://localhost:8008
echo [FiFTO] Angel : http://127.0.0.1:3001
echo.
npm run dev
