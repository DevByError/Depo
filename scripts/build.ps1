# Builds the Depo installers (MSI + NSIS) on Windows.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\build.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
bun install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
bun run check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
bun run build:desktop
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$bundle = "apps\desktop\src-tauri\target\release\bundle"
Write-Host "`nInstallers:" -ForegroundColor Green
Get-ChildItem "$bundle\msi\*.msi", "$bundle\nsis\*.exe" -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $($_.FullName)" }
