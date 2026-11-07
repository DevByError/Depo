@echo off
rem Start the web app on Windows. Run its checks and tests with: run.cmd test
setlocal
cd /d "%~dp0"

set "PM="
where npm >nul 2>nul && set "PM=npm"
if not defined PM where bun >nul 2>nul && set "PM=bun"
if not defined PM goto :nonode

if not exist "node_modules" (
  echo Installing packages ...
  call %PM% install || exit /b 1
)

if /i "%~1"=="test" goto :test

echo The web app runs on http://127.0.0.1:5173
call %PM% run dev
exit /b %errorlevel%

:test
call %PM% run typecheck || exit /b 1
call %PM% run test
exit /b %errorlevel%

:nonode
echo Node.js 20 or newer is needed: https://nodejs.org/
exit /b 1
