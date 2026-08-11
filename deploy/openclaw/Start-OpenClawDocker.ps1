[CmdletBinding()]
param(
    [switch]$NoWatcher,
    [switch]$NoVision
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$composeFiles = [System.Collections.Generic.List[string]]::new()
$composeFiles.Add('-f')
$composeFiles.Add((Join-Path $scriptDir 'docker-compose.yml'))
$composeFiles.Add('-f')
$composeFiles.Add((Join-Path $scriptDir 'docker-compose.local.yml'))
$envFile = Join-Path $scriptDir '.env'
$runtimeDir = Join-Path $scriptDir 'runtime'
$configDir = Join-Path $runtimeDir 'config'
$workspaceLink = Join-Path $runtimeDir 'workspace'
$sourceConfig = Join-Path $scriptDir 'openclaw.json'
$sourceBotAgents = Join-Path $scriptDir 'bot-workspace\AGENTS.md'
$runtimeConfig = Join-Path $configDir 'openclaw.json'

function Get-DotEnvValue {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Name)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return ''
    }
    $line = Get-Content -LiteralPath $Path -Encoding utf8 |
        Where-Object { $_ -match ("^\s*" + [regex]::Escape($Name) + "\s*=") } |
        Select-Object -First 1
    if (-not $line) {
        return ''
    }
    return (($line -replace ("^\s*" + [regex]::Escape($Name) + "\s*=\s*"), '').Trim().Trim('"').Trim("'"))
}

function Set-DotEnvValue {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][string]$Value)

    $lines = [System.Collections.Generic.List[string]]::new()
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        foreach ($line in Get-Content -LiteralPath $Path -Encoding utf8) {
            $lines.Add([string]$line)
        }
    }
    $prefix = "$Name="
    $replaced = $false
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match ("^\s*" + [regex]::Escape($Name) + "\s*=")) {
            $lines[$index] = $prefix + $Value
            $replaced = $true
            break
        }
    }
    if (-not $replaced) {
        $lines.Add($prefix + $Value)
    }
    $tempFile = "$Path.tmp.$PID"
    try {
        [System.IO.File]::WriteAllText($tempFile, ($lines -join "`r`n") + "`r`n", [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $tempFile -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $tempFile) {
            Remove-Item -LiteralPath $tempFile -Force
        }
    }
}

function Set-RuntimeEnvironment {
    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
        throw "OpenClaw environment file was not found: $envFile"
    }

    foreach ($target in @('QQBOT_APP_ID', 'QQBOT_CLIENT_SECRET', 'SENSENOVA_API_KEY', 'DEEPSEEK_API_KEY')) {
        $value = Get-DotEnvValue -Path $envFile -Name $target
        if ([string]::IsNullOrWhiteSpace($value)) {
            throw "Required OpenClaw value is missing: $target"
        }
        Set-Item -Path ("Env:{0}" -f $target) -Value $value
    }

    $plugin = Get-DotEnvValue -Path $envFile -Name 'OPENCLAW_QQBOT_PLUGIN'
    $env:OPENCLAW_QQBOT_PLUGIN = if ($plugin) { $plugin } else { '@openclaw/qqbot@2026.7.1' }

    $storedGatewayToken = Get-DotEnvValue -Path $envFile -Name 'OPENCLAW_GATEWAY_TOKEN'
    if ([string]::IsNullOrWhiteSpace($env:OPENCLAW_GATEWAY_TOKEN) -or $env:OPENCLAW_GATEWAY_TOKEN -like 'replace-with-*') {
        if (-not [string]::IsNullOrWhiteSpace($storedGatewayToken) -and $storedGatewayToken -notlike 'replace-with-*') {
            $env:OPENCLAW_GATEWAY_TOKEN = $storedGatewayToken
        }
    }
    if ([string]::IsNullOrWhiteSpace($env:OPENCLAW_GATEWAY_TOKEN) -or $env:OPENCLAW_GATEWAY_TOKEN -like 'replace-with-*') {
        $bytes = [byte[]]::new(32)
        $rng = [System.Security.Cryptography.RNGCryptoServiceProvider]::new()
        try {
            $rng.GetBytes($bytes)
        } finally {
            $rng.Dispose()
        }
        $env:OPENCLAW_GATEWAY_TOKEN = [Convert]::ToBase64String($bytes)
        Set-DotEnvValue -Path $envFile -Name 'OPENCLAW_GATEWAY_TOKEN' -Value $env:OPENCLAW_GATEWAY_TOKEN
    }
    $configuredPort = Get-DotEnvValue -Path $envFile -Name 'OPENCLAW_GATEWAY_PORT'
    $env:OPENCLAW_GATEWAY_PORT = if ($configuredPort) { $configuredPort } else { '18789' }
}

