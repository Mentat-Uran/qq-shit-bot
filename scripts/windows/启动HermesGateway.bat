@echo off
setlocal
set "LAUNCHER=%~dp0StartHermesGatewayWindow.ps1"

if not exist "%LAUNCHER%" (
    echo ERROR: Launcher not found:
    echo %LAUNCHER%
    pause
    exit /b 1
)

if /I "%~1"=="--self-test" goto selftest

powershell.exe -NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "%LAUNCHER%"
exit /b %ERRORLEVEL%

:selftest
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%" -NoFollow
exit /b %ERRORLEVEL%
