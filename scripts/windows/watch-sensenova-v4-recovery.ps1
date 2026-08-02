[CmdletBinding()]
param(
    [int]$PollSeconds = 60
)

$ErrorActionPreference = 'Stop'

$hermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$hermesExe = Join-Path $hermesHome 'hermes-agent\venv\Scripts\hermes.exe'
$workspace = if ($env:HERMES_WORKSPACE) { $env:HERMES_WORKSPACE } else { $repoRoot }
$configFile = Join-Path $hermesHome 'config.yaml'
$envFile = Join-Path $hermesHome '.env'
$deepSeekSecretFile = Join-Path $hermesHome 'secrets\deepseek-api-key.dpapi'
$watcherMutex = [System.Threading.Mutex]::new($false, 'Global\HermesSenseNovaV4RecoveryWatcher')
if (-not $watcherMutex.WaitOne(0)) {
    exit 0
}

function Ensure-DeepSeekRuntimeKey {
    if (-not [string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY)) {
        return $true
    }

    if (Test-Path -LiteralPath $envFile -PathType Leaf) {
        $line = Get-Content -LiteralPath $envFile -Encoding utf8 |
            Where-Object { $_ -match '^\s*DEEPSEEK_API_KEY\s*=' } |
            Select-Object -First 1
        if ($line) {
            $value = ($line -replace '^\s*DEEPSEEK_API_KEY\s*=\s*', '').Trim([char]34).Trim([char]39)
            if (-not [string]::IsNullOrWhiteSpace($value)) {
                $env:DEEPSEEK_API_KEY = $value
                return $true
            }
        }
    }

    if (-not (Test-Path -LiteralPath $deepSeekSecretFile -PathType Leaf)) {
        return $false
    }

    $secureValue = $null
    try {
        $encryptedValue = (Get-Content -LiteralPath $deepSeekSecretFile -Raw -Encoding utf8).Trim()
        $secureValue = ConvertTo-SecureString -String $encryptedValue
    } catch {
        return $false
    }

    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
        $plainValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ([string]::IsNullOrWhiteSpace($plainValue)) {
            return $false
        }
        $env:DEEPSEEK_API_KEY = $plainValue
        return $true
    } finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}

function Get-DotEnvValue {
    param([Parameter(Mandatory = $true)][string]$Name)

    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
        return ''
    }

    $line = Get-Content -LiteralPath $envFile -Encoding utf8 |
        Where-Object { $_ -match ("^\s*" + [regex]::Escape($Name) + "\s*=") } |
        Select-Object -First 1
    if (-not $line) {
        return ''
    }

    return (($line -replace ("^\s*" + [regex]::Escape($Name) + "\s*=\s*"), '').Trim().Trim('"').Trim("'"))
}

