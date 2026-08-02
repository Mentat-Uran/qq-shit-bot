[CmdletBinding()]
param(
    [switch]$NoFollow
)

$ErrorActionPreference = 'Stop'

$hermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$hermesExe = Join-Path $hermesHome 'hermes-agent\venv\Scripts\hermes.exe'
$workspace = if ($env:HERMES_WORKSPACE) { $env:HERMES_WORKSPACE } else { $repoRoot }
$recoveryWatcher = Join-Path $PSScriptRoot 'watch-sensenova-v4-recovery.ps1'
$configFile = Join-Path $hermesHome 'config.yaml'
$hermesEnvFile = Join-Path $hermesHome '.env'
$deepSeekSecretFile = Join-Path $hermesHome 'secrets\deepseek-api-key.dpapi'

function Ensure-DeepSeekRuntimeKey {
    $configText = Get-Content -LiteralPath $configFile -Raw -Encoding utf8
    $configIsDeepSeek = $configText -match '(?m)^  provider:\s+deepseek\s*$'
    if (-not [string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY)) {
        return
    }

    if (Test-Path -LiteralPath $hermesEnvFile -PathType Leaf) {
        $line = Get-Content -LiteralPath $hermesEnvFile -Encoding utf8 |
            Where-Object { $_ -match '^\s*DEEPSEEK_API_KEY\s*=' } |
            Select-Object -First 1
        if ($line) {
            $value = ($line -replace '^\s*DEEPSEEK_API_KEY\s*=\s*', '').Trim([char]34).Trim([char]39)
            if (-not [string]::IsNullOrWhiteSpace($value)) {
                $env:DEEPSEEK_API_KEY = $value
                return
            }
        }
    }

    if (-not $configIsDeepSeek -and -not (Test-Path -LiteralPath $deepSeekSecretFile -PathType Leaf)) {
        return
    }

    $secureValue = $null
    if (Test-Path -LiteralPath $deepSeekSecretFile -PathType Leaf) {
        try {
            $encryptedValue = (Get-Content -LiteralPath $deepSeekSecretFile -Raw -Encoding utf8).Trim()
            $secureValue = ConvertTo-SecureString -String $encryptedValue
        } catch {
            $secureValue = $null
        }
    }
    if ($null -eq $secureValue -and -not $configIsDeepSeek) {
        return
    }
    if ($null -eq $secureValue) {
        $secureValue = Read-Host 'Official DeepSeek is active. Enter the API key for this run (not saved)' -AsSecureString
    }
    if ($null -eq $secureValue) {
        throw 'DeepSeek API key is required while the official DeepSeek provider is active.'
    }
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
        $plainValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ([string]::IsNullOrWhiteSpace($plainValue)) {
            throw 'DeepSeek API key is empty.'
        }
        $env:DEEPSEEK_API_KEY = $plainValue
    } finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}

function Start-SenseNovaRecoveryWatcher {
    if (-not (Test-Path -LiteralPath $recoveryWatcher -PathType Leaf)) {
        throw "Recovery watcher not found: $recoveryWatcher"
    }

    $watcherPattern = [regex]::Escape($recoveryWatcher)
    $running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match $watcherPattern } |
        Select-Object -First 1
    if ($running) {
        Write-Host "SenseNova recovery watcher already running (PID $($running.ProcessId))." -ForegroundColor DarkGray
        return
    }

    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', $recoveryWatcher, '-PollSeconds', '60'
    ) | Out-Null
    Write-Host 'SenseNova recovery watcher started in the background.' -ForegroundColor DarkGray
}

try {
    $Host.UI.RawUI.WindowTitle = 'Hermes Gateway - QQ Bot'
    chcp 65001 | Out-Null
    $env:PYTHONUTF8 = '1'
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding

    if (-not (Test-Path -LiteralPath $hermesExe)) {
        throw "Hermes executable not found: $hermesExe"
    }
    if (-not (Test-Path -LiteralPath $workspace -PathType Container)) {
        throw "Hermes workspace not found: $workspace"
    }

    Set-Location -LiteralPath $workspace
    Ensure-DeepSeekRuntimeKey
    Start-SenseNovaRecoveryWatcher
    & $hermesExe gateway start
    if ($LASTEXITCODE -ne 0) {
        throw "Hermes gateway start returned exit code $LASTEXITCODE."
    }

    Start-Sleep -Seconds 2
    & $hermesExe gateway status
    if ($LASTEXITCODE -ne 0) {
        throw "Hermes gateway status returned exit code $LASTEXITCODE."
    }

    Write-Host ''
    Write-Host 'Hermes Gateway is running. Live gateway log follows below.' -ForegroundColor Green
    Write-Host 'Press Ctrl+C to stop following the log.' -ForegroundColor Yellow
    Write-Host 'Closing this window does not stop Hermes Gateway.' -ForegroundColor Yellow
    Write-Host ''

    if ($NoFollow) {
        return
    }

    & $hermesExe logs gateway -f
}
catch {
    Write-Host ''
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'The window will stay open for diagnosis.' -ForegroundColor Yellow
}
