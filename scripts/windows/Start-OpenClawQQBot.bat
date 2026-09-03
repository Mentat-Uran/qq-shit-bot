@echo off
setlocal EnableExtensions DisableDelayedExpansion

for %%I in ("%~dp0..\..") do set "PROJECT_DIR=%%~fI"
set "DEPLOY_DIR=%PROJECT_DIR%\deploy\openclaw"
set "ENV_FILE=%DEPLOY_DIR%\.env"
set "RUNTIME_DIR=%DEPLOY_DIR%\runtime"
set "COMPOSE_ARGS=--env-file .env -f docker-compose.yml -f docker-compose.local.yml"
set "PLUGIN_SPEC=@tencent-connect/openclaw-qqbot@2.0.3"

echo Starting OpenClaw QQ Bot from:
echo %PROJECT_DIR%
echo Text and image understanding: Codex reverse proxy
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
)

call :migrate_env_alias QQBOT_HOME_CHANNEL HERMES_QQBOT_HOME_CHANNEL
call :migrate_env_alias QQBOT_HOME_CHANNEL QQBOT_GROUP_OPENID

call :require_env QQBOT_APP_ID replace-with-qq-app-id
if errorlevel 1 goto :fail
call :require_env QQBOT_CLIENT_SECRET replace-with-qq-app-secret
if errorlevel 1 goto :fail
call :require_env CODEX_PROXY_BASE_URL replace-with-codex-proxy-base-url
if errorlevel 1 goto :fail
call :require_env CODEX_PROXY_TOKEN replace-with-codex-proxy-token
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

if exist "runtime\config\npm\projects" (
    if not exist "runtime\config\npm\legacy-plugins" mkdir "runtime\config\npm\legacy-plugins"
    for /d %%P in ("runtime\config\npm\projects\*") do (
        if exist "%%~fP\node_modules\@openclaw\qqbot" (
            echo Quarantining legacy QQ plugin project %%~nxP...
            move /Y "%%~fP" "runtime\config\npm\legacy-plugins\" >nul
            if errorlevel 1 goto :fail_after_pushd
        )
    )
)

docker compose %COMPOSE_ARGS% run --rm --no-deps openclaw-cli plugins inspect openclaw-qqbot --json | findstr /c:"2.0.3" >nul 2>&1
if errorlevel 1 (
    echo Installing pinned QQ plugin...
    docker compose %COMPOSE_ARGS% run --rm --no-deps openclaw-cli plugins install "%PLUGIN_SPEC%" --force --pin --accept-capabilities
    if errorlevel 1 goto :fail_after_pushd
)

docker compose %COMPOSE_ARGS% run --rm --no-deps openclaw-cli plugins inspect duckduckgo --json | findstr /c:"2026.8.2" >nul 2>&1
if errorlevel 1 (
    echo Installing pinned DuckDuckGo search plugin...
    docker compose %COMPOSE_ARGS% run --rm --no-deps openclaw-cli plugins install "@openclaw/duckduckgo-plugin@2026.8.2" --force --pin --accept-capabilities
    if errorlevel 1 goto :fail_after_pushd
)

echo Validating OpenClaw configuration...
docker compose %COMPOSE_ARGS% run --rm --no-deps openclaw-cli config validate
if errorlevel 1 goto :fail_after_pushd

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
