@echo off
rem Start the API (in its own window) and the web app on Windows. Run every test with: test.cmd
setlocal
cd /d "%~dp0"
if not exist "be\node_modules" (
  echo Installing the API's packages ...
  pushd be
  call bun install || exit /b 1
  popd
)
if not exist "fe\node_modules" (
  echo Installing the web app's packages ...
  pushd fe
  call bun install || exit /b 1
  popd
)
echo Starting the API in a new window ...
start "API" /D "%~dp0be" cmd /k bun run dev
cd fe
call bun run dev
exit /b %errorlevel%
