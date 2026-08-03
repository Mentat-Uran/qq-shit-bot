[CmdletBinding()]
param(
    [switch]$NoWatcher,
    [switch]$NoVision,
    [switch]$NoVideo,
    [switch]$AllMedia
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($NoVideo) {
    $AllMedia = $false
}
if ($AllMedia -and $NoVision) {
    throw 'AllMedia requires the Qwen image service; remove -NoVision.'
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$composeFiles = [System.Collections.Generic.List[string]]::new()
$composeFiles.Add('-f')
$composeFiles.Add((Join-Path $scriptDir 'docker-compose.yml'))
$composeFiles.Add('-f')
$composeFiles.Add((Join-Path $scriptDir 'docker-compose.local.yml'))
if ($AllMedia) {
    $composeFiles.Add('-f')
    $composeFiles.Add((Join-Path $scriptDir 'docker-compose.video.yml'))
}
$envFile = Join-Path $scriptDir '.env'
$runtimeDir = Join-Path $scriptDir 'runtime'
$configDir = Join-Path $runtimeDir 'config'
$workspaceLink = Join-Path $runtimeDir 'workspace'
$sourceConfig = Join-Path $scriptDir 'openclaw.json'
$runtimeConfig = Join-Path $configDir 'openclaw.json'
$hermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }
$hermesEnvFile = Join-Path $hermesHome '.env'
$deepSeekSecretFile = Join-Path $hermesHome 'secrets\deepseek-api-key.dpapi'
$legacyVisionVolume = 'local-vision_hermes-vision-model-cache'

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
    if (-not (Test-Path -LiteralPath $hermesEnvFile -PathType Leaf)) {
        throw "Hermes environment file was not found: $hermesEnvFile"
    }

    $mapping = @{
        QQBOT_APP_ID = 'QQ_APP_ID'
        QQBOT_CLIENT_SECRET = 'QQ_CLIENT_SECRET'
        QQBOT_ALLOWED_USER_OPENID = 'QQ_ALLOWED_USERS'
        QQBOT_ALLOWED_MEMBER_OPENID = 'QQ_GROUP_ALLOWED_USERS'
        SENSENOVA_API_KEY = 'SENSENOVA_API_KEY'
    }
    foreach ($target in $mapping.Keys) {
        $source = $mapping[$target]
        $value = Get-DotEnvValue -Path $hermesEnvFile -Name $source
        if ([string]::IsNullOrWhiteSpace($value)) {
            throw "Required Hermes value is missing: $source"
        }
        Set-Item -Path ("Env:{0}" -f $target) -Value $value
    }

    Set-OptionalDeepSeekRuntimeKey

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
    $env:OPENCLAW_GATEWAY_PORT = if ($env:OPENCLAW_GATEWAY_PORT) { $env:OPENCLAW_GATEWAY_PORT } else { '18789' }
}

