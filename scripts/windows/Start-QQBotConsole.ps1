[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 18888,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectDir = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\..')).Path
Push-Location $projectDir
try {
    function Test-PythonCandidate {
        param([string]$Path)

        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            return $false
        }
        try {
            $versionOutput = & $Path -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
            $processExitCode = $LASTEXITCODE
            $versionText = ($versionOutput | Select-Object -First 1).ToString().Trim()
            $version = [version]$versionText
            return $processExitCode -eq 0 -and $version -ge [version]'3.11'
        } catch {
            return $false
        }
    }

    $pythonCandidates = [System.Collections.Generic.List[string]]::new()
    $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($pythonCommand -and $pythonCommand.Source) {
        $pythonCandidates.Add($pythonCommand.Source)
    }
    $pythonCandidates.Add((Join-Path $env:ProgramData 'Anaconda3\python.exe'))
    $pythonCandidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe'))
    $pythonCandidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'))
    $pythonCandidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'))

    $python = $null
    foreach ($candidate in $pythonCandidates | Select-Object -Unique) {
        if (Test-PythonCandidate $candidate) {
            $python = $candidate
            break
        }
    }
    if (-not $python) {
        [Console]::Error.WriteLine('ERROR: Python 3.11 or newer was not found. Install Python or Anaconda, then retry.')
        exit 9009
    }

    $arguments = @('-m', 'ops_console.server', '--port', [string]$Port)
    if (-not $NoBrowser) {
        $arguments += '--open-browser'
    }
    & $python @arguments
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
