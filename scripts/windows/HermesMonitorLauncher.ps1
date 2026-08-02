$ErrorActionPreference = 'Stop'

$hermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }
$hermesExe = Join-Path $hermesHome 'hermes-agent\venv\Scripts\hermes.exe'
$pythonExe = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
$watcherPath = Join-Path $PSScriptRoot 'watch-hermes-qq.py'

foreach ($requiredPath in @($hermesExe, $pythonExe, $watcherPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required file not found: $requiredPath"
    }
}

function Start-HermesMonitorWindow {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Title,

        [Parameter(Mandatory = $true)]
        [string]$Body
    )

    $setup = @"
`$env:PYTHONUTF8 = '1'
chcp 65001 | Out-Null
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(`$false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(`$false)
`$OutputEncoding = [Console]::OutputEncoding
`$Host.UI.RawUI.WindowTitle = '$Title'
"@

    $command = $setup + "`r`n" + $Body
    $encodedCommand = [Convert]::ToBase64String(
        [System.Text.Encoding]::Unicode.GetBytes($command)
    )

    Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-NoLogo',
        '-NoProfile',
        '-NoExit',
        '-EncodedCommand',
        $encodedCommand
    ) | Out-Null
}

Start-HermesMonitorWindow -Title 'Hermes - QQ Gateway' -Body "& '$hermesExe' logs gateway -f"
Start-HermesMonitorWindow -Title 'Hermes - Agent Log' -Body "& '$hermesExe' logs -f"
Start-HermesMonitorWindow -Title 'Hermes - Tool Log' -Body "& '$hermesExe' logs -f --component tools"
Start-HermesMonitorWindow -Title 'Hermes - QQ Reply and Reasoning' -Body "& '$pythonExe' -u '$watcherPath'"

Write-Host 'Hermes monitor windows started successfully.'