function Test-SenseNovaV4 {
    $senseKey = Get-DotEnvValue -Name 'SENSENOVA_API_KEY'
    if ([string]::IsNullOrWhiteSpace($senseKey)) {
        return [pscustomobject]@{ Available = $false; StatusCode = 0 }
    }

    $headers = @{ Authorization = "Bearer $senseKey"; 'Content-Type' = 'application/json' }
    $body = @{
        model = 'deepseek-v4-flash'
        messages = @(@{ role = 'user'; content = 'Reply with OK.' })
        max_tokens = 1
        temperature = 0
        stream = $false
    } | ConvertTo-Json -Depth 6

    try {
        $response = Invoke-RestMethod `
            -Uri 'https://token.sensenova.cn/v1/chat/completions' `
            -Headers $headers `
            -Method Post `
            -Body $body `
            -TimeoutSec 45
        if ($null -ne $response.choices -and @($response.choices).Count -gt 0) {
            return [pscustomobject]@{ Available = $true; StatusCode = 200 }
        }
        return [pscustomobject]@{ Available = $false; StatusCode = 200 }
    } catch {
        $statusCode = 0
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode.value__
        }
        return [pscustomobject]@{ Available = $false; StatusCode = $statusCode }
    } finally {
        $senseKey = $null
        $headers = $null
        $body = $null
    }
}

function Switch-To-DeepSeek {
    $raw = [System.IO.File]::ReadAllText($configFile, [System.Text.Encoding]::UTF8)
    if ($raw -notmatch '(?m)^  provider:\s+sensenova-token\s*$') {
        return $false
    }

    $replacement = @(
        'model:'
        '  default: deepseek-v4-flash'
        '  provider: deepseek'
        "  api_key: ''"
        '  supports_vision: false'
        ''
    ) -join "`r`n"

    $updated = [regex]::Replace(
        $raw,
        '(?ms)\Amodel:\r?\n.*?(?=^providers:\r?\n)',
        $replacement,
        1
    )
    if ($updated -eq $raw -or $updated -notmatch '(?m)^  provider:\s+deepseek\s*$') {
        throw 'Refused to update config because the expected SenseNova model block was not found.'
    }

    $tempFile = $configFile + '.deepseek.tmp'
    try {
        [System.IO.File]::WriteAllText(
            $tempFile,
            $updated,
            [System.Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $tempFile -Destination $configFile -Force
    } finally {
        if (Test-Path -LiteralPath $tempFile) {
            Remove-Item -LiteralPath $tempFile -Force
        }
    }

    Set-Location -LiteralPath $workspace
    & $hermesExe gateway restart | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Hermes gateway restart failed with exit code $LASTEXITCODE."
    }
    return $true
}

function Switch-To-SenseNova {
    $raw = [System.IO.File]::ReadAllText($configFile, [System.Text.Encoding]::UTF8)
    if ($raw -notmatch '(?m)^  provider:\s+deepseek\s*$') {
        return $false
    }

    $replacement = @(
        'model:'
        '  base_url: https://token.sensenova.cn/v1'
        '  default: deepseek-v4-flash'
        '  provider: sensenova-token'
        "  api_key: ''"
        '  supports_vision: false'
        ''
    ) -join "`r`n"

    $updated = [regex]::Replace(
        $raw,
        '(?ms)\Amodel:\r?\n.*?(?=^providers:\r?\n)',
        $replacement,
        1
    )
    $updated = [regex]::Replace(
        $updated,
        '(?m)^    default_model:\s*.*$',
        '    default_model: deepseek-v4-flash',
        1
    )

    if ($updated -eq $raw -or $updated -notmatch '(?m)^  provider:\s+sensenova-token\s*$') {
        throw 'Refused to update config because the expected DeepSeek model block was not found.'
    }

    $tempFile = $configFile + '.sensenova.tmp'
    try {
        [System.IO.File]::WriteAllText(
            $tempFile,
            $updated,
            [System.Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $tempFile -Destination $configFile -Force
    } finally {
        if (Test-Path -LiteralPath $tempFile) {
            Remove-Item -LiteralPath $tempFile -Force
        }
    }

    Set-Location -LiteralPath $workspace
    & $hermesExe gateway restart | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Hermes gateway restart failed with exit code $LASTEXITCODE."
    }
    return $true
}

if ($PollSeconds -lt 60) {
    $PollSeconds = 60
}

Write-Host "SenseNova v4 recovery watcher started; checking every $PollSeconds seconds."
while ($true) {
    try {
        $current = [System.IO.File]::ReadAllText($configFile, [System.Text.Encoding]::UTF8)
        $isDeepSeek = $current -match '(?m)^  provider:\s+deepseek\s*$'
        $isSenseNova = $current -match '(?m)^  provider:\s+sensenova-token\s*$'
        if (-not $isDeepSeek -and -not $isSenseNova) {
            Write-Host 'Primary provider is neither supported switch target; watcher exiting.'
            break
        }

        $probe = Test-SenseNovaV4
        if ($isDeepSeek -and $probe.Available) {
            if (Switch-To-SenseNova) {
                Write-Host 'SenseNova v4 is available; switched primary model back and restarted Hermes.'
            }
        }

        if ($isSenseNova -and -not $probe.Available -and $probe.StatusCode -eq 429) {
            if (-not (Ensure-DeepSeekRuntimeKey)) {
                Write-Host 'SenseNova v4 returned 429, but DEEPSEEK_API_KEY is unavailable; keeping SenseNova and retrying.'
            } elseif (Switch-To-DeepSeek) {
                Write-Host 'SenseNova v4 returned 429; switched primary model to official DeepSeek and restarted Hermes.'
            }
        } elseif ($isSenseNova -and $probe.Available) {
            Write-Host "SenseNova v4 is available; keeping SenseNova as primary. Next check in $PollSeconds seconds."
        } else {
            Write-Host "SenseNova v4 probe did not confirm quota exhaustion; next check in $PollSeconds seconds."
        }
    } catch {
        Write-Host 'SenseNova recovery check failed; will retry.'
    }

    Start-Sleep -Seconds $PollSeconds
}
