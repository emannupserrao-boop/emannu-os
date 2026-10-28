@echo off
chcp 65001 >nul
title EMANNU OS - acesso pelo celular
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\ativar-celular.ps1"
pause
