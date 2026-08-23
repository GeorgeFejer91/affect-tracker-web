param(
  [Parameter(Mandatory = $true)][string]$TemplateManifest,
  [Parameter(Mandatory = $true)][string]$DestinationRoot
)

$ErrorActionPreference = 'Stop'
$catalogPath = Join-Path $PSScriptRoot 'catalog.json'
$catalog = Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json
$template = Get-Content -LiteralPath $TemplateManifest -Raw | ConvertFrom-Json
$mediaRoot = Join-Path $DestinationRoot 'media'
$sessionRoot = Join-Path $DestinationRoot 'sessions'
New-Item -ItemType Directory -Force -Path $mediaRoot, $sessionRoot | Out-Null

$notices = @('Affect Tracker VR optional test media', '')
foreach ($item in $catalog.items) {
  $destination = Join-Path $mediaRoot $item.file
  if (-not (Test-Path -LiteralPath $destination)) {
    Invoke-WebRequest -Uri $item.downloadUrl -OutFile $destination
  }
  $file = Get-Item -LiteralPath $destination
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash.ToLowerInvariant()
  if ($file.Length -ne $item.byteLength -or $hash -ne $item.sha256) {
    throw "Pinned media verification failed: $($item.file)"
  }

  $session = $template | ConvertTo-Json -Depth 20 | ConvertFrom-Json
  $session.sessionId = "sample-$($item.id)"
  $session.video.file = $item.file
  $session.video.byteLength = $item.byteLength
  $session.video.sha256 = $item.sha256
  $session.video.projection = $item.projection
  $session.video.stereo = $item.stereo
  $session.video.loop = $false
  $manifestPath = Join-Path $sessionRoot "$($item.id).json"
  $session | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding utf8

  $notices += "$($item.label) — $($item.license)"
  $notices += "Credit: $($item.credit)"
  $notices += "Source: $($item.sourcePage)"
  $notices += ''
}

$notices | Set-Content -LiteralPath (Join-Path $DestinationRoot 'OPEN-MEDIA-NOTICES.txt') -Encoding utf8
Write-Host "Prepared $($catalog.items.Count) verified choices in $DestinationRoot"
