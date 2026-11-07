@echo off
rem Start the API (in its own window) and the web app on Windows. Run every test with: test.cmd
setlocal
cd /d "%~dp0"
echo Starting the API in a new window ...
start "API" cmd /k ""%~dp0api\run.cmd""
call "%~dp0web\run.cmd"
exit /b %errorlevel%
