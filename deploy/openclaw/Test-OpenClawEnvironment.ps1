[CmdletBinding()]
param(
    [string]$EnvFile = (Join-Path $PSScriptRoot '.env'),
    [switch]$ApplyMigration,
    [switch]$GenerateGatewayToken,
    [switch]$AllowPlaceholders
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$contractFile = Join-Path $PSScriptRoot 'environment-contract.txt'
if (-not (Test-Path -LiteralPath $contractFile -PathType Leaf)) { throw "Environment contract is missing: $contractFile" }
if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw "Environment file is missing: $EnvFile" }

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
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][string]$Value)
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in Get-Content -LiteralPath $Path -Encoding utf8) { $lines.Add([string]$line) }
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match ("^\s*" + [regex]::Escape($Name) + "\s*=")) {
            $lines[$i] = "$Name=$Value"
            $found = $true
            break
        }
    }
    if (-not $found) { $lines.Add("$Name=$Value") }
    $temp = "$Path.tmp.$PID"
    try {
        [IO.File]::WriteAllText($temp, ($lines -join "`r`n") + "`r`n", [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temp -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
    }
}

function Is-Placeholder([string]$Value) { return [string]::IsNullOrWhiteSpace($Value) -or $Value -like 'replace-with-*' }

$values = Read-DotEnv -Path $EnvFile
if ($ApplyMigration) {
    foreach ($line in Get-Content -LiteralPath $contractFile -Encoding utf8) {
        if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line)) { continue }
        $aliasParts = $line -split '\|'
        if ($aliasParts.Count -ne 2) { continue }
        $alias = @{ Alias = $aliasParts[0]; Canonical = $aliasParts[1] }
        $current = if ($values.ContainsKey($alias.Canonical)) { [string]$values[$alias.Canonical] } else { '' }
        $legacy = if ($values.ContainsKey($alias.Alias)) { [string]$values[$alias.Alias] } else { '' }
        if ((Is-Placeholder $current) -and -not (Is-Placeholder $legacy)) {
            Set-DotEnvValue -Path $EnvFile -Name $alias.Canonical -Value $legacy
            $values[$alias.Canonical] = $legacy
            Write-Host ("Migrated environment alias {0} to {1} (value redacted)." -f $alias.Alias, $alias.Canonical)
        }
    }
}

if ($GenerateGatewayToken) {
    $token = if ($values.ContainsKey('OPENCLAW_GATEWAY_TOKEN')) { [string]$values.OPENCLAW_GATEWAY_TOKEN } else { '' }
    if (Is-Placeholder $token) {
        $bytes = [byte[]]::new(32)
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $token = [Convert]::ToBase64String($bytes)
        Set-DotEnvValue -Path $EnvFile -Name 'OPENCLAW_GATEWAY_TOKEN' -Value $token
        $values.OPENCLAW_GATEWAY_TOKEN = $token
        Write-Host 'Generated OPENCLAW_GATEWAY_TOKEN (value redacted).'
    }
}

$checked = 0
foreach ($line in Get-Content -LiteralPath $contractFile -Encoding utf8) {
    if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line -split '\|', 3
    if ($parts.Count -lt 3 -or $parts[1] -ne 'required') { continue }
    $key = $parts[0]
    $checked++
    $value = if ($values.ContainsKey($key)) { [string]$values[$key] } else { '' }
    if (Is-Placeholder $value) {
        if ($AllowPlaceholders) { Write-Host ("PLACEHOLDER {0} (value redacted)" -f $key) }
        else { throw "Required OpenClaw value is missing or still a placeholder: $key" }
    }
}

Write-Host ("OpenClaw environment validation passed: {0} required entries checked; secrets redacted." -f $checked)
