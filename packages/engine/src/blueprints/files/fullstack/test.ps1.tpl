# Run every test on Windows (PowerShell): the API's pytest suite, then the web app's checks and tests.
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
& "$PSScriptRoot\api\run.ps1" test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$PSScriptRoot\web\run.ps1" test
exit $LASTEXITCODE