function Set-OptionalDeepSeekRuntimeKey {
    if (-not [string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY) -and $env:DEEPSEEK_API_KEY -notlike 'replace-with-*') {
        return $true
    }

    $dotenvValue = Get-DotEnvValue -Path $hermesEnvFile -Name 'DEEPSEEK_API_KEY'
    if (-not [string]::IsNullOrWhiteSpace($dotenvValue) -and $dotenvValue -notlike 'replace-with-*') {
        Set-Item -Path 'Env:DEEPSEEK_API_KEY' -Value $dotenvValue
        return $true
    }

    if (-not (Test-Path -LiteralPath $deepSeekSecretFile -PathType Leaf)) {
        return $false
    }

    try {
        $encryptedValue = (Get-Content -LiteralPath $deepSeekSecretFile -Raw -Encoding utf8).Trim()
        $secureValue = ConvertTo-SecureString -String $encryptedValue
        $pointer = [IntPtr]::Zero
        try {
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
            $plainValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
            if ([string]::IsNullOrWhiteSpace($plainValue)) {
                return $false
            }
            Set-Item -Path 'Env:DEEPSEEK_API_KEY' -Value $plainValue
            return $true
        } finally {
            if ($pointer -ne [IntPtr]::Zero) {
                [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
            }
        }
    } catch {
        return $false
    }
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

function Select-QwenModelCache {
    $legacyVolume = & docker volume inspect $legacyVisionVolume 2>$null
    if ($LASTEXITCODE -eq 0 -and $legacyVolume) {
        $env:QWEN_MODEL_CACHE_VOLUME = $legacyVisionVolume
        $env:QWEN_MODEL_CACHE_EXTERNAL = 'true'
    }
}

function Remove-LegacyVisionContainer {
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $inspectionJson = & docker inspect hermes-vision 2>$null
        $inspectExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($inspectExitCode -ne 0 -or -not $inspectionJson) {
        return
    }
    try {
        $inspection = @($inspectionJson | ConvertFrom-Json)[0]
        $image = [string]$inspection.Config.Image
    } catch {
        return
    }
    if ($image -notlike 'ollama/ollama:*') {
        return
    }
    & docker rm -f hermes-vision 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'The legacy hermes-vision container could not be removed after Qwen migration.'
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
    Remove-LegacyVisionContainer
}

function Ensure-RuntimeFiles {
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    if (Test-Path -LiteralPath $workspaceLink) {
        $existing = Get-Item -LiteralPath $workspaceLink -Force
        if ($existing.LinkType -ne 'Junction' -or (($existing.Target | Select-Object -First 1) -ne 'C:\HermesWorkspace')) {
            throw "$workspaceLink exists but is not the expected junction to C:\HermesWorkspace."
        }
    } else {
        New-Item -ItemType Junction -Path $workspaceLink -Target 'C:\HermesWorkspace' | Out-Null
    }
    Copy-Item -LiteralPath $sourceConfig -Destination $runtimeConfig -Force
}

function Ensure-ProactiveReview {
    $homeChannel = Get-DotEnvValue -Path $hermesEnvFile -Name 'QQBOT_HOME_CHANNEL'
    if ([string]::IsNullOrWhiteSpace($homeChannel)) {
        throw 'QQBOT_HOME_CHANNEL is required for the group proactive review job.'
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

    # Daytime: 08:00-02:00, every 10 minutes. The old declaration key is
    # intentionally reused so existing installations are updated in place.
    Register-ProactiveReviewJob `
        -Name 'hermes-qq-proactive-review' `
        -CronExpression '*/10 8-23,0-1 * * *' `
        -DeclarationKey 'hermes-qq-proactive-review' `
        -Description 'Review collected QQ group context every 10 minutes during daytime.'

    # Nighttime: 02:00-08:00, every 30 minutes to reduce model calls.
    Register-ProactiveReviewJob `
        -Name 'hermes-qq-proactive-review-night' `
        -CronExpression '*/30 2-7 * * *' `
        -DeclarationKey 'hermes-qq-proactive-review-night' `
        -Description 'Review collected QQ group context every 30 minutes overnight.'
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker is not available on PATH.'
}
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    throw "Local OpenClaw env file is missing: $envFile"
}
if ($AllMedia -and -not (Test-Path -LiteralPath (Join-Path $scriptDir 'docker-compose.video.yml') -PathType Leaf)) {
    throw 'The Mage-VL and image-fusion compose file is missing.'
}

Set-RuntimeEnvironment
Select-QwenModelCache
Ensure-RuntimeFiles

Push-Location $scriptDir
try {
    Invoke-Compose -Arguments @('config', '--quiet')
    $pullServices = @('openclaw-gateway', 'openclaw-cli')
    if (-not $NoVision) {
        $pullServices += 'qwen-vision'
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
    $mediaMode = if ($NoVision) { 'none' } elseif ($AllMedia) { 'both' } else { 'image' }
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir 'Set-OpenClawMediaCapabilities.ps1') -Mode $mediaMode
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to set OpenClaw media capabilities with exit code $LASTEXITCODE."
    }
    Ensure-QwenService

    if ($AllMedia) {
        # This is an explicit opt-in because both heavyweight bridges share
        # the GPU and may each load several gigabytes of model/runtime state.
        Invoke-Compose -Arguments @('up', '-d', 'video-bridge', 'image-fusion')
    }

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
    Write-Host 'OpenClaw Docker gateway started; all media services are disabled with -NoVision.'
} elseif ($AllMedia) {
    Write-Host 'OpenClaw Docker gateway started; all media services were explicitly enabled with -AllMedia.'
} else {
    Write-Host 'OpenClaw Docker gateway started; only the lightweight Qwen image service is enabled. Use Start-OpenClawVision.ps1 for video or image fusion.'
}
