[CmdletBinding()]
param(
  [ValidateSet('Host', 'Launcher', 'Session', 'Polar', 'Full', 'Soak')]
  [string]$Gate = 'Host',
  [string]$DeviceSerial,
  [int]$MarkerTimeoutSeconds = 90,
  [ValidateRange(120, 3600)]
  [int]$PolarStabilitySeconds = 120,
  [int]$SoakMinutes = 30,
  [int]$KeepAwakeDurationMilliseconds = 3600000,
  [string]$ExpectedAdmittedApkSha256,
  [string]$EvidenceDirectory,
  [string]$Node = "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe",
  [string]$Cargo = "$env:USERPROFILE\.cargo\bin\cargo.exe",
  [string]$DotNet = "$env:USERPROFILE\.cache\quest-ion-able\dotnet\dotnet.exe",
  [string]$Adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
  [string]$Qfm = "$env:USERPROFILE\Documents\GitHub\QuestIonAble-File-Manager\src\QuestIonAbleFileManager.Cli\bin\Debug\net10.0\questionable-file-manager.dll"
)

$ErrorActionPreference = 'Stop'
$project = $PSScriptRoot
$repository = Split-Path $project -Parent
$apk = Join-Path $project 'app\build\outputs\apk\debug\app-debug.apk'
$nativeLibrary = Join-Path $project 'native-lsl\target\jniLibs\arm64-v8a\libaffect_tracker_vr_lsl.so'
$package = 'io.github.georgefejer91.affecttracker.vr'
$readinessTag = 'AffectTrackerReady'
$polarTag = 'AffectTrackerPolar'

function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$Label) {
  Write-Host "[gate] $Label"
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}

function Invoke-Adb([string[]]$Arguments) {
  & $Adb '-s' $DeviceSerial @Arguments
  if ($LASTEXITCODE -ne 0) { throw "ADB command failed: $($Arguments -join ' ')" }
}

function Invoke-Qfm([string[]]$Arguments) {
  if ([System.IO.Path]::GetExtension($Qfm) -eq '.dll') {
    if (-not (Test-Path -LiteralPath $DotNet)) { throw "Pinned .NET host not found: $DotNet" }
    $output = & $DotNet $Qfm @Arguments
  } else {
    $output = & $Qfm @Arguments
  }
  if ($LASTEXITCODE -ne 0) { throw "QFM command failed: $($Arguments -join ' ')" }
  return $output
}

function Read-ReadinessLog {
  return (& $Adb '-s' $DeviceSerial 'logcat' '-d' '-v' 'brief' '-s' "$readinessTag`:V" '*:S' 2>&1) -join "`n"
}

function Read-PolarLog {
  return (& $Adb '-s' $DeviceSerial 'logcat' '-d' '-v' 'brief' '-s' "$polarTag`:V" '*:S' 2>&1) -join "`n"
}

function Wait-ForMarker([string]$Pattern, [int]$TimeoutSeconds = $MarkerTimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $log = Read-ReadinessLog
    if ($log -match $Pattern) { return $log }
    Start-Sleep -Milliseconds 750
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for app-owned marker: $Pattern"
}

function Wait-ForPolarMarker([string]$Pattern, [int]$TimeoutSeconds = $MarkerTimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $log = Read-PolarLog
    if ($log -match $Pattern) { return $log }
    Start-Sleep -Milliseconds 750
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for Polar app-owned marker: $Pattern"
}

