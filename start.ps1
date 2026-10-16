$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
node --disable-warning=ExperimentalWarning src/server.ts
