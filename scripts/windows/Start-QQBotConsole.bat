@echo off
setlocal EnableExtensions

for %%I in ("%~dp0..\..") do set "PROJECT_DIR=%%~fI"
set "LAUNCHER=%PROJECT_DIR%\scripts\windows\Start-QQBotConsole.ps1"

if not exist "%LAUNCHER%" (
    echo ERROR: QQ Bot Console launcher not found:
    echo %LAUNCHER%
    pause
    exit /b 1
)

echo Starting local QQ Bot Operations Console from:
echo %PROJECT_DIR%
echo Bind: 127.0.0.1  Port: 18888
echo.

set "POWERSHELL_EXE="
if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not defined POWERSHELL_EXE if exist "%SystemRoot%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe" set "POWERSHELL_EXE=%SystemRoot%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
if not defined POWERSHELL_EXE for /f "delims=" %%P in ('where powershell.exe 2^>nul') do if not defined POWERSHELL_EXE set "POWERSHELL_EXE=%%P"

if not defined POWERSHELL_EXE (
    echo ERROR: Windows PowerShell was not found.
    echo Expected: %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe
    pause
    exit /b 9009
)

"%POWERSHELL_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo ERROR: QQ Bot Operations Console failed to start. Exit code: %EXIT_CODE%
    pause
    exit /b %EXIT_CODE%
)

exit /b 0