function Get-PolarHealthReceipts([string]$Log) {
  $pattern = 'status=stream-health sampleCount=(?<count>[0-9]+) streamEpoch=(?<epoch>[0-9]+) observedRateHz=(?<rate>unavailable|[0-9]+(?:\.[0-9]+)?) latestSampleAgeMs=(?<age>-?[0-9]+) sampleRateHz=(?<configured>[0-9]+) resolutionBits=(?<resolution>[0-9]+) heartRateAvailable=(?<hr>true|false) rrAvailable=(?<rr>true|false) heartRateAgeMs=(?<hrAge>-?[0-9]+) rrAgeMs=(?<rrAge>-?[0-9]+) finiteMetrics=(?<metrics>none|[a-z0-9_,]+) ready=(?<ready>true|false)'
  foreach ($match in [regex]::Matches($Log, $pattern)) {
    [pscustomobject]@{
      SampleCount = [long]$match.Groups['count'].Value
      StreamEpoch = [long]$match.Groups['epoch'].Value
      ObservedRateHz = if ($match.Groups['rate'].Value -eq 'unavailable') { $null } else { [double]::Parse($match.Groups['rate'].Value, [Globalization.CultureInfo]::InvariantCulture) }
      LatestSampleAgeMs = [long]$match.Groups['age'].Value
      SampleRateHz = [int]$match.Groups['configured'].Value
      ResolutionBits = [int]$match.Groups['resolution'].Value
      HeartRateAvailable = $match.Groups['hr'].Value -eq 'true'
      RrAvailable = $match.Groups['rr'].Value -eq 'true'
      HeartRateAgeMs = [long]$match.Groups['hrAge'].Value
      RrAgeMs = [long]$match.Groups['rrAge'].Value
      FiniteMetrics = @($match.Groups['metrics'].Value -split ',' | Where-Object { $_ -ne 'none' })
      Ready = $match.Groups['ready'].Value -eq 'true'
    }
  }
}

function Save-Screenshot([string]$Path) {
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Adb
  foreach ($argument in @('-s', $DeviceSerial, 'exec-out', 'screencap', '-p')) { [void]$start.ArgumentList.Add($argument) }
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $process = [System.Diagnostics.Process]::Start($start)
  $stream = [System.IO.File]::Create($Path)
  try { $process.StandardOutput.BaseStream.CopyTo($stream) } finally { $stream.Dispose() }
  $process.WaitForExit()
  if ($process.ExitCode -ne 0 -or (Get-Item -LiteralPath $Path).Length -lt 4096) { throw 'Quest screenshot capture failed.' }
}

$jdk = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "$env:USERPROFILE\.gradle\jdks\temurin-17" }
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:USERPROFILE\.cache\affect-tracker-vr\android-sdk" }
$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:ANDROID_NDK_HOME = Join-Path $sdk 'ndk\27.0.12077973'
$env:PATH = "$(Join-Path $jdk 'bin');$env:PATH"

if ([string]::IsNullOrWhiteSpace($ExpectedAdmittedApkSha256)) {
  Write-Host '[tier 1/5] Source, contract, parity, and simulated-soak tests'
  if (-not (Test-Path -LiteralPath $Node)) {
    $nodeCommand = Get-Command 'node.exe' -ErrorAction SilentlyContinue
    if ($nodeCommand) { $Node = $nodeCommand.Source } else { throw "Node.js not found: $Node" }
  }
  Push-Location $repository
  try { Invoke-Checked $Node @('--test') 'web/desktop/Quest shared contract tests' } finally { Pop-Location }
  if (-not (Test-Path -LiteralPath $Cargo)) { throw "Cargo not found: $Cargo" }
  Invoke-Checked $Cargo @('test', '--locked', '--manifest-path', (Join-Path $project 'native-lsl\Cargo.toml')) 'Rust LSL schema tests'

  Write-Host '[tier 2/5] Native build, Android compile, lint, and package'
  Invoke-Checked 'pwsh.exe' @('-NoProfile', '-File', (Join-Path $project 'build-native-lsl.ps1'), '-Profile', 'release') 'arm64-v8a LSL JNI build'
  Push-Location $project
  try { Invoke-Checked (Join-Path $project 'gradlew.bat') @(':app:testDebugUnitTest', ':app:lintDebug', ':app:assembleDebug', '--offline') 'locked Android verification build' } finally { Pop-Location }
} else {
  Write-Host '[tier 1-2/5] Reusing an explicitly hash-bound host-admitted APK; no recompilation'
  if ($ExpectedAdmittedApkSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'ExpectedAdmittedApkSha256 must contain exactly 64 hexadecimal characters.' }
}
if (-not (Test-Path -LiteralPath $nativeLibrary)) { throw 'arm64-v8a JNI library is missing.' }
if (-not (Test-Path -LiteralPath $apk)) { throw 'debug APK is missing.' }
$apkSha256 = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ExpectedAdmittedApkSha256 -and $apkSha256 -ne $ExpectedAdmittedApkSha256.ToLowerInvariant()) { throw 'APK bytes differ from ExpectedAdmittedApkSha256; rerun Host admission.' }

