[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "TRACER\MoneyPrinterTurbo"),
  [int]$Port = 8503
)

$ErrorActionPreference = "Stop"

function Get-Python311 {
  foreach ($candidate in @("py -3.11", "python")) {
    $parts = $candidate -split " ", 2
    $command = Get-Command $parts[0] -ErrorAction SilentlyContinue
    if (-not $command) { continue }
    $pythonArgs = @()
    if ($parts.Count -eq 2) { $pythonArgs += $parts[1] }
    $version = & $parts[0] @pythonArgs --version 2>&1
    if ($LASTEXITCODE -ne 0) { continue }
    if ("$version" -match "Python 3\.(1[1-9]|[2-9][0-9])") {
      return @{ Command = $parts[0]; Args = $pythonArgs }
    }
  }
  throw "Python 3.11 or later was not found. Install Python 3.11+ and rerun this script."
}

$python = Get-Python311
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$venvDir = Join-Path $InstallDir ".venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"
$mptExe = Join-Path $venvDir "Scripts\mpt.exe"

if (-not (Test-Path $venvPython)) {
  & $python.Command @($python.Args) -m venv $venvDir
  if ($LASTEXITCODE -ne 0) { throw "Failed to create the isolated Python environment." }
}

& $venvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed." }

# Install the official package maintained by the MoneyPrinterTurbo project.
& $venvPython -m pip install --upgrade mpt
if ($LASTEXITCODE -ne 0) { throw "MoneyPrinterTurbo installation failed." }

if (-not (Test-Path $mptExe)) {
  throw "The mpt launcher was not created at $mptExe."
}

Write-Host ""
Write-Host "MoneyPrinterTurbo is installed locally." -ForegroundColor Green
Write-Host "Web UI: http://127.0.0.1:$Port"
Write-Host "No TRACER credentials or production data were changed."
Write-Host ""

& $mptExe webui --port $Port --headless
