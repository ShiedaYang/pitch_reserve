param([switch]$Lan, [switch]$Local)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if ($Lan -and $Local) { throw 'Choose either -Lan or -Local.' }
$startupArgs = @()
if ($Lan) { $startupArgs += '--lan' }
if ($Local) { $startupArgs += '--local' }
node --disable-warning=ExperimentalWarning scripts/start-server.ts @startupArgs
exit $LASTEXITCODE
