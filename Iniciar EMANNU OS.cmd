@echo off
chcp 65001 >nul
title EMANNU OS v3
cd /d "%~dp0"

rem Já está rodando? Só abre o navegador.
powershell -NoProfile -Command "try { Invoke-RestMethod http://127.0.0.1:8850/api/health -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if %errorlevel%==0 (
  echo O EMANNU OS ja esta rodando. Abrindo o navegador...
  start "" http://127.0.0.1:8850
  timeout /t 3 >nul
  exit /b 0
)

if not exist node_modules (
  echo Instalando dependencias pela primeira vez...
  call npm install --no-fund --no-audit || goto erro
)

echo Preparando a interface...
call npm run build --silent || goto erro

echo.
echo EMANNU OS v3 em http://127.0.0.1:8850
echo Deixe esta janela aberta. Para desligar, feche-a ou aperte Ctrl+C.
echo.
start "" http://127.0.0.1:8850
node --disable-warning=ExperimentalWarning apps\server\src\index.ts
goto fim

:erro
echo.
echo Algo deu errado. Tire um print desta janela e mande para o Claude.
:fim
pause
