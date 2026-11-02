[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$InputJson,
  [string]$OutputDirectory = ".\artifacts\eleven-v4"
)
$ErrorActionPreference = "Stop"
$baseUrl = $env:TRACER_BASE_URL
$adminToken = $env:TRACER_ADMIN_TOKEN
$voiceId = $env:ELEVENLABS_VOICE_ID
if ([string]::IsNullOrWhiteSpace($baseUrl)) { throw "TRACER_BASE_URL is not set." }
if ([string]::IsNullOrWhiteSpace($adminToken)) { throw "TRACER_ADMIN_TOKEN is not set." }
if ([string]::IsNullOrWhiteSpace($voiceId)) { throw "ELEVENLABS_VOICE_ID is not set." }
$uri = [Uri]$baseUrl
if ($uri.Scheme -ne "https" -and -not ($uri.IsLoopback -and $uri.Scheme -eq "http")) { throw "TRACER_BASE_URL must use HTTPS (HTTP is allowed only for loopback)." }
$clips = ConvertFrom-Json -InputObject (Get-Content -LiteralPath $InputJson -Raw -Encoding UTF8)
if ($clips -isnot [System.Array] -or $clips.Count -lt 1) { throw "Input JSON must be a non-empty array of { id, text } objects." }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$headers = @{ Authorization = "Bearer $adminToken" }
$endpoint = "$($baseUrl.TrimEnd('/'))/api/admin/ai-live/eleven-v4-turbo"
$completed = 0
foreach ($clip in $clips) {
  $id = [string]$clip.id
  $text = [string]$clip.text
  if ($id -notmatch '^[A-Za-z0-9_-]{1,48}$') { throw "Clip id must contain only letters, numbers, underscores, or hyphens (max 48)." }
  if ([string]::IsNullOrWhiteSpace($text) -or $text.Length -gt 1200) { throw "Clip '$id' must contain 1–1200 characters." }
  $body = @{ text = $text; voiceId = $voiceId } | ConvertTo-Json -Compress
  $outputPath = Join-Path $OutputDirectory "$id.mp3"
  try {
    Invoke-WebRequest -Uri $endpoint -Method Post -Headers $headers -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body)) -OutFile $outputPath -TimeoutSec 35
  } catch {
    if (Test-Path -LiteralPath $outputPath) { Remove-Item -LiteralPath $outputPath -Force }
    throw "ElevenLabs generation failed for clip '$id'. No automatic retry was attempted. Check endpoint status; sensitive response details were suppressed."
  }
  $file = Get-Item -LiteralPath $outputPath
  if ($file.Length -lt 128) { Remove-Item -LiteralPath $outputPath -Force; throw "Clip '$id' returned an unexpectedly small audio file. Stopped without retry." }
  $completed++
  Write-Host "Generated $id.mp3 ($($file.Length) bytes)"
}
Write-Host "Completed $completed audio clip(s). Files remain local in: $OutputDirectory"
