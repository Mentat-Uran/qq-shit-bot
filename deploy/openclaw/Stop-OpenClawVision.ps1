param(
    [ValidateSet('all', 'image', 'video')]
    [string]$Mode = 'all'
)$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$composeFiles = @(
    '-f', (Join-Path $scriptDir 'docker-compose.yml'),
    '-f', (Join-Path $scriptDir 'docker-compose.local.yml'),
    '-f', (Join-Path $scriptDir 'docker-compose.video.yml')
)

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI was not found in PATH.'
}

switch ($Mode) {
    'image' { $services = @('qwen-vision', 'image-fusion') }
    'video' { $services = @('video-bridge') }
    default { $services = @('qwen-vision', 'image-fusion', 'video-bridge') }
}
& docker compose @composeFiles stop $services
if ($LASTEXITCODE -ne 0) {
    throw "docker compose stop failed with exit code $LASTEXITCODE"
}

$imageRunning = $false
foreach ($service in @('qwen-vision', 'image-fusion')) {
    $running = docker ps --filter "label=com.docker.compose.service=$service" --format '{{.Names}}'
    if ($running) { $imageRunning = $true }
}
# The retired video-bridge and image-fusion services never contribute to the
# capability profile anymore; only the in-project Qwen image path can be live.
$capabilityMode = if ($imageRunning) { 'image' } else { 'none' }
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir 'Set-OpenClawMediaCapabilities.ps1') -Mode $capabilityMode -RestartGateway
if ($LASTEXITCODE -ne 0) {
    throw "Failed to set OpenClaw media capabilities with exit code $LASTEXITCODE"
}
& docker compose @composeFiles ps --all qwen-vision image-fusion video-bridge
