# Faz o EMANNU OS abrir sozinho quando você entra no Windows (tarefa do Agendador,
# só para o seu usuário, sem janela). Para desfazer: scripts\iniciar-com-windows.ps1 -Remover
param([switch]$Remover)
$ErrorActionPreference = 'Stop'
$name = 'EMANNU OS'
$root = Split-Path -Parent $PSScriptRoot

if ($Remover) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host 'Início automático removido.' -ForegroundColor Green
  exit 0
}

$node = (Get-Command node).Source
$log = Join-Path $root 'var\logs\servidor.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
# PowerShell escondido inicia o servidor escondido e grava a saída num log.
$cmd = "Set-Location '$root'; Start-Process -FilePath '$node' -ArgumentList '--disable-warning=ExperimentalWarning','apps\server\src\index.ts' -WorkingDirectory '$root' -WindowStyle Hidden -RedirectStandardOutput '$log' -RedirectStandardError '$log.err'"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$cmd`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'Inicia o EMANNU OS v3 ao entrar no Windows' -Force | Out-Null
Write-Host "Pronto: o EMANNU OS vai abrir sozinho quando você entrar no Windows. Log: $log" -ForegroundColor Green
