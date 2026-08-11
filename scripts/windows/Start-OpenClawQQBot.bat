@echo off
setlocal EnableExtensions DisableDelayedExpansion

for %%I in ("%~dp0..\..") do set "PROJECT_DIR=%%~fI"
set "DEPLOY_DIR=%PROJECT_DIR%\deploy\openclaw"
set "ENV_FILE=%DEPLOY_DIR%\.env"
set "RUNTIME_DIR=%DEPLOY_DIR%\runtime"
set "COMPOSE_ARGS=--env-file .env -f docker-compose.yml -f docker-compose.local.yml"
set "PLUGIN_SPEC=@openclaw/qqbot@2026.7.1"
set "QWEN_IMAGE=ollama/ollama:0.32.5"

echo Starting OpenClaw QQ Bot from:
echo %PROJECT_DIR%
echo Default media: local Qwen image understanding only
echo.

if not exist "%ENV_FILE%" (
    echo ERROR: OpenClaw environment file not found:
    echo %ENV_FILE%
    goto :fail
)
if not exist "%DEPLOY_DIR%\docker-compose.yml" (
    echo ERROR: Docker Compose file not found:
    echo %DEPLOY_DIR%\docker-compose.yml
    goto :fail
)
where docker >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker is not available on PATH.
    goto :fail
)

for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    if /i "%%A"=="OPENCLAW_QQBOT_PLUGIN" set "PLUGIN_SPEC=%%B"
    if /i "%%A"=="QWEN_IMAGE" set "QWEN_IMAGE=%%B"
)

call :migrate_env_alias DEEPSEEK_API_KEY HERMES_DEEPSEEK_API_KEY
call :migrate_env_alias QQBOT_HOME_CHANNEL HERMES_QQBOT_HOME_CHANNEL
call :migrate_env_alias QQBOT_HOME_CHANNEL QQBOT_GROUP_OPENID

call :require_env QQBOT_APP_ID replace-with-qq-app-id
if errorlevel 1 goto :fail
call :require_env QQBOT_CLIENT_SECRET replace-with-qq-app-secret
if errorlevel 1 goto :fail
call :require_env SENSENOVA_API_KEY replace-with-sensenova-api-key
if errorlevel 1 goto :fail
call :require_env DEEPSEEK_API_KEY replace-with-deepseek-api-key
if errorlevel 1 goto :fail
call :require_env OPENCLAW_GATEWAY_TOKEN replace-with-a-random-token
if errorlevel 1 goto :fail
call :require_env OPENCLAW_TZ replace-with-timezone
if errorlevel 1 goto :fail

pushd "%DEPLOY_DIR%" || goto :fail

if not exist "runtime\config" mkdir "runtime\config"
if not exist "runtime\workspace" mkdir "runtime\workspace"
copy /y "openclaw.json" "runtime\config\openclaw.json" >nul
if errorlevel 1 goto :fail_after_pushd
copy /y "%DEPLOY_DIR%\bot-workspace\AGENTS.md" "runtime\workspace\AGENTS.md" >nul
if errorlevel 1 goto :fail_after_pushd
copy /y "%PROJECT_DIR%\SOUL.md" "runtime\workspace\SOUL.md" >nul
if errorlevel 1 goto :fail_after_pushd
>"runtime\config\media-capabilities.json" echo {"image":true,"video":false}

echo Validating Docker Compose configuration...
docker compose %COMPOSE_ARGS% config --quiet
if errorlevel 1 goto :fail_after_pushd

echo Pulling required OpenClaw image...
docker compose %COMPOSE_ARGS% pull openclaw-gateway openclaw-cli
if errorlevel 1 goto :fail_after_pushd

echo Preparing local OpenClaw runtime files...
docker compose %COMPOSE_ARGS% run --rm --no-deps qq-diagnostic-filter-init
if errorlevel 1 goto :fail_after_pushd

