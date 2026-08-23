[CmdletBinding()]
param(
  [ValidateSet("debug", "release")]
  [string]$Profile = "release"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$NativeRoot = Join-Path $ProjectRoot "native-lsl"
$OutputRoot = Join-Path $NativeRoot "target\jniLibs\arm64-v8a"
$CargoHome = if ($env:CARGO_HOME) {
  $env:CARGO_HOME
} else {
  Join-Path ([Environment]::GetFolderPath("UserProfile")) ".cargo"
}
$CargoBin = Join-Path $CargoHome "bin"
$env:PATH = "$CargoBin;$env:PATH"

$Cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $Cargo) { throw "cargo is required" }
if (-not (Get-Command cargo-ndk -ErrorAction SilentlyContinue)) { throw "cargo-ndk is required" }
if (-not $env:ANDROID_NDK_HOME) { throw "ANDROID_NDK_HOME must identify a reviewed Android NDK" }

Push-Location $NativeRoot
try {
  $arguments = @("ndk", "-t", "arm64-v8a", "-o", (Join-Path $NativeRoot "target\jniLibs"), "build", "--locked")
  if ($Profile -eq "release") { $arguments += "--release" }
  & $Cargo.Source @arguments
  if ($LASTEXITCODE -ne 0) { throw "Rust JNI build failed with exit code $LASTEXITCODE" }
  $Library = Join-Path $OutputRoot "libaffect_tracker_vr_lsl.so"
  if (-not (Test-Path -LiteralPath $Library)) { throw "Expected JNI library was not produced: $Library" }
} finally {
  Pop-Location
}
