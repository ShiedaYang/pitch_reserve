$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
node --disable-warning=ExperimentalWarning scripts/stop-server.ts
exit $LASTEXITCODE