docker compose %COMPOSE_ARGS% run --rm --no-deps openclaw-cli plugins inspect qqbot --json >nul 2>&1
if errorlevel 1 (
    echo Installing pinned QQ plugin...
    docker compose %COMPOSE_ARGS% run --rm --no-deps openclaw-cli plugins install "%PLUGIN_SPEC%" --force --pin
    if errorlevel 1 goto :fail_after_pushd
)

echo Validating OpenClaw configuration...
docker compose %COMPOSE_ARGS% run --rm --no-deps openclaw-cli config validate
if errorlevel 1 goto :fail_after_pushd

docker image inspect "%QWEN_IMAGE%" >nul 2>&1
if errorlevel 1 (
    echo Pulling Qwen image...
    docker compose %COMPOSE_ARGS% pull qwen-vision
    if errorlevel 1 goto :fail_after_pushd
) else (
    echo Using existing local Qwen image: %QWEN_IMAGE%
)

echo Starting Qwen image service...
docker compose %COMPOSE_ARGS% up -d --pull never qwen-vision
if errorlevel 1 goto :fail_after_pushd

set "QWEN_READY="
for /l %%N in (1,1,30) do (
    if not defined QWEN_READY (
        docker compose %COMPOSE_ARGS% exec -T qwen-vision ollama list >nul 2>&1
        if not errorlevel 1 set "QWEN_READY=1"
        if not defined QWEN_READY timeout /t 2 /nobreak >nul
    )
)
if not defined QWEN_READY (
    echo ERROR: Qwen image service did not become ready.
    goto :fail_after_pushd
)

docker compose %COMPOSE_ARGS% exec -T qwen-vision ollama list | findstr /b /c:"qwen2.5vl:7b" >nul 2>&1
if errorlevel 1 (
    echo Pulling Qwen vision model qwen2.5vl:7b...
    docker compose %COMPOSE_ARGS% exec -T qwen-vision ollama pull qwen2.5vl:7b
    if errorlevel 1 goto :fail_after_pushd
)

echo Starting OpenClaw gateway and context recovery...
docker compose %COMPOSE_ARGS% up -d --pull never --force-recreate openclaw-gateway context-recovery
if errorlevel 1 goto :fail_after_pushd
docker compose %COMPOSE_ARGS% ps openclaw-gateway context-recovery

echo.
echo OpenClaw QQ Bot started.
echo The normal Windows path uses Docker Compose only.
popd
pause
exit /b 0

:require_env
set "CHECK_KEY=%~1"
set "CHECK_PLACEHOLDER=%~2"
findstr /r /b /c:"%CHECK_KEY%=." "%ENV_FILE%" >nul 2>&1
if errorlevel 1 (
    echo ERROR: %CHECK_KEY% is missing from deploy\openclaw\.env.
    exit /b 1
)
findstr /b /c:"%CHECK_KEY%=%CHECK_PLACEHOLDER%" "%ENV_FILE%" >nul 2>&1
if not errorlevel 1 (
    echo ERROR: %CHECK_KEY% still has its placeholder value.
    exit /b 1
)
exit /b 0

:migrate_env_alias
set "CANONICAL_KEY=%~1"
set "LEGACY_KEY=%~2"
findstr /r /b /c:"%CANONICAL_KEY%=." "%ENV_FILE%" >nul 2>&1
if not errorlevel 1 exit /b 0
for /f "usebackq tokens=1,* delims==" %%A in (`findstr /r /b /c:"%LEGACY_KEY%=." "%ENV_FILE%"`) do (
    if not "%%B"=="" >>"%ENV_FILE%" echo %CANONICAL_KEY%=%%B
    exit /b 0
)
exit /b 0

:fail_after_pushd
set "EXIT_CODE=%errorlevel%"
if "%EXIT_CODE%"=="0" set "EXIT_CODE=1"
popd
echo.
echo ERROR: OpenClaw QQ Bot failed to start. Exit code: %EXIT_CODE%
pause
exit /b %EXIT_CODE%

:fail
echo.
echo ERROR: OpenClaw QQ Bot failed to start.
pause
exit /b 1
