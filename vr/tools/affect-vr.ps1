[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('status', 'joystick', 'verify-reactivity')]
  [string]$Command = 'status',
  [string]$DeviceSerial,
  [ValidateSet('left', 'right', 'up', 'down', 'neutral')]
  [string]$Direction = 'right',
  [ValidateRange(50, 5000)]
  [int]$DurationMs = 900,
  [string]$Adb = "$env:USERPROFILE\.cache\affect-tracker-vr\android-sdk\platform-tools\adb.exe"
)

$ErrorActionPreference = 'Stop'
$package = 'io.github.georgefejer91.affecttracker.vr'
$action = "$package.DEBUG_JOYSTICK"
$tag = 'AffectTrackerReady'

if (-not (Test-Path -LiteralPath $Adb)) { throw "ADB not found: $Adb" }

if ([string]::IsNullOrWhiteSpace($DeviceSerial)) {
  $devices = @(& $Adb devices | Select-Object -Skip 1 | Where-Object { $_ -match "\tdevice$" })
  if ($devices.Count -ne 1) { throw 'Pass -DeviceSerial when exactly one ready Android device is not connected.' }
  $DeviceSerial = ($devices[0] -split "\t")[0]
}

function Invoke-Adb([string[]]$Arguments) {
  $output = & $Adb '-s' $DeviceSerial @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "ADB command failed: $($Arguments -join ' ')`n$($output -join "`n")" }
  return $output
}

function Send-DiagnosticJoystick([string]$RequestedDirection, [int]$RequestedDurationMs) {
  $vector = switch ($RequestedDirection) {
    'left' { @(-1.0, 0.0) }
    'right' { @(1.0, 0.0) }
    'up' { @(0.0, -1.0) }
    'down' { @(0.0, 1.0) }
    default { @(0.0, 0.0) }
  }
  $id = 'diag-' + (Get-Date -Format 'yyyyMMddHHmmssfff')
  $result = Invoke-Adb @(
    'shell', 'am', 'broadcast', '--receiver-foreground',
    '-a', $action, '-p', $package,
    '--es', 'id', $id,
    '--ef', 'x', ([string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0:0.0}', $vector[0])),
    '--ef', 'y', ([string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0:0.0}', $vector[1])),
    '--ei', 'duration_ms', $RequestedDurationMs.ToString()
  )
  if (($result -join "`n") -notmatch 'Broadcast completed: result=0') {
    throw "The debug receiver did not acknowledge the diagnostic command.`n$($result -join "`n")"
  }
  return $id
}

switch ($Command) {
  'status' {
    $pidText = (Invoke-Adb @('shell', 'pidof', $package)) -join ''
    $log = (Invoke-Adb @('logcat', '-d', '-v', 'brief', '-s', "$tag`:V", '*:S')) -join "`n"
    Write-Output "package=$package process_running=$(-not [string]::IsNullOrWhiteSpace($pidText))"
    $log -split "`r?`n" |
        Where-Object { $_ -match 'controller_owner|controller_inventory|controller_button_state|isdk_scroll_input|spatial_game_controller|joystick_source|flubber_input_response|first_video_frame|fatal' } |
        Select-Object -Last 30
  }
  'joystick' {
    $id = Send-DiagnosticJoystick $Direction $DurationMs
    Write-Output "DIAGNOSTIC SENT: id=$id direction=$Direction duration_ms=$DurationMs"
    Write-Output 'This exercises the in-app route only; it is not physical Touch-controller evidence.'
  }
  'verify-reactivity' {
    $id = Send-DiagnosticJoystick $Direction $DurationMs
    $deadline = (Get-Date).AddSeconds(12)
    do {
      $log = (Invoke-Adb @('logcat', '-d', '-v', 'brief', '-s', "$tag`:V", '*:S')) -join "`n"
      $received = $log -match "diagnostic_joystick_received id=$([regex]::Escape($id))"
      $drawn = $log -match "flubber_input_response route=diagnostic_cli id=$([regex]::Escape($id))"
      if ($received -and $drawn) {
        $log -split "`r?`n" |
            Where-Object { $_ -match [regex]::Escape($id) } |
            Select-Object -Last 10
        Write-Output "DIAGNOSTIC PASS: joystick -> AffectEngine -> Flubber draw, id=$id"
        Write-Output 'This proves the internal app pipeline only; the Full gate still requires physical Touch input.'
        exit 0
      }
      Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)
    throw "No complete Flubber draw receipt was observed for diagnostic id $id. Start a validated immersive session first."
  }
}
