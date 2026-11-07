@echo off
rem Start the API on Windows. Run its tests with: run.cmd test
setlocal
cd /d "%~dp0"

set "PY=python"
where py >nul 2>nul && set "PY=py -3"

if not exist ".venv\Scripts\python.exe" (
  echo Creating a virtual environment in .venv ...
  %PY% -m venv .venv || goto :nopython
)
set "VPY=.venv\Scripts\python.exe"
if not exist ".env" copy ".env.example" ".env" >nul

if /i "%~1"=="test" goto :test

"%VPY%" -m pip install -q -r requirements.txt || exit /b 1
"%VPY%" -m app.seed || exit /b 1
if "%PORT%"=="" set "PORT=8000"
echo The API runs on http://127.0.0.1:%PORT% (docs: http://127.0.0.1:%PORT%/docs)
"%VPY%" -m uvicorn app.main:app --reload --host 127.0.0.1 --port %PORT%
exit /b %errorlevel%

:test
"%VPY%" -m pip install -q -r requirements-dev.txt || exit /b 1
"%VPY%" -m pytest -q
exit /b %errorlevel%

:nopython
echo Python 3.10 or newer is needed: https://www.python.org/downloads/ (tick "Add python.exe to PATH").
exit /b 1
