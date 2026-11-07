@echo off
rem Run every test on Windows: the API's pytest suite, then the web app's type check and tests.
setlocal
cd /d "%~dp0"
call "%~dp0api\run.cmd" test || exit /b 1
call "%~dp0web\run.cmd" test
exit /b %errorlevel%
