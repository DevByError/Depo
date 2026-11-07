# Start the API on Windows (PowerShell). Run its tests with: .\run.ps1 test
param([string]$Task = "run")
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  Write-Host "Creating a virtual environment in .venv ..."
  if (Get-Command py -ErrorAction SilentlyContinue) { & py -3 -m venv .venv } else { & python -m venv .venv }
  if ($LASTEXITCODE -ne 0) { throw "Python 3.10 or newer is needed: https://www.python.org/downloads/" }
}
$vpy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }

if ($Task -eq "test") {
  & $vpy -m pip install -q -r requirements-dev.txt
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $vpy -m pytest -q
  exit $LASTEXITCODE
}

& $vpy -m pip install -q -r requirements.txt
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $vpy -m app.seed
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$port = if ($env:PORT) { $env:PORT } else { "8000" }
Write-Host "The API runs on http://127.0.0.1:$port (docs: http://127.0.0.1:$port/docs)"
& $vpy -m uvicorn app.main:app --reload --host 127.0.0.1 --port $port
exit $LASTEXITCODE
