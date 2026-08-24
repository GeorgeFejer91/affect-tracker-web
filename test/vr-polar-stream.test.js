import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const metrics = source("vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/PolarMetrics.kt");
const manager = source("vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/PolarH10Manager.kt");
const launcher = source("vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/AffectTrackerLauncherActivity.kt");
const activity = source("vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/AffectTrackerVrActivity.kt");
const application = source("vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/AffectTrackerVrApplication.kt");
const engine = source("vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/AffectEngine.kt");
const flubber = source("vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/FlubberView.kt");
const manifest = source("vr/app/src/main/AndroidManifest.xml");
const build = source("vr/app/build.gradle.kts");
const versions = source("vr/gradle/libs.versions.toml");
const license = source("vr/app/src/main/assets/Polar_SDK_License.txt");
const verifier = source("vr/verify-readiness.ps1");

test("native Polar metric catalog mirrors every browser mapping choice", () => {
  const expected = [
    "excitement_score", "excitometer", "rmssd", "ln_rmssd", "sdnn",
    "ecg_local_power", "heart_rate", "rr_interval", "ecg_rms", "ecg_peak_to_peak",
  ];
  for (const id of expected) assert.match(metrics, new RegExp(`PolarMetricDefinition\\(\\"${id}\\"`));
  assert.equal((metrics.match(/PolarMetricDefinition\("/g) ?? []).length, expected.length);
  assert.match(metrics, /ECG_WINDOW_SAMPLES = 130 \* 5/);
  assert.match(metrics, /RR_WINDOW_VALUES = 300/);
  assert.match(metrics, /2\.0 \* \(value - minimum\) \/ \(maximum - minimum\) - 1\.0/);
});

test("native Polar transport is explicit, application-scoped, and Study 6 ready", () => {
  assert.match(application, /val polar = PolarH10Manager\(application\)/);
  assert.match(versions, /polarBleSdk = "8\.1\.0"/);
  assert.match(build, /implementation\(libs\.polar\.ble\.sdk\)/);
  assert.match(manager, /FEATURE_HR/);
  assert.match(manager, /FEATURE_POLAR_ONLINE_STREAMING/);
  assert.match(manager, /autoConnectToDevice/);
  assert.match(manager, /requestStreamSettings[\s\S]*\.maxSettings\(\)/);
  assert.match(metrics, /REQUIRED_SAMPLE_RATE_HZ = 130/);
  assert.match(metrics, /REQUIRED_STABLE_MS = 3_000L/);
  assert.match(metrics, /MAX_SAMPLE_AGE_MS = 5_000L/);
  assert.match(manager, /runCatching \{ api\?\.shutDown\(\) \}/);
});

test("native launcher exposes complete connection, waveform, mapping, and readiness controls", () => {
  assert.match(launcher, /Text\("Polar Stream · H10"/);
  assert.match(launcher, /"Connect H10"/);
  assert.match(launcher, /"Disconnect H10"/);
  assert.match(launcher, /Text\("Retry"\)/);
  assert.match(launcher, /PolarWaveform\(state\.recentEcgSamplesUv\)/);
  assert.match(launcher, /PolarMetricCatalog\.metrics\.forEach/);
  assert.match(launcher, /toggleMetric\(PolarAffectAxis\.X/);
  assert.match(launcher, /toggleMetric\(PolarAffectAxis\.Y/);
  assert.match(launcher, /label = \{ Text\("Low"\) \}/);
  assert.match(launcher, /label = \{ Text\("High"\) \}/);
  assert.match(launcher, /if \(polarState\.mappings\.anyAssigned && !polarState\.readiness\.ready\)/);
});

test("native affect routing retains partial-axis Touch fallback and run-only sensor drive", () => {
  assert.match(engine, /fun setExternalTargets\(x: Float\?, y: Float\?\)/);
  assert.match(engine, /if \(externalX == null\) targetX/);
  assert.match(engine, /if \(externalY == null\) targetY/);
  assert.match(activity, /val polarDrive = if \(sessionActive\) polarState\.drive\(\)/);
  assert.match(activity, /localEngine\.setExternalTargets\(polarDrive\.x, polarDrive\.y\)/);
  assert.match(activity, /POLAR STREAM • LIVE/);
  assert.match(flubber, /"POLAR STREAM • LIVE"/);
  assert.match(activity, /effectiveShowAffectValues\(session\),\s*polarDrive\.active/);
  assert.match(activity, /POLAR_CONTEXT_INTERVAL_SECONDS = 1f/);
  assert.match(activity, /emitPolarAxisContext\(PolarAffectAxis\.X/);
  assert.match(activity, /emitPolarAxisContext\(PolarAffectAxis\.Y/);
});

test("native Polar path is least-privilege and packages the vendor license", () => {
  assert.match(manifest, /android\.hardware\.bluetooth_le/);
  assert.match(manifest, /android\.permission\.BLUETOOTH_SCAN/);
  assert.match(manifest, /android\.permission\.BLUETOOTH_CONNECT/);
  assert.doesNotMatch(manifest, /ACCESS_FINE_LOCATION|ACCESS_COARSE_LOCATION|MANAGE_EXTERNAL_STORAGE|CAMERA/);
  assert.match(license, /SOFTWARE DEVELOPMENT KIT LIMITED LICENSE AGREEMENT/);
  assert.doesNotMatch(manager, /FileOutputStream|OutputStream|DocumentFile|openFileOutput/);
  assert.match(manager, /deviceIdentifierLogged=false/);
  assert.match(manager, /rawEcgPersisted=false rrSeriesPersisted=false/);
});

test("native Polar hardware gate requires sustained sanitized ECG liveness and passthrough routing", () => {
  assert.match(manager, /HEALTH_MARKER_INTERVAL_MS = 10_000L/);
  assert.match(manager, /status=stream-health sampleCount=/);
  assert.match(manager, /streamEpoch=.*heartRateAvailable=.*rrAvailable=.*heartRateAgeMs=.*rrAgeMs=.*finiteMetrics=/s);
  assert.doesNotMatch(manager, /stream-health[^\n]*(?:recentEcgSamplesUv|heartRateBpm=|rrIntervalMs=)/);
  assert.match(verifier, /ValidateSet\('Host', 'Launcher', 'Session', 'Polar', 'Full', 'Soak'\)/);
  assert.match(verifier, /\[ValidateRange\(120, 3600\)\]/);
  assert.match(verifier, /status=stream-health sampleCount=/);
  assert.match(verifier, /StreamEpoch -ne \$initialStreamEpoch/);
  assert.match(verifier, /HeartRateAgeMs -gt 10000/);
  assert.match(verifier, /SampleCount -le \$receipts\[\$index - 1\]\.SampleCount/);
  assert.match(verifier, /ObservedRateHz -lt 120\.0/);
  assert.match(verifier, /expectedMetrics = @\('excitement_score', 'excitometer'/);
  assert.match(verifier, /launcher_runtime_options environment=passthrough presentation=flubber-only/);
  assert.match(verifier, /polar_route readiness=ready .*x_live=true y_live=true/);
});
