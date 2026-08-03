param(
    [switch]$NoBuild,
    [ValidateSet('both', 'image', 'video')]
    [string]$Mode = 'both'
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$composeFiles = @(
    '-f', (Join-Path $scriptDir 'docker-compose.yml'),
    '-f', (Join-Path $scriptDir 'docker-compose.local.yml'),
    '-f', (Join-Path $scriptDir 'docker-compose.video.yml')
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

# Reuse the existing Ollama model cache when this deployment is migrated from
# the former local-vision project. This avoids downloading the 7B model again.
$legacyVisionVolume = 'local-vision_hermes-vision-model-cache'
$legacyVolumeExists = $false
& docker volume inspect $legacyVisionVolume *> $null
if ($LASTEXITCODE -eq 0) {
    $legacyVolumeExists = $true
}

if ($legacyVolumeExists) {
    $env:QWEN_MODEL_CACHE_VOLUME = $legacyVisionVolume
    $env:QWEN_MODEL_CACHE_EXTERNAL = 'true'
}

$upArgs = @('up', '-d')
if ($NoBuild) {
    $upArgs += '--no-build'
}
$services = switch ($Mode) {
    'image' { @('qwen-vision', 'image-fusion') }
    'video' { @('video-bridge') }
    default { @('qwen-vision', 'image-fusion', 'video-bridge') }
}
$servicesToStop = @('qwen-vision', 'image-fusion', 'video-bridge') | Where-Object { $_ -notin $services }
if ($servicesToStop) {
    Invoke-Compose -Arguments (@('stop') + $servicesToStop)
}
$upArgs += $services
Invoke-Compose -Arguments $upArgs
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir 'Set-OpenClawMediaCapabilities.ps1') -Mode $Mode -RestartGateway
if ($LASTEXITCODE -ne 0) {
    throw "Failed to set OpenClaw media capabilities with exit code $LASTEXITCODE"
}
Invoke-Compose -Arguments (@('ps') + $services)