function Invoke-Compose {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & docker compose @composeFiles @Arguments
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0) {
        throw "Docker Compose failed with exit code $exitCode."
    }
}

function Test-DockerImageAvailable {
    param([Parameter(Mandatory = $true)][string]$Image)

    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & docker image inspect $Image *> $null
        return ($LASTEXITCODE -eq 0)
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
}

function Ensure-QwenService {
    if ($NoVision) {
        return
    }
    Invoke-Compose -Arguments @('up', '-d', 'qwen-vision')

    $ready = $false
    $modelList = ''
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $previousErrorAction = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $modelList = (& docker compose @composeFiles exec -T qwen-vision ollama list 2>$null | Out-String)
            $qwenExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorAction
        }
        if ($qwenExitCode -eq 0) {
            $ready = $true
            break
        }
        Start-Sleep -Seconds 2
    }
    if (-not $ready) {
        throw 'The OpenClaw qwen-vision service did not become ready.'
    }

    if ($modelList -notmatch '(?m)^qwen2\.5vl:7b\s') {
        Invoke-Compose -Arguments @('exec', '-T', 'qwen-vision', 'ollama', 'pull', 'qwen2.5vl:7b')
    }
}

function Ensure-RuntimeFiles {
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    New-Item -ItemType Directory -Force -Path $workspaceLink | Out-Null
    Copy-Item -LiteralPath $sourceConfig -Destination $runtimeConfig -Force
    Copy-Item -LiteralPath $sourceBotAgents -Destination (Join-Path $workspaceLink 'AGENTS.md') -Force
    Copy-Item -LiteralPath (Join-Path $scriptDir '..\..\SOUL.md') -Destination (Join-Path $workspaceLink 'SOUL.md') -Force
}

function Ensure-ProactiveReview {
    $enabled = Get-DotEnvValue -Path $envFile -Name 'QQBOT_PROACTIVE_REVIEW_ENABLED'
    if ($enabled -ne 'true') {
        Write-Host 'QQBOT_PROACTIVE_REVIEW_ENABLED is not true; skipping the group proactive review job registration.'
        return
    }
    $homeChannel = Get-DotEnvValue -Path $envFile -Name 'QQBOT_HOME_CHANNEL'
    if ([string]::IsNullOrWhiteSpace($homeChannel) -or $homeChannel -like 'replace-with-*') {
        Write-Host 'QQBOT_HOME_CHANNEL is not set; skipping the group proactive review job registration.'
        return
    }

    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $null = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/healthz" -f $env:OPENCLAW_GATEWAY_PORT) -TimeoutSec 3
            $ready = $true
            break
        } catch {
            Start-Sleep -Seconds 2
        }
    }
    if (-not $ready) {
        throw 'OpenClaw did not become ready before the proactive review job was registered.'
    }

    $promptFile = Join-Path $scriptDir 'proactive-review-prompt.txt'
    if (-not (Test-Path -LiteralPath $promptFile -PathType Leaf)) {
        throw "Proactive review prompt file is missing: $promptFile"
    }
    $prompt = (Get-Content -LiteralPath $promptFile -Raw -Encoding utf8).Trim()
    $sessionKey = "agent:main:qqbot:group:$homeChannel"
    $target = "qqbot:group:$homeChannel"
    Start-Sleep -Seconds 8

    function Register-ProactiveReviewJob {
        param(
            [Parameter(Mandatory = $true)][string]$Name,
            [Parameter(Mandatory = $true)][string]$CronExpression,
            [Parameter(Mandatory = $true)][string]$DeclarationKey,
            [Parameter(Mandatory = $true)][string]$Description
        )

        $cronArguments = [System.Collections.Generic.List[string]]::new()
        $cronArguments.Add('exec')
        $cronArguments.Add('-T')
        $cronArguments.Add('openclaw-gateway')
        $cronArguments.Add('node')
        $cronArguments.Add('dist/index.js')
        $cronArguments.Add('cron')
        $cronArguments.Add('add')
        $cronArguments.Add($Name)
        $cronArguments.Add('--cron')
        $cronArguments.Add($CronExpression)
        $cronArguments.Add('--tz')
        $cronArguments.Add('Asia/Shanghai')
        $cronArguments.Add('--exact')
        $cronArguments.Add('--message')
        $cronArguments.Add($prompt)
        $cronArguments.Add('--session-key')
        $cronArguments.Add($sessionKey)
        $cronArguments.Add('--announce')
        $cronArguments.Add('--channel')
        $cronArguments.Add('qqbot')
        $cronArguments.Add('--to')
        $cronArguments.Add($target)
        $cronArguments.Add('--best-effort-deliver')
        $cronArguments.Add('--description')
        $cronArguments.Add($Description)
        $cronArguments.Add('--declaration-key')
        $cronArguments.Add($DeclarationKey)
        $cronArguments.Add('--timeout-seconds')
        $cronArguments.Add('180')

        $registrationError = $null
        for ($attempt = 0; $attempt -lt 4; $attempt++) {
            try {
                Invoke-Compose -Arguments $cronArguments.ToArray()
                $registrationError = $null
                break
            } catch {
                $registrationError = $_
                if ($attempt -lt 3) {
                    Start-Sleep -Seconds 5
                }
            }
        }
        if ($null -ne $registrationError) {
            throw $registrationError
        }
    }

    # Daytime: 08:00-02:00, every 10 minutes.
    Register-ProactiveReviewJob `
        -Name 'qqbot-proactive-review' `
        -CronExpression '*/10 8-23,0-1 * * *' `
        -DeclarationKey 'qqbot-proactive-review' `
        -Description 'Review collected QQ group context every 10 minutes during daytime.'

    # Nighttime: 02:00-08:00, every 30 minutes to reduce model calls.
    Register-ProactiveReviewJob `
        -Name 'qqbot-proactive-review-night' `
        -CronExpression '*/30 2-7 * * *' `
        -DeclarationKey 'qqbot-proactive-review-night' `
        -Description 'Review collected QQ group context every 30 minutes overnight.'
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker is not available on PATH.'
}
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    throw "Local OpenClaw env file is missing: $envFile"
}

