@echo off
setlocal EnableExtensions DisableDelayedExpansion

for %%I in ("%~dp0..\..") do set "PROJECT_DIR=%%~fI"
set "ENV_FILE=%PROJECT_DIR%\deploy\openclaw\.env"
set "LAUNCHER=%PROJECT_DIR%\scripts\windows\Start-OpenClawQQBot.bat"

if not exist "%ENV_FILE%" (
    echo ERROR: OpenClaw environment file not found:
    echo %ENV_FILE%
    goto :fail
)
if not exist "%LAUNCHER%" (
    echo ERROR: OpenClaw launcher not found:
    echo %LAUNCHER%
    goto :fail
)

findstr /r /b /c:"QQBOT_APP_ID=." "%ENV_FILE%" >nul 2>&1
if errorlevel 1 (
    echo ERROR: QQBOT_APP_ID is not configured in deploy\openclaw\.env.
    echo Pure BAT mode does not collect QR credentials or echo secret input.
    goto :fail
)
findstr /b /c:"QQBOT_APP_ID=replace-with-qq-app-id" "%ENV_FILE%" >nul 2>&1
if not errorlevel 1 (
    echo ERROR: QQBOT_APP_ID still has its placeholder value.
    goto :fail
)
findstr /r /b /c:"QQBOT_CLIENT_SECRET=." "%ENV_FILE%" >nul 2>&1
if errorlevel 1 (
    echo ERROR: QQBOT_CLIENT_SECRET is not configured in deploy\openclaw\.env.
    echo Pure BAT mode does not collect QR credentials or echo secret input.
    goto :fail
)
findstr /b /c:"QQBOT_CLIENT_SECRET=replace-with-qq-app-secret" "%ENV_FILE%" >nul 2>&1
if not errorlevel 1 (
    echo ERROR: QQBOT_CLIENT_SECRET still has its placeholder value.
    goto :fail
)

echo QQ credentials found in .env; starting without QR rebinding.
call "%LAUNCHER%"
set "EXIT_CODE=%ERRORLEVEL%"
exit /b %EXIT_CODE%

:fail
echo.
echo QQ Bot binding could not continue.
pause
exit /b 1
