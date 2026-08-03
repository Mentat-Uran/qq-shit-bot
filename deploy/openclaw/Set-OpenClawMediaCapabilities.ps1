[CmdletBinding()]
param(
    [ValidateSet('none', 'image', 'video', 'both')]
    [string]$Mode = 'none',
    [switch]$RestartGateway
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceConfig = Join-Path $scriptDir 'openclaw.json'
$runtimeConfig = Join-Path $scriptDir 'runtime\config\openclaw.json'
$capabilityFile = Join-Path $scriptDir 'runtime\config\media-capabilities.json'

if (-not (Test-Path -LiteralPath $sourceConfig -PathType Leaf)) {
    throw "Source OpenClaw config is missing: $sourceConfig"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $runtimeConfig) | Out-Null

$config = Get-Content -LiteralPath $sourceConfig -Raw -Encoding utf8 | ConvertFrom-Json
$imageEnabled = $Mode -in @('image', 'both')
$videoEnabled = $Mode -in @('video', 'both')

if (-not $imageEnabled) {
    $config.agents.defaults.PSObject.Properties.Remove('imageModel')
    $config.models.providers.PSObject.Properties.Remove('local-vision')
}

$media = $config.tools.media
if ($imageEnabled -and $videoEnabled) {
    # Keep the canonical source media configuration.
} elseif ($imageEnabled) {
    $media.PSObject.Properties.Remove('video')
} elseif ($videoEnabled) {
    $media.PSObject.Properties.Remove('models')
} else {
    $config.tools.PSObject.Properties.Remove('media')
}

$capabilityText = switch ($Mode) {
    'none' { '[Runtime media capability policy] Image and video services are disabled. Never claim to have seen an image, read image text, or watched a video. Explicitly say that the corresponding local capability is disabled.' }
    'image' { '[Runtime media capability policy] Only image understanding is enabled. Use local image results for images and OCR, but never claim to read or understand video.' }
    'video' { '[Runtime media capability policy] Only video understanding is enabled. Use local video results for video, but never claim to read images or image text.' }
    'both' { '[Runtime media capability policy] Image and video understanding are enabled. Answer only from the actual local model result and clearly state when the result is unavailable or uncertain.' }
}
$groupPrompt = [string]$config.channels.qqbot.groups.'*'.prompt
$config.channels.qqbot.groups.'*'.prompt = ($groupPrompt + "`n`n" + $capabilityText)

$json = $config | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText($runtimeConfig, $json + "`n", [System.Text.UTF8Encoding]::new($false))
$capabilities = @{ image = $imageEnabled; video = $videoEnabled } | ConvertTo-Json
[System.IO.File]::WriteAllText($capabilityFile, $capabilities + "`n", [System.Text.UTF8Encoding]::new($false))

if ($RestartGateway) {
    $gatewayNames = @(
        (& docker ps --filter 'label=com.docker.compose.service=openclaw-gateway' --format '{{.Names}}'),
        (& docker ps --filter 'label=com.docker.compose.service=context-recovery' --format '{{.Names}}')
    ) | Where-Object { $_ }
    if ($gatewayNames) {
        & docker restart $gatewayNames
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to restart OpenClaw containers with exit code $LASTEXITCODE"
        }
    }
}

Write-Host "OpenClaw media capabilities set to '$Mode' (image=$imageEnabled, video=$videoEnabled)."