$environmentValidator = Join-Path $scriptDir 'Test-OpenClawEnvironment.ps1'
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $environmentValidator -EnvFile $envFile -ApplyMigration -GenerateGatewayToken
if ($LASTEXITCODE -ne 0) {
    throw "OpenClaw environment validation failed with exit code $LASTEXITCODE."
}
Set-RuntimeEnvironment
Ensure-RuntimeFiles

Push-Location $scriptDir
try {
    Invoke-Compose -Arguments @('config', '--quiet')
    $pullServices = @('openclaw-gateway', 'openclaw-cli')
    if (-not $NoVision) {
        $qwenImage = $env:QWEN_IMAGE
        if ([string]::IsNullOrWhiteSpace($qwenImage)) {
            $qwenImage = Get-DotEnvValue -Path $envFile -Name 'QWEN_IMAGE'
        }
        if ([string]::IsNullOrWhiteSpace($qwenImage)) {
            $qwenImage = 'ollama/ollama:0.32.5'
        }
        if (Test-DockerImageAvailable -Image $qwenImage) {
            Write-Host "Using existing local Qwen image: $qwenImage"
        } else {
            $pullServices += 'qwen-vision'
        }
    }
    Invoke-Compose -Arguments (@('pull') + $pullServices)
    Invoke-Compose -Arguments @('run', '--rm', '--no-deps', 'qq-diagnostic-filter-init')

    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $null = & docker compose @composeFiles run --rm --no-deps openclaw-cli plugins inspect qqbot --json 2>$null
        $inspectExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($inspectExitCode -ne 0) {
        Invoke-Compose -Arguments @('run', '--rm', '--no-deps', 'openclaw-cli', 'plugins', 'install', $env:OPENCLAW_QQBOT_PLUGIN, '--force', '--pin')
    }
    Invoke-Compose -Arguments @('run', '--rm', '--no-deps', 'openclaw-cli', 'config', 'validate')
    $mediaMode = if ($NoVision) { 'none' } else { 'image' }
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir 'Set-OpenClawMediaCapabilities.ps1') -Mode $mediaMode
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to set OpenClaw media capabilities with exit code $LASTEXITCODE."
    }
    Ensure-QwenService

    $portInUse = Get-NetTCPConnection -LocalPort ([int]$env:OPENCLAW_GATEWAY_PORT) -State Listen -ErrorAction SilentlyContinue
    if ($portInUse) {
        throw "Port $($env:OPENCLAW_GATEWAY_PORT) is already in use; refusing to start a second gateway."
    }
    Invoke-Compose -Arguments @('up', '-d', '--force-recreate', 'openclaw-gateway', 'context-recovery')
    Invoke-Compose -Arguments @('ps', 'openclaw-gateway', 'context-recovery')
    Ensure-ProactiveReview
} finally {
    Pop-Location
}

if (-not $NoWatcher) {
    $watcher = Join-Path $scriptDir 'Watch-OpenClawModel.ps1'
    Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList @(
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $watcher
    ) | Out-Null
}

if ($NoVision) {
    Write-Host 'OpenClaw Docker gateway started; image understanding is disabled with -NoVision.'
} else {
    Write-Host 'OpenClaw Docker gateway started; Qwen image understanding is enabled.'
}
