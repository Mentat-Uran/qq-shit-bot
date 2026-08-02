@echo off
setlocal
set "LAUNCHER=%~dp0HermesMonitorLauncher.ps1"

if not exist "%LAUNCHER%" (
    echo ERROR: Launcher not found:
    echo %LAUNCHER%
    pause
    exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%"
if errorlevel 1 (
    echo.
    echo ERROR: Failed to start Hermes monitor windows.
    pause
    exit /b 1
)

echo.
echo Four Hermes monitor windows have been started.
echo Press any key to close this launcher. The monitor windows will stay open.
pause >nul
exit /b 0
