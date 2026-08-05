@echo off
setlocal EnableExtensions

for %%I in ("%~dp0..\..") do set "PROJECT_DIR=%%~fI"
set "LAUNCHER=%PROJECT_DIR%\deploy\openclaw\Start-OpenClawDocker.ps1"

if not exist "%LAUNCHER%" (
    echo ERROR: OpenClaw launcher not found:
    echo %LAUNCHER%
    pause
    exit /b 1
)

echo Starting OpenClaw QQ Bot from:
echo %PROJECT_DIR%
echo Default media: local Qwen image understanding only
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo ERROR: OpenClaw QQ Bot failed to start. Exit code: %EXIT_CODE%
    pause
    exit /b %EXIT_CODE%
)

echo.
echo OpenClaw QQ Bot started.
echo Keep this window open for startup diagnostics.
pause >nul
exit /b 0
