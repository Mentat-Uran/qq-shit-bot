[CmdletBinding()]
param(
    [int]$PollSeconds = 300
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($PollSeconds -lt 300) {
    $PollSeconds = 300
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$composeFiles = @('-f', (Join-Path $scriptDir 'docker-compose.yml'), '-f', (Join-Path $scriptDir 'docker-compose.local.yml'))
$runtimeConfig = Join-Path $scriptDir 'runtime\config\openclaw.json'
$routeStateFile = Join-Path $scriptDir 'runtime\model-route-state.json'
$mutex = [System.Threading.Mutex]::new($false, 'Global\OpenClawSenseNovaRecoveryWatcher')
if (-not $mutex.WaitOne(0)) {
    exit 0
}

function Invoke-SenseNovaProbe {
    if ([string]::IsNullOrWhiteSpace($env:SENSENOVA_API_KEY)) {
        return [pscustomobject]@{ Available = $false; StatusCode = 0 }
    }
    $headers = @{ Authorization = "Bearer $($env:SENSENOVA_API_KEY)"; 'Content-Type' = 'application/json' }
    $body = @{
        model = 'deepseek-v4-flash'
        messages = @(@{ role = 'user'; content = 'Reply with OK.' })
        max_tokens = 1
        temperature = 0
        stream = $false
    } | ConvertTo-Json -Depth 6
    try {
        $response = Invoke-RestMethod -Uri 'https://token.sensenova.cn/v1/chat/completions' -Headers $headers -Method Post -Body $body -TimeoutSec 45
        $hasChoice = $null -ne $response.choices -and @($response.choices).Count -gt 0
        return [pscustomobject]@{ Available = $hasChoice; StatusCode = 200 }
    } catch {
        $statusCode = 0
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode.value__
        }
        return [pscustomobject]@{ Available = $false; StatusCode = $statusCode }
    }
}

function Get-OpenClawPrimary {
    $config = Get-Content -LiteralPath $runtimeConfig -Raw -Encoding utf8 | ConvertFrom-Json
    return [string]$config.agents.defaults.model.primary
}

function Set-OpenClawPrimary {
    param([Parameter(Mandatory = $true)][string]$Model)
    $config = Get-Content -LiteralPath $runtimeConfig -Raw -Encoding utf8 | ConvertFrom-Json
    if ([string]$config.agents.defaults.model.primary -eq $Model) {
        return $false
    }
    $config.agents.defaults.model.primary = $Model
    $json = $config | ConvertTo-Json -Depth 50
    $tempFile = "$runtimeConfig.tmp.$PID"
    try {
        [System.IO.File]::WriteAllText($tempFile, $json, [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $tempFile -Destination $runtimeConfig -Force
    } finally {
        if (Test-Path -LiteralPath $tempFile) {
            Remove-Item -LiteralPath $tempFile -Force
        }
    }
    Push-Location $scriptDir
    try {
        & docker compose @composeFiles restart openclaw-gateway
        if ($LASTEXITCODE -ne 0) {
            throw "OpenClaw restart failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
    return $true
}

function Set-ModelRouteState {
    param(
        [Parameter(Mandatory = $true)][string]$Primary,
        [Parameter(Mandatory = $true)][bool]$PrimaryAvailable,
        [Parameter(Mandatory = $true)][int]$StatusCode
    )
    $route = if ($PrimaryAvailable) { 'primary-configured' } else { 'fallback-configured' }
    $state = [ordered]@{
        primary = $Primary
        fallback = 'configured-fallback'
        route = $route
        primaryAvailable = $PrimaryAvailable
        statusCode = $StatusCode
        lastProbeAt = [DateTime]::UtcNow.ToString('o')
        evidence = 'watcher probe and configured request fallback; not a QQ delivery proof'
    } | ConvertTo-Json -Depth 4
    $parent = Split-Path -Parent $routeStateFile
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $tempFile = "$routeStateFile.tmp.$PID"
    try {
        [System.IO.File]::WriteAllText($tempFile, $state + "`n", [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $tempFile -Destination $routeStateFile -Force
    } finally {
        if (Test-Path -LiteralPath $tempFile) { Remove-Item -LiteralPath $tempFile -Force }
    }
}

if (-not (Test-Path -LiteralPath $runtimeConfig -PathType Leaf)) {
    exit 0
}

while ($true) {
    try {
        $primary = Get-OpenClawPrimary
        $probe = Invoke-SenseNovaProbe
        Set-ModelRouteState -Primary $primary -PrimaryAvailable $probe.Available -StatusCode $probe.StatusCode
        if ($primary -eq 'sensenova-token/deepseek-v4-flash' -and $probe.StatusCode -eq 429) {
            Write-Host 'SenseNova quota probe returned 429; OpenClaw will use the configured official DeepSeek fallback for failed requests.'
        }
    } catch {
        try {
            Set-ModelRouteState -Primary 'unknown' -PrimaryAvailable $false -StatusCode 0
        } catch {
            # The watcher must continue even when a local state write is unavailable.
        }
        Write-Host 'OpenClaw model route check failed; retrying on the next interval.'
    }
    Start-Sleep -Seconds $PollSeconds
}