Write-Host '[tier 3/5] Immutable APK admission'
if (-not (Test-Path -LiteralPath $Qfm)) { throw "QFM CLI not found: $Qfm" }
$inspect = Invoke-Qfm @('apk', 'inspect', '--file', $apk, '--json')
$inspectText = $inspect -join "`n"
if ($inspectText -notmatch [regex]::Escape($package) -or $inspectText -notmatch $apkSha256) { throw 'Inspected APK identity or hash does not match Affect Tracker VR.' }

if ($Gate -eq 'Host') {
  Write-Host "READINESS PASS: Host gates. APK SHA-256 $apkSha256"
  exit 0
}

if ([string]::IsNullOrWhiteSpace($DeviceSerial)) { throw 'DeviceSerial is required beyond the Host gate.' }
if (-not (Test-Path -LiteralPath $Adb)) { $Adb = Join-Path $sdk 'platform-tools\adb.exe' }
if (-not (Test-Path -LiteralPath $Adb)) { throw "ADB not found: $Adb" }
if (-not $EvidenceDirectory) {
  $EvidenceDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("affect-tracker-vr-readiness-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
if (Test-Path -LiteralPath $EvidenceDirectory) { throw 'EvidenceDirectory must be a new path.' }
[void](New-Item -ItemType Directory -Path $EvidenceDirectory)
[void](Invoke-Adb @('logcat', '-c'))

Write-Host '[tier 4/5] Exact-device preflight, deployment, and visible launcher'
$awake = Invoke-Qfm @('device', 'keep-awake', '--serial', $DeviceSerial, '--on', '--duration-ms', $KeepAwakeDurationMilliseconds.ToString(), '--confirm-device-settings', '--json', '--adb', $Adb)
$awake | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'keep-awake.json') -Encoding utf8
$preflight = Invoke-Qfm @('apk', 'preflight', '--serial', $DeviceSerial, '--file', $apk, '--adb', $Adb, '--json')
$preflight | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'preflight.json') -Encoding utf8
$preflightObject = ($preflight -join "`n") | ConvertFrom-Json
if ($preflightObject.result.InstalledMatch -eq 'exact' -and $preflightObject.result.ReadyForLaunch) {
  Write-Host '[tier 4/5] Exact bytes are already installed; launching without reinstalling'
  $launch = Invoke-Qfm @('apk', 'launch', '--serial', $DeviceSerial, '--file', $apk, '--adb', $Adb, '--json')
  $launch | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'launch.json') -Encoding utf8
} else {
  $deploy = Invoke-Qfm @('apk', 'deploy', '--serial', $DeviceSerial, '--file', $apk, '--adb', $Adb, '--json')
  $deploy | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'deploy.json') -Encoding utf8
}

$activityState = (Invoke-Adb @('shell', 'dumpsys', 'activity', 'activities')) -join "`n"
$activityState | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'activity-state.txt') -Encoding utf8
$topResumedActivities = ($activityState -split "`r?`n") | Where-Object { $_ -match 'topResumedActivity=' }
if (($topResumedActivities -join "`n") -match 'OculusLinkAvailableDialogActivity') {
  throw "Meta's Enable Link dialog is covering the app. Press Not now in the headset, then rerun this gate."
}
$launcherLog = Wait-ForMarker 'launcher_rendered'
$launcherLog | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'launcher-log.txt') -Encoding utf8
$ui = (Invoke-Adb @('exec-out', 'uiautomator', 'dump', '/dev/tty')) -join "`n"
$ui | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'launcher-ui.xml') -Encoding utf8
Save-Screenshot (Join-Path $EvidenceDirectory 'launcher.png')
if ($ui -notmatch 'Affect Tracker VR' -or $ui -notmatch 'Start experiment') { throw 'Launcher process ran, but required UI text was not observed by the consuming UI runtime.' }
if ($Gate -eq 'Launcher') { Write-Host "READINESS PASS: visible launcher. Evidence: $EvidenceDirectory"; exit 0 }

