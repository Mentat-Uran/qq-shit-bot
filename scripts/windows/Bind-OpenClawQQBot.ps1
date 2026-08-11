[CmdletBinding()]
param(
    [string]$EnvFile,
    [switch]$ForceQr,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $EnvFile = Join-Path $PSScriptRoot '..\..\deploy\openclaw\.env'
}

$projectDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$scriptDir = (Resolve-Path (Join-Path $projectDir 'deploy\openclaw')).Path
$runtimeDir = Join-Path $scriptDir 'runtime'
$configDir = Join-Path $runtimeDir 'config'
$workspaceDir = Join-Path $runtimeDir 'workspace'
$sourceConfig = Join-Path $scriptDir 'openclaw.json'
$sourceBotAgents = Join-Path $scriptDir 'bot-workspace\AGENTS.md'
$runtimeConfigPath = Join-Path $configDir 'openclaw.json'
$composeFiles = @(
    '-f', (Join-Path $scriptDir 'docker-compose.yml'),
    '-f', (Join-Path $scriptDir 'docker-compose.local.yml')
)

function Read-DotEnv {
    param([Parameter(Mandatory = $true)][string]$Path)

    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path -Encoding utf8) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $value = $Matches[2].Trim()
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            $values[$Matches[1]] = $value
        }
    }
    return $values
}

function Set-DotEnvValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Value
    )

    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in Get-Content -LiteralPath $Path -Encoding utf8) {
        $lines.Add([string]$line)
    }
    $found = $false
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match ("^\s*" + [regex]::Escape($Name) + "\s*=")) {
            $lines[$index] = "$Name=$Value"
            $found = $true
            break
        }
    }
    if (-not $found) {
        $lines.Add("$Name=$Value")
    }

    $tempFile = "$Path.tmp.$PID"
    try {
        [IO.File]::WriteAllText($tempFile, ($lines -join "`r`n") + "`r`n", [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $tempFile -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $tempFile) {
            Remove-Item -LiteralPath $tempFile -Force
        }
    }
}

function Write-JsonAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )

    $tempFile = "$Path.tmp.$PID"
    try {
        $json = $Value | ConvertTo-Json -Depth 100
        [IO.File]::WriteAllText($tempFile, $json + "`r`n", [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $tempFile -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $tempFile) {
            Remove-Item -LiteralPath $tempFile -Force
        }
    }
}

function Is-Placeholder([string]$Value) {
    return [string]::IsNullOrWhiteSpace($Value) -or $Value -like 'replace-with-*'
}

function Get-PropertyValue {
    param(
        [AllowNull()][object]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Read-PlainValue {
    param([Parameter(Mandatory = $true)][string]$Name)

    $value = Read-Host -Prompt $Name
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "$Name cannot be empty."
    }
    return $value.Trim()
}

function Read-SecretValue {
    param([Parameter(Mandatory = $true)][string]$Name)

    Write-Host ("NOTE: no characters are echoed while typing; press Enter when done. Paste with Ctrl+Shift+V or right-click. [{0}]" -f $Name)
    $secure = Read-Host -Prompt "$Name (input is hidden)" -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $secure.Dispose()
    }
}

function Invoke-Compose {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    Push-Location $scriptDir
    try {
        & docker compose @composeFiles @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Docker Compose failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
}

function Ensure-RuntimeFiles {
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    New-Item -ItemType Directory -Force -Path $workspaceDir | Out-Null
    Copy-Item -LiteralPath $sourceConfig -Destination $runtimeConfigPath -Force
    Copy-Item -LiteralPath $sourceBotAgents -Destination (Join-Path $workspaceDir 'AGENTS.md') -Force
    Copy-Item -LiteralPath (Join-Path $projectDir 'SOUL.md') -Destination (Join-Path $workspaceDir 'SOUL.md') -Force
}

function Enable-TemporaryQrPlugin {
    $config = Get-Content -LiteralPath $runtimeConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
    $allow = @($config.plugins.allow)
    $allow = @($allow | Where-Object { $_ -ne 'qqbot' })
    if (-not ($allow -contains 'openclaw-qqbot')) {
        $allow += 'openclaw-qqbot'
    }
    $config.plugins.allow = $allow
    $entry = Get-PropertyValue -Object $config.plugins.entries -Name 'qqbot'
    if ($null -ne $entry) {
        $entry.enabled = $false
    }
    $qrEntry = Get-PropertyValue -Object $config.plugins.entries -Name 'openclaw-qqbot'
    if ($null -eq $qrEntry) {
        $config.plugins.entries | Add-Member -NotePropertyName 'openclaw-qqbot' -NotePropertyValue ([pscustomobject]@{ enabled = $true })
    } else {
        $qrEntry.enabled = $true
    }
    Write-JsonAtomic -Path $runtimeConfigPath -Value $config
}

function Get-QrCredentials {
    $config = Get-Content -LiteralPath $runtimeConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
    $qqbot = Get-PropertyValue -Object $config.channels -Name 'qqbot'
    $accounts = [System.Collections.Generic.List[object]]::new()
    if ($null -ne $qqbot) {
        $accounts.Add($qqbot)
        $accountMap = Get-PropertyValue -Object $qqbot -Name 'accounts'
        if ($null -ne $accountMap) {
            foreach ($property in $accountMap.PSObject.Properties) {
                $accounts.Add($property.Value)
            }
        }
    }

    foreach ($account in $accounts) {
        $appIdValue = Get-PropertyValue -Object $account -Name 'appId'
        $secretValue = Get-PropertyValue -Object $account -Name 'clientSecret'
        $appId = if ($appIdValue -is [string]) { $appIdValue.Trim() } else { '' }
        $secret = if ($secretValue -is [string]) { $secretValue } else { '' }
        if (-not (Is-Placeholder $appId) -and -not (Is-Placeholder $secret)) {
            $userOpenId = ''
            foreach ($allowItem in @((Get-PropertyValue -Object $account -Name 'allowFrom'))) {
                $candidate = [string]$allowItem
                if (-not [string]::IsNullOrWhiteSpace($candidate) -and $candidate -ne '*' -and $candidate -notlike '${*}') {
                    $userOpenId = $candidate.Trim()
                    break
                }
            }
            return [pscustomobject]@{
                AppId = $appId
                ClientSecret = $secret
                UserOpenId = $userOpenId
            }
        }
    }
    throw 'QR login completed, but no QQ Bot credentials were found in the temporary runtime config.'
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker is not available on PATH.'
}
if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    throw "Environment file not found: $EnvFile"
}

