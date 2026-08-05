param(
    [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$composeFiles = @(
    '-f', (Join-Path $scriptDir 'docker-compose.yml'),
    '-f', (Join-Path $scriptDir 'docker-compose.local.yml')
)

function Invoke-Compose {
    param([string[]]$Arguments)
    & docker compose @composeFiles @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose failed with exit code $LASTEXITCODE"
    }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI was not found in PATH.'
}

$upArgs = @('up', '-d')
if ($NoBuild) {
    $upArgs += '--no-build'
}
$upArgs += 'qwen-vision'
Invoke-Compose -Arguments $upArgs
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir 'Set-OpenClawMediaCapabilities.ps1') -Mode image -RestartGateway
if ($LASTEXITCODE -ne 0) {
    throw "Failed to set OpenClaw media capabilities with exit code $LASTEXITCODE"
}
Invoke-Compose -Arguments @('up', '-d', '--no-deps', '--force-recreate', 'openclaw-gateway', 'context-recovery')
Invoke-Compose -Arguments @('ps', 'qwen-vision')
