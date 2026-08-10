[CmdletBinding()]
param(
    [ValidateSet('all', 'image')]
    [string]$Mode = 'all'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$composeFiles = @(
    '-f', (Join-Path $scriptDir 'docker-compose.yml'),
    '-f', (Join-Path $scriptDir 'docker-compose.local.yml')
)

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker CLI was not found in PATH.' }

& docker compose @composeFiles stop qwen-vision
if ($LASTEXITCODE -ne 0) { throw "docker compose stop failed with exit code $LASTEXITCODE" }

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir 'Set-OpenClawMediaCapabilities.ps1') -Mode none -RestartGateway
if ($LASTEXITCODE -ne 0) { throw "Failed to disable OpenClaw media capabilities with exit code $LASTEXITCODE" }

& docker compose @composeFiles ps --all qwen-vision
