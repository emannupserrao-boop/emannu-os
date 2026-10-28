# Liga o acesso pelo celular via Tailscale (HTTPS só dentro da sua rede privada).
# Usa apenas "tailscale serve". NUNCA usa "tailscale funnel" (que exporia o PC à internet).
$ErrorActionPreference = 'Stop'
$port = 8850

$ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $ts) { $ts = 'C:\Program Files\Tailscale\tailscale.exe' }
if (-not (Test-Path $ts)) {
  Write-Host 'O Tailscale não está instalado neste PC. Baixe em https://tailscale.com/download/windows' -ForegroundColor Red
  exit 1
}

$status = & $ts status --json | ConvertFrom-Json
if ($status.BackendState -ne 'Running') {
  Write-Host "O Tailscale não está conectado (estado: $($status.BackendState)). Abra o Tailscale e entre na sua conta." -ForegroundColor Red
  exit 1
}
if (-not $status.CertDomains -or $status.CertDomains.Count -eq 0) {
  Write-Host 'Falta ligar os certificados HTTPS: abra https://login.tailscale.com/admin/dns e clique em "Enable HTTPS".' -ForegroundColor Yellow
  exit 1
}

try { Invoke-RestMethod "http://127.0.0.1:$port/api/health" | Out-Null } catch {
  Write-Host 'O EMANNU OS não está rodando. Abra "Iniciar EMANNU OS.cmd" e rode este script de novo.' -ForegroundColor Red
  exit 1
}

& $ts serve --bg $port | Out-Host
$url = "https://$($status.CertDomains[0])/"
Write-Host ''
Write-Host "Pronto. No celular (com o Tailscale ligado), abra no Chrome:" -ForegroundColor Green
Write-Host "  $url" -ForegroundColor Green
Write-Host ''
& $ts serve status | Out-Host
