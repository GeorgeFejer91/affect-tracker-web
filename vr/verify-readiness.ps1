[CmdletBinding()]
param(
  [ValidateSet('Host', 'Launcher', 'Session', 'Full', 'Soak')]
  [string]$Gate = 'Host',
  [string]$DeviceSerial,
  [int]$MarkerTimeoutSeconds = 90,
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

function Wait-ForMarker([string]$Pattern, [int]$TimeoutSeconds = $MarkerTimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $log = Read-ReadinessLog
    if ($log -match $Pattern) { return $log }
    Start-Sleep -Milliseconds 750
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for app-owned marker: $Pattern"
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

$launcherLog = Wait-ForMarker 'launcher_rendered'
$launcherLog | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'launcher-log.txt') -Encoding utf8
$activityState = (Invoke-Adb @('shell', 'dumpsys', 'activity', 'activities')) -join "`n"
$activityState | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'activity-state.txt') -Encoding utf8
$topResumedActivities = ($activityState -split "`r?`n") | Where-Object { $_ -match 'topResumedActivity=' }
if (($topResumedActivities -join "`n") -match 'OculusLinkAvailableDialogActivity') {
  throw "Meta's Enable Link dialog is covering the app. Press Not now in the headset, then rerun this gate."
}
$ui = (Invoke-Adb @('exec-out', 'uiautomator', 'dump', '/dev/tty')) -join "`n"
$ui | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'launcher-ui.xml') -Encoding utf8
Save-Screenshot (Join-Path $EvidenceDirectory 'launcher.png')
if ($ui -notmatch 'Affect Tracker VR' -or $ui -notmatch 'Start experiment') { throw 'Launcher process ran, but required UI text was not observed by the consuming UI runtime.' }
if ($Gate -eq 'Launcher') { Write-Host "READINESS PASS: visible launcher. Evidence: $EvidenceDirectory"; exit 0 }

Write-Host '[tier 5/5] Validated session, attended immersive transition, video sink, LSL, and soak'
$readyLog = Wait-ForMarker 'session_ready session='
$readyLog | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'session-ready-log.txt') -Encoding utf8
if ($Gate -eq 'Session') { Write-Host "READINESS PASS: validated session. Evidence: $EvidenceDirectory"; exit 0 }

Write-Host 'ATTENDED ACTION REQUIRED: use a physical Touch controller to press Start experiment.'
$immersiveLog = Wait-ForMarker 'scene_ready'
[void](Wait-ForMarker 'controller_models visible=(true|false)')
[void](Wait-ForMarker 'controller_owner activity=affect_tracker input_system=interaction_sdk locomotion_registered=true locomotion_enabled=false locomotion_state=Disabled locomotion_claims_controllers=false input_bridge=retained polling_phase=late_feature')
[void](Wait-ForMarker 'flubber_entity_visible')
[void](Wait-ForMarker 'runtime_profile source=active-session.json video=[^ ]+ layout_source=(active_manifest|optional_manifest|active_layout_defaults) stick=(left|right)')
[void](Wait-ForMarker 'flubber_full_surface_grab configured_width_m=[^ ]+ surface_width_m=[^ ]+ surface_height_m=[^ ]+ route=toolkit_panel_scene_object manual_isdk_edge_handles=false recenter_button=a')
[void](Wait-ForMarker 'affect_value_readout visible=(true|false) location=flubber_bottom refresh_hz=10 fields=x,y')
[void](Wait-ForMarker 'joystick_route active=true stick=(left|right) sources=spatial_standard_system,spatial_isdk_scroll,spatial_vractivity_game_controller hand_precedence=attachment_avatar_fallback android_fallback=true')
[void](Wait-ForMarker 'isdk_pointer_observer registered=true')
[void](Wait-ForMarker 'controller_inventory entities=[1-9][0-9]* active=[0-9]+ controller_type=[0-9]+ hand_type=[0-9]+ left_source=spatial_sdk_(left_attachment|left_avatar|controller_fallback) right_source=spatial_sdk_(right_attachment|right_avatar|controller_fallback)')
[void](Wait-ForMarker 'joystick_source route=neutral')
[void](Wait-ForMarker 'flubber_first_draw alpha_blend=true')
$spatialLog = Wait-ForMarker 'spatial_lock projection=flat video_distance='
$distanceMatch = [regex]::Match($spatialLog, 'spatial_lock projection=flat video_distance=([0-9.Ee+-]+)')
if (-not $distanceMatch.Success) { throw 'Spatial lock marker did not contain a parseable video distance.' }
$videoDistance = [double]::Parse($distanceMatch.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
if ([Math]::Abs($videoDistance - 2.0) -gt 0.01) { throw "Flat video was not locked at the admitted 2.0 m eye distance: $videoDistance" }
[void](Wait-ForMarker 'countdown:3')
[void](Wait-ForMarker 'countdown:2')
[void](Wait-ForMarker 'countdown:1')
[void](Wait-ForMarker 'first_video_frame')
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
Write-Host 'ATTENDED ACTION REQUIRED: point at a visually empty corner of the transparent Flubber panel, hold either physical trigger, move the panel at least 2 cm (including some depth), then release.'
[void](Wait-ForMarker 'flubber_grab_started full_surface=true')
[void](Wait-ForMarker 'flubber_grab_moved')
[void](Wait-ForMarker 'flubber_grab_ended moved=true')
Write-Host 'ATTENDED ACTION REQUIRED: look away from Flubber and press A. If A is assigned to reset/pause in the imported profile, this step is intentionally unavailable.'
[void](Wait-ForMarker 'flubber_recentered source=(spatial_touch_a|spatial_game_controller_a) button=a distance_m=')
$immersiveLog = Read-ReadinessLog
$immersiveLog | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'immersive-log.txt') -Encoding utf8
Save-Screenshot (Join-Path $EvidenceDirectory 'first-video-frame.png')
if ($immersiveLog -match 'fatal ') { throw 'App-owned fatal marker observed.' }

if ($Gate -eq 'Full') { Write-Host "READINESS PASS: launcher → always-on Touch response → full-surface Flubber grab → A-button gaze recenter → countdown → first rendered video frame. Evidence: $EvidenceDirectory"; exit 0 }

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