if ($Gate -eq 'Polar') {
  $polarSessionLog = Wait-ForMarker 'session_ready session='
  $polarSessionLog | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'polar-session-ready-log.txt') -Encoding utf8
  Write-Host '[Polar gate] ATTENDED ACTION REQUIRED: wear/moisten the H10, close competing Polar apps, press Connect H10, and grant the nearby-device permission in the headset.'
  $readyPolarLog = Wait-ForPolarMarker 'status=state-updated .*sampleRateHz=130 resolutionBits=14 .*ready=true readinessReason=ready'
  $initialReceipts = @(Get-PolarHealthReceipts $readyPolarLog)
  if ($initialReceipts.Count -eq 0) {
    $readyPolarLog = Wait-ForPolarMarker 'status=stream-health .*sampleRateHz=130 resolutionBits=14 .*ready=true'
    $initialReceipts = @(Get-PolarHealthReceipts $readyPolarLog)
  }
  $initialReceipt = $initialReceipts[-1]
  $initialSampleCount = $initialReceipt.SampleCount
  $initialStreamEpoch = $initialReceipt.StreamEpoch
  $readyPolarLog | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'polar-initial-ready-log.txt') -Encoding utf8
  [void](Invoke-Adb @('logcat', '-c'))
  Write-Host "[Polar gate] Ready at sample $initialSampleCount; observing $PolarStabilitySeconds seconds of sanitized liveness receipts."
  $polarDeadline = (Get-Date).AddSeconds($PolarStabilitySeconds)
  while ((Get-Date) -lt $polarDeadline) {
    Start-Sleep -Seconds 5
    $currentReadiness = Read-ReadinessLog
    if ($currentReadiness -match 'fatal ') { throw 'App-owned fatal marker observed during Polar stability window.' }
    $currentPolar = Read-PolarLog
    if ($currentPolar -match 'status=(ecg-stream-error|hr-stream-error)') { throw 'Polar stream error marker observed during stability window.' }
  }

  $polarLog = Read-PolarLog
  $polarLog | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'polar-stream-log.txt') -Encoding utf8
  $receipts = @(Get-PolarHealthReceipts $polarLog | Where-Object { $_.SampleCount -ge $initialSampleCount })
  $minimumReceiptCount = [Math]::Max(2, [Math]::Floor($PolarStabilitySeconds / 10))
  if ($receipts.Count -lt $minimumReceiptCount) { throw "Expected at least $minimumReceiptCount Polar health receipts, observed $($receipts.Count)." }
  for ($index = 0; $index -lt $receipts.Count; $index += 1) {
    $receipt = $receipts[$index]
    if (-not $receipt.Ready -or $receipt.SampleRateHz -ne 130 -or $receipt.ResolutionBits -ne 14) {
      throw 'Polar health receipt lost exact 130 Hz/14-bit ready state during the stability window.'
    }
    if ($receipt.StreamEpoch -ne $initialStreamEpoch) {
      throw 'Polar ECG stream epoch changed during the stability window; reconnect is not uninterrupted-stream evidence.'
    }
    if ($receipt.LatestSampleAgeMs -lt 0 -or $receipt.LatestSampleAgeMs -gt 5000) {
      throw "Polar ECG freshness exceeded the five-second gate: $($receipt.LatestSampleAgeMs) ms."
    }
    if ($index -gt 0 -and $receipt.SampleCount -le $receipts[$index - 1].SampleCount) {
      throw 'Polar ECG sample count did not increase between health receipts.'
    }
  }
  $finalReceipt = $receipts[-1]
  $minimumSampleGrowth = [long]([Math]::Max(1, $PolarStabilitySeconds - 15) * 100)
  if ($finalReceipt.SampleCount - $initialSampleCount -lt $minimumSampleGrowth) {
    throw "Polar sample growth was below the bounded acceptance floor: $($finalReceipt.SampleCount - $initialSampleCount) < $minimumSampleGrowth."
  }
  if ($null -eq $finalReceipt.ObservedRateHz -or $finalReceipt.ObservedRateHz -lt 120.0 -or $finalReceipt.ObservedRateHz -gt 140.0) {
    throw "Polar observed ECG rate was outside 120-140 Hz: $($finalReceipt.ObservedRateHz)."
  }
  if (-not $finalReceipt.HeartRateAvailable -or -not $finalReceipt.RrAvailable) {
    throw 'Polar health receipt did not confirm both heart-rate and RR availability.'
  }
  if ($finalReceipt.HeartRateAgeMs -lt 0 -or $finalReceipt.HeartRateAgeMs -gt 10000 -or
      $finalReceipt.RrAgeMs -lt 0 -or $finalReceipt.RrAgeMs -gt 10000) {
    throw "Polar HR/RR observations were not fresh: HR $($finalReceipt.HeartRateAgeMs) ms; RR $($finalReceipt.RrAgeMs) ms."
  }
  $expectedMetrics = @('excitement_score', 'excitometer', 'rmssd', 'ln_rmssd', 'sdnn', 'ecg_local_power', 'heart_rate', 'rr_interval', 'ecg_rms', 'ecg_peak_to_peak')
  $missingMetrics = @($expectedMetrics | Where-Object { $_ -notin $finalReceipt.FiniteMetrics })
  if ($missingMetrics.Count -gt 0) { throw "Polar metrics did not all warm up: $($missingMetrics -join ', ')." }
  [pscustomobject]@{
    StartedSampleCount = $initialSampleCount
    FinalSampleCount = $finalReceipt.SampleCount
    StreamEpoch = $finalReceipt.StreamEpoch
    SampleGrowth = $finalReceipt.SampleCount - $initialSampleCount
    ObservedRateHz = $finalReceipt.ObservedRateHz
    LatestSampleAgeMs = $finalReceipt.LatestSampleAgeMs
    HeartRateSampleAgeMs = $finalReceipt.HeartRateAgeMs
    RrSampleAgeMs = $finalReceipt.RrAgeMs
    SampleRateHz = $finalReceipt.SampleRateHz
    ResolutionBits = $finalReceipt.ResolutionBits
    HealthReceiptCount = $receipts.Count
    FiniteMetrics = $finalReceipt.FiniteMetrics
    RawPhysiologyIncluded = $false
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'polar-stability-summary.json') -Encoding utf8

  Write-Host '[Polar gate] ATTENDED ACTION REQUIRED: assign one finite metric to X and one to Y, enable Mixed reality and Flubber-only passthrough, then press Start experiment with the physical controller.'
  $mappedPolarLog = Wait-ForPolarMarker 'status=state-updated .*ready=true readinessReason=ready xMetric=(?!manual\b)[a-z_]+ yMetric=(?!manual\b)[a-z_]+'
  $mappedPolarLog | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'polar-mapped-log.txt') -Encoding utf8
  [void](Wait-ForMarker 'launcher_runtime_options environment=passthrough presentation=flubber-only')
  [void](Wait-ForMarker 'scene_ready')
  [void](Wait-ForMarker 'presentation_ready mode=flubber-only passthrough=true video_prepared=false video_rendered=false')
  [void](Wait-ForMarker 'countdown:3')
  [void](Wait-ForMarker 'countdown:2')
  [void](Wait-ForMarker 'countdown:1')
  [void](Wait-ForMarker 'flubber_only_started video_playback=false')
  [void](Wait-ForMarker 'polar_route readiness=ready x_metric=(?!manual\b)[a-z_]+ y_metric=(?!manual\b)[a-z_]+ x_live=true y_live=true')
  [void](Wait-ForMarker 'flubber_first_draw alpha_blend=true')
  $polarReadinessLog = Read-ReadinessLog
  $polarReadinessLog | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'polar-passthrough-log.txt') -Encoding utf8
  if ($polarReadinessLog -match 'fatal ') { throw 'App-owned fatal marker observed during Polar passthrough route.' }
  Save-Screenshot (Join-Path $EvidenceDirectory 'polar-flubber-only-passthrough.png')
  Write-Host "READINESS PASS: worn-H10 transport stability and one dual-axis Polar route in Flubber-only passthrough. The all-metric/all-axis and supported-headset matrix remains the attended checklist. Evidence: $EvidenceDirectory"
  exit 0
}