$values = Read-DotEnv -Path $EnvFile
$needsQr = $ForceQr -or
    (Is-Placeholder ([string]$values['QQBOT_APP_ID'])) -or
    (Is-Placeholder ([string]$values['QQBOT_CLIENT_SECRET']))
$qrCredentials = $null
$temporaryPluginInstalled = $false
$cleanupFailed = $false

if ($needsQr) {
    Write-Host 'Starting one-time QQ QR binding. Scan the QR code with the QQ mobile app.'
    Ensure-RuntimeFiles
    try {
        Invoke-Compose -Arguments @('run', '--rm', '--no-deps', 'qq-diagnostic-filter-init')
        Invoke-Compose -Arguments @('run', '--rm', '--no-deps', 'openclaw-cli', 'plugins', 'install', '@tencent-connect/openclaw-qqbot@2.0.0', '--force', '--pin')
        $temporaryPluginInstalled = $true
        Enable-TemporaryQrPlugin
        Invoke-Compose -Arguments @('run', '--rm', '--no-deps', 'openclaw-cli', 'channels', 'login', '--channel', 'qqbot')
        $qrCredentials = Get-QrCredentials
        Write-Host 'QR credentials captured locally; values are redacted.'
    } finally {
        if ($temporaryPluginInstalled) {
            try {
                Invoke-Compose -Arguments @('run', '--rm', '--no-deps', 'openclaw-cli', 'plugins', 'uninstall', 'openclaw-qqbot', '--force')
            } catch {
                $cleanupFailed = $true
            }
        }
        Copy-Item -LiteralPath $sourceConfig -Destination $runtimeConfigPath -Force
    }
    if ($cleanupFailed) {
        throw 'The temporary QR plugin could not be removed; the formal Bot launcher was not started.'
    }

    Set-DotEnvValue -Path $EnvFile -Name 'QQBOT_APP_ID' -Value $qrCredentials.AppId
    Set-DotEnvValue -Path $EnvFile -Name 'QQBOT_CLIENT_SECRET' -Value $qrCredentials.ClientSecret
    $values['QQBOT_APP_ID'] = $qrCredentials.AppId
    $values['QQBOT_CLIENT_SECRET'] = $qrCredentials.ClientSecret
    if (-not [string]::IsNullOrWhiteSpace($qrCredentials.UserOpenId) -and (Is-Placeholder ([string]$values['QQBOT_ALLOWED_USER_OPENID']))) {
        Set-DotEnvValue -Path $EnvFile -Name 'QQBOT_ALLOWED_USER_OPENID' -Value $qrCredentials.UserOpenId
        $values['QQBOT_ALLOWED_USER_OPENID'] = $qrCredentials.UserOpenId
        Write-Host 'QQ user allowlist was filled from the QR login event; value is redacted.'
    }
} else {
    Write-Host 'QQ credentials already exist in .env; skipping QR binding.'
}

$fields = @(
    @{ Name = 'SENSENOVA_API_KEY'; Secret = $true },
    @{ Name = 'DEEPSEEK_API_KEY'; Secret = $true }
)
foreach ($field in $fields) {
    $current = if ($values.ContainsKey($field.Name)) { [string]$values[$field.Name] } else { '' }
    if (-not (Is-Placeholder $current)) {
        Write-Host ("{0} is present; keeping it hidden." -f $field.Name)
        continue
    }
    $newValue = if ($field.Secret) { Read-SecretValue -Name $field.Name } else { Read-PlainValue -Name $field.Name }
    Set-DotEnvValue -Path $EnvFile -Name $field.Name -Value $newValue
    $values[$field.Name] = $newValue
    Write-Host ("{0} saved to local .env; value redacted." -f $field.Name)
}

$validator = Join-Path $scriptDir 'Test-OpenClawEnvironment.ps1'
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $validator -EnvFile $EnvFile -ApplyMigration -GenerateGatewayToken
if ($LASTEXITCODE -ne 0) {
    throw "Environment validation failed; the Bot was not started. Exit code: $LASTEXITCODE"
}

Write-Host 'QQ Bot binding configuration passed validation; secrets were not printed.'
if (-not $NoStart) {
    $launcher = Join-Path $projectDir 'scripts\windows\Start-OpenClawQQBot.bat'
    Write-Host 'Calling the formal Start-OpenClawQQBot.bat launcher.'
    & cmd.exe /d /c ("call `"{0}`"" -f $launcher)
    if ($LASTEXITCODE -ne 0) {
        throw "The formal launcher failed. Exit code: $LASTEXITCODE"
    }
}
