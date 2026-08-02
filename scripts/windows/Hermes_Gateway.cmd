@echo off
rem Hermes Agent Gateway - Messaging Platform Integration
cd /d "%~dp0\..\.."
set "HERMES_HOME=%LOCALAPPDATA%\hermes"
set "PYTHONIOENCODING=utf-8"
set "HERMES_GATEWAY_DETACHED=1"
set "VIRTUAL_ENV=%HERMES_HOME%\hermes-agent\venv"
set "SENSENOVA_WATCHER=%~dp0watch-sensenova-v4-recovery.ps1"
if exist "%SENSENOVA_WATCHER%" powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File','%SENSENOVA_WATCHER%','-PollSeconds','60')"
"%HERMES_HOME%\hermes-agent\venv\Scripts\pythonw.exe" -m hermes_cli.main gateway run
exit /b 0