Write-Host '[tier 5/5] Validated session, attended immersive transition, video sink, LSL, and soak'
$readyLog = Wait-ForMarker 'session_ready session='
$readyLog | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'session-ready-log.txt') -Encoding utf8
if ($Gate -eq 'Session') { Write-Host "READINESS PASS: validated session. Evidence: $EvidenceDirectory"; exit 0 }

Write-Host 'ATTENDED ACTION REQUIRED: use a physical Touch controller to press Start experiment.'
$immersiveLog = Wait-ForMarker 'scene_ready'
$runtimeOptionsLog = Wait-ForMarker 'launcher_runtime_options environment=(dark|passthrough) presentation=(video|flubber-only)'
$presentationMatches = [regex]::Matches($runtimeOptionsLog, 'launcher_runtime_options environment=(dark|passthrough) presentation=(video|flubber-only)')
$presentationMode = $presentationMatches[$presentationMatches.Count - 1].Groups[2].Value
$flubberOnly = $presentationMode -eq 'flubber-only'
[void](Wait-ForMarker 'controller_models left_visible=(true|false) right_visible=(true|false) follow_enabled=(true|false) followed_hand=(left|right)')
[void](Wait-ForMarker 'controller_owner activity=affect_tracker input_system=interaction_sdk locomotion_registered=true locomotion_enabled=false locomotion_state=Disabled locomotion_claims_controllers=false input_bridge=retained polling_phase=late_feature')
[void](Wait-ForMarker 'flubber_entity_visible')
[void](Wait-ForMarker 'runtime_profile source=active-session.json video=[^ ]+ layout_source=(active_manifest|optional_manifest|active_layout_defaults) stick=(left|right)')
[void](Wait-ForMarker 'environment mode=(dark|passthrough) passthrough_enabled=(true|false) camera_frames=system_compositor_only')
[void](Wait-ForMarker 'flubber_full_surface_grab configured_width_m=[^ ]+ surface_width_m=[^ ]+ surface_height_m=[^ ]+ route=toolkit_panel_scene_object manual_isdk_edge_handles=false grab_enabled=(true|false) recenter_button=a')
$followLog = Wait-ForMarker 'flubber_controller_follow enabled=(true|false) hand=(left|right) distance_m=[^ ]+ faces_viewer=true'
$controllerFollowEnabled = $followLog -match 'flubber_controller_follow enabled=true'
if ($controllerFollowEnabled) {
  [void](Wait-ForMarker 'controller_follow_keepalive app_polling=per_frame headset_awake=true hardware_controller_sleep_control=platform')
  [void](Wait-ForMarker 'controller_model_visibility_applied left=[0-9]+:(true|false) right=[0-9]+:(true|false) input_unchanged=true')
}
[void](Wait-ForMarker 'affect_value_readout visible=(true|false) location=flubber_bottom refresh_hz=10 fields=x,y')
[void](Wait-ForMarker 'joystick_route active=true stick=(left|right) sources=spatial_standard_system,spatial_isdk_scroll,spatial_vractivity_game_controller hand_precedence=attachment_avatar_fallback android_fallback=true')
[void](Wait-ForMarker 'isdk_pointer_observer registered=true')
[void](Wait-ForMarker 'controller_inventory entities=[1-9][0-9]* active=[0-9]+ controller_type=[0-9]+ hand_type=[0-9]+ left_source=spatial_sdk_(left_attachment|left_avatar|controller_fallback) right_source=spatial_sdk_(right_attachment|right_avatar|controller_fallback)')
[void](Wait-ForMarker 'joystick_source route=neutral')
[void](Wait-ForMarker 'flubber_first_draw alpha_blend=true')
if ($flubberOnly) {
  [void](Wait-ForMarker 'presentation_ready mode=flubber-only passthrough=true video_prepared=false video_rendered=false')
  [void](Wait-ForMarker 'spatial_lock projection=none video_distance=none')
} else {
  $spatialLog = Wait-ForMarker 'spatial_lock projection=flat video_distance='
  $distanceMatch = [regex]::Match($spatialLog, 'spatial_lock projection=flat video_distance=([0-9.Ee+-]+)')
  if (-not $distanceMatch.Success) { throw 'Spatial lock marker did not contain a parseable video distance.' }
  $videoDistance = [double]::Parse($distanceMatch.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
  if ([Math]::Abs($videoDistance - 2.0) -gt 0.01) { throw "Flat video was not locked at the admitted 2.0 m eye distance: $videoDistance" }
}
[void](Wait-ForMarker 'countdown:3')
[void](Wait-ForMarker 'countdown:2')
[void](Wait-ForMarker 'countdown:1')
if ($flubberOnly) {
  [void](Wait-ForMarker 'flubber_only_started video_playback=false')
} else {
  [void](Wait-ForMarker 'first_video_frame')
}
Write-Host 'ATTENDED ACTION REQUIRED: move the configured physical Touch thumbstick away from neutral, then release it.'
[void](Wait-ForMarker 'joystick_input direction=(left|right|up|down)')
$physicalResponse = Wait-ForMarker 'flubber_input_response route=(spatial_standard_system|spatial_isdk_scroll|spatial_vractivity_game_controller) id=physical[^ ]* current_valence=[^ ]+ current_arousal=[^ ]+ target_valence=[^ ]+ target_arousal=[^ ]+'
if ($physicalResponse -match 'route=spatial_standard_system') {
  [void](Wait-ForMarker 'controller_button_state merged=0x[1-9a-fA-F][0-9a-fA-F]*')
} elseif ($physicalResponse -match 'route=spatial_isdk_scroll') {
  [void](Wait-ForMarker 'isdk_scroll_input event=[0-9]+ hand=(LEFT|RIGHT) selected=(left|right) accepted=true raw_x=')
} else {
  [void](Wait-ForMarker 'spatial_game_controller_motion route=(vractivity_pinned|activity_dispatch) selected=(left|right) x=')
}
if ($controllerFollowEnabled) {
  [void](Wait-ForMarker 'flubber_controller_follow_tracking state=acquired hand=(left|right)')
  Write-Host 'ATTENDED ACTION REQUIRED: move the configured tracked controller at least 2 cm through translation/depth; Flubber must remain nearby and face you.'
  [void](Wait-ForMarker 'flubber_controller_follow_moved hand=(left|right) distance_m=')
} else {
  Write-Host 'ATTENDED ACTION REQUIRED: point at a visually empty corner of the transparent Flubber panel, hold either physical trigger, move the panel at least 2 cm (including some depth), then release.'
  [void](Wait-ForMarker 'flubber_grab_started full_surface=true')
  [void](Wait-ForMarker 'flubber_grab_moved')
  [void](Wait-ForMarker 'flubber_grab_ended moved=true')
  Write-Host 'ATTENDED ACTION REQUIRED: look away from Flubber and press A. If A is assigned to reset/pause in the imported profile, this step is intentionally unavailable.'
  [void](Wait-ForMarker 'flubber_recentered source=(spatial_touch_a|spatial_game_controller_a) button=a distance_m=')
}
$immersiveLog = Read-ReadinessLog
$immersiveLog | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'immersive-log.txt') -Encoding utf8
Save-Screenshot (Join-Path $EvidenceDirectory $(if ($flubberOnly) { 'flubber-only-session.png' } else { 'first-video-frame.png' }))
if ($immersiveLog -match 'fatal ') { throw 'App-owned fatal marker observed.' }

if ($Gate -eq 'Full') { Write-Host "READINESS PASS: launcher → presentation selection → always-on Touch response → configured Flubber placement authority → countdown → $presentationMode session. Evidence: $EvidenceDirectory"; exit 0 }

$deadline = (Get-Date).AddMinutes($SoakMinutes)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 10
  $current = Read-ReadinessLog
  if ($current -match 'fatal ') { throw 'App-owned fatal marker observed during soak.' }
  $pidText = (Invoke-Adb @('shell', 'pidof', $package)) -join ''
  if ([string]::IsNullOrWhiteSpace($pidText)) { throw 'App process disappeared during soak.' }
}
Read-ReadinessLog | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'soak-log.txt') -Encoding utf8
Write-Host "READINESS PASS: $SoakMinutes-minute device soak. Evidence: $EvidenceDirectory"
