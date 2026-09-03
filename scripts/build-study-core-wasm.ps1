$ErrorActionPreference = "Stop"

$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$manifestPath = Join-Path $repositoryRoot "crates\study-core\Cargo.toml"
$wasmPath = Join-Path $repositoryRoot "crates\study-core\target\wasm32-unknown-unknown\release\affect_tracker_study_core.wasm"
$outputPath = Join-Path $repositoryRoot "site\vendor\study-core"
$cargoExecutable = (Get-Command cargo -ErrorAction SilentlyContinue).Source
$bindgenExecutable = (Get-Command wasm-bindgen -ErrorAction SilentlyContinue).Source
if (-not $cargoExecutable) { $cargoExecutable = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe" }
if (-not $bindgenExecutable) { $bindgenExecutable = Join-Path $env:USERPROFILE ".cargo\bin\wasm-bindgen.exe" }
if (-not (Test-Path -LiteralPath $cargoExecutable)) { throw "cargo was not found." }
if (-not (Test-Path -LiteralPath $bindgenExecutable)) { throw "wasm-bindgen was not found." }

$bindgenVersion = (& $bindgenExecutable --version).Trim()
if ($bindgenVersion -ne "wasm-bindgen 0.2.127") {
  throw "Study core packaging requires wasm-bindgen 0.2.127; found '$bindgenVersion'."
}

& $cargoExecutable build --manifest-path $manifestPath --target wasm32-unknown-unknown --features wasm --release
if ($LASTEXITCODE -ne 0) { throw "The study-core WASM build failed." }

New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
& $bindgenExecutable $wasmPath --target web --out-dir $outputPath --out-name affect_tracker_study_core
if ($LASTEXITCODE -ne 0) { throw "wasm-bindgen packaging failed." }

Write-Host "Packaged study-core WASM in $outputPath"
