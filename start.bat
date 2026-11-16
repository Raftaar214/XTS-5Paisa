@echo off
rem  XTS Trading Desk - start everything with one double-click.
rem
rem    start.bat           install what is missing, build the dashboard,
rem                        start the backend (dashboard + API + live quotes
rem                        all on PORT from backend\.env, default 5000)
rem    start.bat --check   do everything EXCEPT start the server
rem
rem  Then open  http://<this machine's IP>:<PORT>  from any computer.
rem  Stop the server by closing this window or pressing Ctrl+C.
setlocal EnableExtensions
title XTS Trading Desk
cd /d "%~dp0"

set "CHECK_ONLY="
if /i "%~1"=="--check" set "CHECK_ONLY=1"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install Node.js 18 or later from https://nodejs.org and run this again.
  goto :fail
)

if not exist "backend\.env" (
  echo [ERROR] backend\.env is missing. Create it first - see README.md, "Backend Configuration".
  goto :fail
)

if not exist "backend\node_modules" (
  echo Installing backend packages...
  pushd backend
  call npm install --omit=dev
  if errorlevel 1 ( popd & echo [ERROR] Backend install failed. & goto :fail )
  popd
)

if not exist "frontend\node_modules" (
  echo Installing dashboard packages...
  pushd frontend
  call npm install
  if errorlevel 1 ( popd & echo [ERROR] Dashboard install failed. & goto :fail )
  popd
)

echo Building the dashboard...
pushd frontend
call npm run build --silent
if errorlevel 1 ( popd & echo [ERROR] Dashboard build failed. & goto :fail )
popd

node scripts\show-urls.js

if defined CHECK_ONLY (
  echo Check complete - packages installed and dashboard built. Server NOT started ^(--check^).
  exit /b 0
)

echo Starting the backend. Keep this window open while trading.
echo.
cd backend
node server.js
echo.
echo The server has stopped.
pause
exit /b 0

:fail
if not defined CHECK_ONLY pause
exit /b 1
