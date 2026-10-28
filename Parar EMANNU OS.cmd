@echo off
chcp 65001 >nul
title Parar EMANNU OS
rem Encerra o servidor do EMANNU OS (e agentes que estiverem rodando por ele).
rem Para abrir de novo: Iniciar EMANNU OS.cmd (ou entrar no Windows de novo).
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'apps.server.src.index\.ts' }; if (-not $p) { Write-Host 'O EMANNU OS nao estava rodando.' } else { foreach ($x in $p) { taskkill /PID $x.ProcessId /T /F | Out-Null }; Write-Host 'EMANNU OS encerrado.' }"
timeout /t 3 >nul
