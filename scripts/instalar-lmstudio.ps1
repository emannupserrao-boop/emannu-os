# Instala o LM Studio e os 2 modelos do benchmark local (autorizado pelo Emannuel, v3.1 secao 11).
# Roda por tarefa agendada (fora do app do Claude). Antes de cada etapa pesada confere o modo
# jogo no EMANNU OS e espera enquanto ele estiver ativo. Log: var\logs\lmstudio-instalacao.log
param([string[]]$Modelos = @('qwen/qwen3-14b', 'google/gemma-3-12b'))
$ErrorActionPreference = 'Continue'
$raiz = 'D:\Claude Code\emannu-os'
$log = Join-Path $raiz 'var\logs\lmstudio-instalacao.log'
$status = Join-Path $raiz 'var\ferramentas\lmstudio-status.json'
function Log($m) { "$(Get-Date -Format s) $m" | Out-File $log -Append -Encoding utf8 }
function Status($etapa, $ok) { @{ etapa = $etapa; ok = $ok; em = (Get-Date).ToString('s') } | ConvertTo-Json | Out-File $status -Encoding utf8 }
$tok = (Get-Content (Join-Path $raiz 'var\admin-token')).Trim()
function Jogando {
  try { $s = Invoke-RestMethod 'http://127.0.0.1:8850/api/sistema' -Headers @{ 'X-Emannu-Token' = $tok }; return [bool]$s.modoJogo.ativo } catch { return $false }
}
function EsperarSemJogo($etapa) {
  while (Jogando) { Log "modo jogo ativo: $etapa espera"; Status "esperando o fim do jogo ($etapa)" $true; Start-Sleep -Seconds 60 }
}

Log '--- inicio ---'
$app = Join-Path $env:LOCALAPPDATA 'Programs\LM Studio\LM Studio.exe'
if (-not (Test-Path $app)) {
  EsperarSemJogo 'instalacao'
  Status 'instalando o LM Studio' $true
  Log 'winget install ElementLabs.LMStudio'
  winget install --id ElementLabs.LMStudio -e --silent --scope user --accept-package-agreements --accept-source-agreements 2>&1 | Out-File $log -Append -Encoding utf8
}
if (-not (Test-Path $app)) { $app = (Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter 'LM Studio.exe' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName }
if (-not $app) { Log 'ERRO: LM Studio nao encontrado depois da instalacao'; Status 'falhou: LM Studio nao instalou' $false; exit 1 }
Log "app: $app"

# O "lms" (CLI) fica em ~\.lmstudio\bin depois da primeira abertura do app.
$lms = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
if (-not (Test-Path $lms)) {
  Log 'abrindo o LM Studio uma vez para preparar o lms'
  Start-Process $app
  for ($i = 0; $i -lt 60 -and -not (Test-Path $lms); $i++) { Start-Sleep -Seconds 5 }
}
if (-not (Test-Path $lms)) {
  $alt = Get-ChildItem (Split-Path $app) -Recurse -Filter 'lms.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($alt) { & $alt.FullName bootstrap 2>&1 | Out-File $log -Append -Encoding utf8; $lms = $alt.FullName }
}
if (-not (Test-Path $lms)) { Log 'ERRO: lms nao encontrado'; Status 'falhou: lms nao encontrado' $false; exit 1 }
Log "lms: $lms"

# Liga o servico do LM Studio (e o servidor local so em 127.0.0.1:1234) e espera ele responder.
function ServidorOk { try { Invoke-RestMethod 'http://127.0.0.1:1234/v1/models' -TimeoutSec 5 | Out-Null; return $true } catch { return $false } }
Status 'ligando o servico do LM Studio' $true
for ($i = 0; $i -lt 24 -and -not (ServidorOk); $i++) {
  & $lms server start --port 1234 2>&1 | Out-File $log -Append -Encoding utf8
  Start-Sleep -Seconds 5
}
if (-not (ServidorOk)) { Log 'ERRO: servidor local nao subiu'; Status 'falhou: servidor local nao subiu' $false; exit 1 }
Log 'servidor local ok'

foreach ($m in $Modelos) {
  EsperarSemJogo "download de $m"
  Status "baixando $m" $true
  Log "lms get $m"
  & $lms get $m --yes 2>&1 | Out-File $log -Append -Encoding utf8
}

& $lms ls 2>&1 | Out-File $log -Append -Encoding utf8
$ids = @()
try { $ids = (Invoke-RestMethod 'http://127.0.0.1:1234/v1/models').data | ForEach-Object { $_.id } } catch {}
Log ("modelos no servidor: " + ($ids -join ', '))
$faltam = $Modelos | Where-Object { $nome = ($_ -split '/')[-1]; -not ($ids | Where-Object { $_ -like "*$nome*" }) }
if ($faltam) { Log ("ERRO: faltam " + ($faltam -join ', ')); Status ("falhou: faltam " + ($faltam -join ', ')) $false; exit 1 }
Status 'pronto' $true
Log '--- fim ---'
