# Start the web app on Windows (PowerShell). Run its checks and tests with: .\run.ps1 test
param([string]$Task = "run")
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$pm = if (Get-Command npm -ErrorAction SilentlyContinue) { "npm" } elseif (Get-Command bun -ErrorAction SilentlyContinue) { "bun" } else { $null }
if (-not $pm) { throw "Node.js 20 or newer is needed: https://nodejs.org/" }

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing packages ..."
  & $pm install
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if ($Task -eq "test") {
  & $pm run typecheck
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $pm run test
  exit $LASTEXITCODE
}

Write-Host "The web app runs on http://127.0.0.1:5173"
& $pm run dev
exit $LASTEXITCODE
