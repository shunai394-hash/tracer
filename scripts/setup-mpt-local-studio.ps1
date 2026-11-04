[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "TRACER\MoneyPrinterTurbo"),
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA "TRACER\MPTStudioData"),
  [int]$Port = 8765
)

$ErrorActionPreference = "Stop"

function Resolve-Python {
  $candidates = @()
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) {
    $candidates += @{ Command = $py.Source; Args = @("-3.11") }
  }
  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python) {
    $candidates += @{ Command = $python.Source; Args = @() }
  }

  foreach ($candidate in $candidates) {
    $versionText = & $candidate.Command @($candidate.Args) --version 2>&1
    if ($LASTEXITCODE -eq 0 -and "$versionText" -match "Python 3\.(1[1-9]|[2-9][0-9])") {
      return $candidate
    }
  }
  throw "Python 3.11 or later is required. Install Python 3.11+ and rerun this script."
}

if (-not (1024 -le $Port -and $Port -le 65535)) {
  throw "Port must be between 1024 and 65535."
}

$python = Resolve-Python
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
$repoRoot = Split-Path -Parent $PSScriptRoot
$bridge = Join-Path $PSScriptRoot "mpt-local-studio.py"
$venvDir = Join-Path $InstallDir ".venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"
$mptExe = Join-Path $venvDir "Scripts\mpt.exe"
$configTemplate = Join-Path $venvDir "Lib\site-packages\app\_assets\config.example.toml"
$configPath = Join-Path $DataDir "config.toml"

if (-not (Test-Path $bridge -PathType Leaf)) {
  throw "Missing local studio bridge: $bridge"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

if (-not (Test-Path $venvPython -PathType Leaf)) {
  Write-Host "Creating an isolated Python environment..."
  $pythonArgs = $python.Args
  & $python.Command @pythonArgs -m venv $venvDir
  if ($LASTEXITCODE -ne 0) { throw "Failed to create the Python virtual environment." }
}

Write-Host "Installing the official MoneyPrinterTurbo 1.3.9 package..."
& $venvPython -m pip install --disable-pip-version-check --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed." }

& $venvPython -m pip install --disable-pip-version-check "mpt==1.3.9"
if ($LASTEXITCODE -ne 0) { throw "MoneyPrinterTurbo 1.3.9 installation failed." }

if (-not (Test-Path $mptExe -PathType Leaf)) {
  throw "The official mpt.exe launcher was not installed."
}
if (-not (Test-Path $configTemplate -PathType Leaf)) {
  throw "MoneyPrinterTurbo's bundled config template was not found."
}
if (-not (Test-Path $configPath -PathType Leaf)) {
  Copy-Item -LiteralPath $configTemplate -Destination $configPath
}

# Keep all MPT runtime files inside the dedicated local data directory.
$env:MPT_HOME = $DataDir
$env:PYTHONUTF8 = "1"

Write-Host "Checking the installed MoneyPrinterTurbo CLI..."
& $mptExe cli --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw "MoneyPrinterTurbo CLI self-check failed." }

Write-Host ""
Write-Host "MoneyPrinterTurbo 1.3.9 is installed and its CLI responded successfully." -ForegroundColor Green
Write-Host "Studio files: $repoRoot"
Write-Host "Private runtime data: $DataDir"
Write-Host "Local address: http://127.0.0.1:$Port"
Write-Host "Only uploaded local footage/images are used. No paid video API or auto-publishing is enabled."
Write-Host "Stop the studio with Ctrl+C."
Write-Host ""

& $venvPython $bridge --mpt-exe $mptExe --data-dir $DataDir --port $Port
if ($LASTEXITCODE -ne 0) {
  throw "The local studio stopped with exit code $LASTEXITCODE."
}
