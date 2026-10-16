$ErrorActionPreference = 'Stop'
$taskConsoleUrl = 'http://127.0.0.1:4318'
$taskState = Invoke-RestMethod "$taskConsoleUrl/api/state"
Invoke-RestMethod -Method Post -Uri "$taskConsoleUrl/api/shutdown" -ContentType 'application/json' -Headers @{'X-Console-Token'=$taskState.csrf} -Body '{}' | Out-Null
Write-Output '控制台已请求正常关闭；正在保存工具会话。'
