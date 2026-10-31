# Checks the tools Depo needs to build on Windows, then installs JavaScript dependencies.
# Usage (from the repo root):  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
$ErrorActionPreference = "Stop"
$ok = $true

function Check($name, $test, $hint) {
  if (& $test) { Write-Host "  [ok]      $name" -ForegroundColor Green }
  else { Write-Host "  [missing] $name  ->  $hint" -ForegroundColor Yellow; $script:ok = $false }
}

Write-Host "Checking prerequisites for Depo..."
Check "Bun 1.4+" { Get-Command bun -ErrorAction SilentlyContinue } 'powershell -c "irm bun.sh/install.ps1 | iex"'
Check "Rust (MSVC toolchain)" { (Get-Command rustc -ErrorAction SilentlyContinue) -and ((rustc -vV) -match "host: .*-pc-windows-msvc") } "Install from https://rustup.rs (default host: x86_64-pc-windows-msvc)"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
Check "Visual Studio C++ build tools" { (Test-Path $vswhere) -and (& $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath) } "Install 'Visual Studio 2022 Build Tools' with 'Desktop development with C++'"
$wv = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
$wvUser = "HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
Check "WebView2 runtime" { (Test-Path $wv) -or (Test-Path $wvUser) } "Preinstalled on Windows 11; otherwise https://developer.microsoft.com/microsoft-edge/webview2/"
Check "Git for Windows (optional now, needed from Phase 1)" { Get-Command git -ErrorAction SilentlyContinue } "https://git-scm.com/download/win"

if (-not $ok) {
  Write-Host "`nInstall the missing tools above, open a new terminal, and run this script again." -ForegroundColor Yellow
  exit 1
}

Write-Host "`nInstalling dependencies..."
bun install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "`nReady. Next steps:" -ForegroundColor Green
Write-Host "  bun run check          lint, type-check and unit tests"
Write-Host "  bun run tauri:dev      run the desktop app in development"
Write-Host "  bun run build:desktop  build the MSI and NSIS installers"
