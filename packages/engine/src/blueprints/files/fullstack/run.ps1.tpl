# Start the API (in its own window) and the web app on Windows. Run every test with: .\test.ps1
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

Write-Host "Starting the API in a new window ..."
$api = Start-Process -FilePath "powershell" -PassThru -ArgumentList @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSScriptRoot\api\run.ps1`""
)
try {
  & "$PSScriptRoot\web\run.ps1"
} finally {
  # Stop the API and everything it started when the web app stops.
  if (-not $api.HasExited) { taskkill /T /F /PID $api.Id | Out-Null }
}
