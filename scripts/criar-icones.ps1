# Cria os atalhos do EMANNU OS: área de trabalho e menu Iniciar (com ícone próprio)
# e tenta fixar na barra de tarefas. O atalho abre o app numa janela própria
# (modo "app" do navegador padrão, sem barra de endereço).
# Desfazer: scripts\criar-icones.ps1 -Remover
param([switch]$Remover)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$name = 'EMANNU OS'
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) "$name.lnk"
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) "$name.lnk"

if ($Remover) {
  Remove-Item $desktop, $startMenu -ErrorAction SilentlyContinue
  Write-Host 'Atalhos removidos. (Se estiver fixado na barra de tarefas, clique com o botão direito → Desafixar.)' -ForegroundColor Green
  exit 0
}

# Ícone .ico com imagens PNG de 16 a 256 px (aceito pelo Windows desde o Vista).
Add-Type -AssemblyName System.Drawing
$ico = Join-Path $root 'assets\emannu-os.ico'
New-Item -ItemType Directory -Force (Split-Path $ico) | Out-Null
$src = [System.Drawing.Image]::FromFile((Join-Path $root 'apps\web\public\icon-512.png'))
$pngs = foreach ($size in 256, 48, 32, 16) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'
  $g.DrawImage($src, 0, 0, $size, $size); $g.Dispose()
  $ms = New-Object IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  [pscustomobject]@{ Size = $size; Bytes = $ms.ToArray() }
}
$src.Dispose()
$out = New-Object IO.MemoryStream; $w = New-Object IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$pngs.Count)
$offset = 6 + 16 * $pngs.Count
foreach ($p in $pngs) {
  $dim = if ($p.Size -ge 256) { 0 } else { $p.Size }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$p.Bytes.Length); $w.Write([uint32]$offset)
  $offset += $p.Bytes.Length
}
foreach ($p in $pngs) { $w.Write($p.Bytes) }
$w.Flush(); [IO.File]::WriteAllBytes($ico, $out.ToArray()); $w.Dispose()

# Navegador padrão (Brave/Chrome/Edge aceitam --app); o login com PIN do PC já está nele.
$progId = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice' -ErrorAction SilentlyContinue).ProgId
$cmd = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
$browser = if ($cmd -match '^"([^"]+)"') { $Matches[1] } else { $null }
if (-not $browser -or $browser -notmatch '(brave|chrome|msedge)\.exe$') {
  $browser = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
}

$shell = New-Object -ComObject WScript.Shell
foreach ($lnk in $desktop, $startMenu) {
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = $browser
  $s.Arguments = '--app=http://127.0.0.1:8850/'
  $s.WorkingDirectory = $root
  $s.IconLocation = "$ico,0"
  $s.Description = 'EMANNU OS — agentes, objetivos, projetos e imigração'
  $s.Save()
}
Write-Host "Atalhos criados: área de trabalho e menu Iniciar (abre com $(Split-Path $browser -Leaf))." -ForegroundColor Green

# Fixar na barra de tarefas: o Windows 11 não deixa programas fixarem sozinhos.
$verb = (New-Object -ComObject Shell.Application).Namespace((Split-Path $desktop)).ParseName((Split-Path $desktop -Leaf)).Verbs() | Where-Object { $_.Name -replace '&', '' -match 'barra de tarefas|taskbar' } | Select-Object -First 1
if ($verb) { $verb.DoIt(); Write-Host 'Fixado na barra de tarefas.' -ForegroundColor Green }
else { Write-Host 'Para fixar na barra de tarefas: abra o EMANNU OS pelo atalho, clique com o botão direito no ícone dele na barra → "Fixar na barra de tarefas".' -ForegroundColor Yellow }
