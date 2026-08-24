# Native Polar H10 handoff

## Status

The host implementation is complete and admitted. The remaining gate is an attended run with a
worn Polar H10 on a connected Quest headset. Do not describe native H10 acquisition as physically
qualified until the checklist below passes.

The durable product goal is to retain every exposed ECG/HRV/vital/composite metric as an explicit
candidate for either Flubber X or Y in native passthrough, while preserving independent Touch
ownership for every unassigned or unavailable axis.

## References reviewed

- [Polar Stream at `dff886e`](https://github.com/GeorgeFejer91/Polar-Stream/tree/dff886e03205a2986d10a7c00528d09530bc053a): its Rust core keeps raw receive/decode/publish ahead of derived work, decodes signed 24-bit PMD ECG, and exposes a broader 50-metric/ECG/ACC/LSL/OSC/CSV application. Affect Tracker deliberately reuses none of its five-minute HRV window or high-rate export surface; it retains the current web tracker's ten bounded formulas and privacy contract.
- [Spatial Study 6 at `130d5b2`](https://github.com/MesmerPrism/spatial-study-6/tree/130d5b2a18f6d6e86a512161a8c50f541a6d7d67): the native reference for Polar BLE SDK 8.1.0 feature selection, nearby-H10 auto-connect/retry, maximum ECG settings, HR/RR streaming, application-scoped lifecycle, and readiness after exact 130 Hz real samples remain stable for three seconds and fresh within five seconds. Its separate raw ECG writer is intentionally omitted.
- [rusty-quest-fork at `c9a8877`](https://github.com/GeorgeFejer91/rusty-quest-fork/tree/c9a887785b1d43a78d82f27bc63c7e52ad27aac5): another Rust-backed Quest APK whose Android panel owns raw BLE/CCCD/PMD sequencing and signed-24-bit ECG/HR/RR decoding while Rust owns rendering/stream consumers. It corroborates keeping Android BLE out of Affect Tracker's Rust LSL library. No AGPL source was copied.
- [Official Polar BLE SDK](https://github.com/polarofficial/polar-ble-sdk): H10 ECG/HR/RR support, SDK binary, device lifecycle, and license authority.

## Implemented ownership

`PolarH10Manager` is application-scoped and owns only Android permission, SDK setup, nearby H10
discovery/reconnection, ECG/HR subscriptions, readiness, bounded preview state, and explicit
shutdown. It never writes a file or logs the H10 identifier. `PolarMetricProcessor` mirrors the web
metric IDs/formulas with at most 650 ECG and 300 RR values. The launcher owns visible connection,
waveform, metric, mapping, and readiness controls. `AffectTrackerVrActivity` reads one state snapshot
per Spatial frame and supplies nullable normalized targets to the single `AffectEngine`.

This split keeps Media3, Spatial rendering, Touch input, and Polar BLE in Android/Kotlin. The Rust
`native-lsl` library remains unchanged and owns only the existing eight-channel state outlet and
marker outlet. Raw ECG and RR series never cross JNI or LSL. Assigned-axis scalar context is emitted
as a semantic marker no more than once per second.

## Runtime invariants

- Connect alone never changes affect; mappings default to Manual.
- An assigned run is blocked until real 130 Hz ECG meets the Study 6 readiness gate.
- Polar drive begins only after countdown and only while `sessionActive`.
- A finite ready target owns only its assigned axis. Manual, warming, stale, and disconnected axes
  remain controller-owned.
- Pause holds the last target. Reset changes only controller-owned axes.
- `POLAR STREAM • LIVE` plus current X/Y is drawn on the Flubber during a live mapped route.
- The same routing works in dark video, video passthrough, and Flubber-only passthrough.
- Mappings are application-memory/run-only state and never widen `active-session.json` or portable
  settings v1.
- Explicit Disconnect shuts down SDK streams and clears all bounded physiology state.

## Host evidence

The Host gate passes the complete Node contract suite, native JVM tests, Rust LSL schema test,
locked Gradle build, Android lint, `arm64-v8a` JNI rebuild, debug APK packaging, and immutable APK
admission. A separate minified unsigned release APK also assembles. APK inspection confirms the
package identity, optional BLE feature, nearby-device permissions, `arm64-v8a` Rust library, Polar
SDK dex packages, and packaged `assets/Polar_SDK_License.txt`, with no location, camera, broad
storage, or cleartext permission. Polar's newer Kotlin metadata requires the same compiler
workaround used by Study 6; R8 separately reports metadata parsing warnings but completes
successfully. The physical release smoke test remains mandatory.

## Attended H10/Quest acceptance

Use the exact Host-admitted APK bytes and one serial-scoped device. Wear and moisten the H10 strap,
close Polar Beat/Flow and any competing Bluetooth owner, then record:

```powershell
.\verify-readiness.ps1 -Gate Host
.\verify-readiness.ps1 -Gate Polar -DeviceSerial <serial> -ExpectedAdmittedApkSha256 <host-sha256>
```

The focused Polar gate clears logcat before the exact inspected deployment, waits for the real
Study 6 readiness state, then requires at least two minutes of increasing ten-second health
receipts, configured 130 Hz/14-bit ECG, a 120–140 Hz observed rate, samples fresh within five
seconds, an unchanged anonymous stream epoch, fresh HR/RR observations, and all ten metrics warmed to finite values. It then requires one
dual-axis mapped run in Flubber-only passthrough and an app-owned live route receipt. The health
receipt contains only sample counts, anonymous stream epoch, rate, freshness, stream format, availability flags, and
metric IDs; it contains no ECG values, RR series, scalar metric values, or device identifier.

This focused gate does not qualify the complete matrix. Continue with the following attended
manual runs and independent LSL consumers:

1. Quest model and OS; installed APK SHA-256; H10 firmware if visible without retaining its device ID.
2. Permission denial, retry/grant, Bluetooth-off recovery, discovery, connection, and automatic reconnect.
3. Configured 130 Hz/14-bit ECG, first real samples, three-second readiness, observed rate/gaps, and
   at least two minutes of stable streaming.
4. Live waveform, HR/RR, and finite values for all ten metrics after their documented warmups.
5. Each metric assigned once to X and once to Y in passthrough; one X-only and one Y-only run with
   the other axis controlled by the configured Touch stick; one dual-axis run.
6. Pre-countdown neutrality, `POLAR STREAM • LIVE` Flubber HUD, low/high/reverse, clamping, pause
   hold, manual-only Reset, range-loss fallback, reconnect recovery, and no teleport/snap/world motion.
7. Both video passthrough and Flubber-only passthrough, with no camera-frame path.
8. LabRecorder/pylsl confirmation that the eight state channels/order/rate remain unchanged and
   only bounded scalar Polar context appears as markers.
9. Explicit Disconnect followed by evidence that sampling stops; relaunch/reconnect without a stale
   SDK or Spatial teardown exception.
10. Inspection of app-private/output folders and sanitized logs confirming no raw ECG arrays, RR
    series, or H10 identifier was persisted.

Repeat the qualification on Quest 2, Quest Pro, Quest 3, and Quest 3S before claiming the complete
supported-device matrix.
