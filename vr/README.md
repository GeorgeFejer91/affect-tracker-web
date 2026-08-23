# Affect Tracker VR

Native Meta Spatial SDK delivery for Quest 2, Quest Pro, Quest 3, and Quest 3S (Horizon OS 69+).

## Session loading

1. Launch the APK. A visible 2D Quest panel explains the shared folder and keeps Start disabled.
2. Press **Authorize / change folder** and authorize `Documents/AffectTrackerVR` in the system folder picker. The picker is never opened from immersive mode or without an explicit press.
3. Create `Documents/AffectTrackerVR/media` if it is not already present.
4. In the web tracker, open **Customization and settings JSON → Export a Meta Quest video session**.
5. Select the local video, declare projection/stereo, configure placement/controllers, optionally check **Show X/Y affect coordinates**, and export. New sessions select the right thumbstick by default; either hand remains configurable.
6. Copy the unchanged video into `media/`. Copy `active-session.json` into `Documents/AffectTrackerVR` last.
7. Add any other ordinary video files directly to `media/`; after a stable copy and local hash/metadata check they appear automatically and use the active video's projection/stereo/loop defaults. If a clip needs different geometry—such as mono 360° or side-by-side stereo—put its standard version-1 manifest in `sessions/`. That manifest supplies only the selected video's identity and layout at runtime: `active-session.json` always supplies the Flubber, controller, display, and LSL profile. See [`open-media/`](./open-media/) for four reproducible test choices.
8. Put on the headset, look comfortably forward, choose a validated video, optionally change **Show X/Y affect coordinates** for this run, then press **Start experiment**. The headset switch starts from the universal JSON value but is a transient per-run override; it does not rewrite the manifest. LSL opens immediately; the flat screen and alpha-blended Flubber recenter from the live head pose, Flubber appears during a 3-second countdown, and video begins afterward. The mapped thumbstick remains active whenever the visible Flubber exists, including countdown and pause. Hold either trigger anywhere on the enlarged transparent Flubber surface—even outside the visible shape or in an empty corner—to move it laterally or in depth.

The app observes the same filename/size twice, verifies declared byte length and SHA-256 (or computes both locally for an automatically discovered file), probes decoder metadata, and asks Media3 to prepare the active Quest decoder with compatible-decoder fallback enabled. Container/codec support is therefore whatever Media3 and that headset's installed decoders can actually prepare—not literally every codec ever created. Projection/stereo are never guessed. `active-session.json` remains the default, fallback, and universal runtime profile. Invalid optional manifests are reported but cannot displace it.

Controller input remains in the immersive `VrActivity`. The activity explicitly creates the Interaction SDK input backend and retains Spatial SDK's `LocomotionSystem` only because `VRFeature` shares that object with ISDK as its controller-input bridge. It switches the system to `Disabled` and guards that state, preventing teleport and snap/world movement while preserving controller-state reset, models, tracked pose, pointer/grab input, and the app's affect controls. The controller reader is registered in Spatial SDK's late-system phase, after the controller/avatar entities exist. The primary path reads Meta's hand-specific `Controller` thumb-direction bits, preferring the selected hand's local attachment, then its player-avatar hand, then a bounded all-controller fallback. A physical panel-scroll event and the Spatial runtime's pinned game-controller MotionEvent path are supported fallbacks; pre-connected joystick devices are seeded before pinning because Spatial SDK 0.13.2's listener observes only later add/change callbacks. Every accepted physical route feeds the same 2D affect engine and Flubber canvas. The in-app status panel names the selected source and displays its current X/Y receipt. The one `left` or `right` mapping from `active-session.json` applies to every selected video; no privileged raw-input access or second OpenXR session is used. The Flubber's transparent compositor/grab surface is 2.5× the configured visual-width basis while its content scale preserves the previous apparent size, preventing maximum permitted amplitude/disorder from clipping and giving ISDK a much larger whole-surface target.

`showControllerModels` controls Spatial SDK's app-owned Touch render model. It preserves tracked controller pose and pointer presentation, but it is not Meta Home's shell-owned button-articulation model and its visible buttons may not animate consistently with Meta Home. Button/stick receipt is therefore verified through app-owned evidence. Set `vr.flubber.showAffectValues` to `true`, check the web exporter toggle, or use the headset Ready-screen switch to draw one locale-stable `X`/`Y` pair at the bottom of the transparent Flubber. These are the current smoothed valence/arousal coordinates that drive the visible geometry and LSL, each clamped to `[-1,1]`; target, response-rate, and raw-stick diagnostics are intentionally omitted. Text refreshes at 10 Hz; Flubber animation and input polling remain frame-driven.

## Build

Pinned host tools are JDK 17, Gradle 9.4.1, Android Platform 34, Build Tools 35.0.0, NDK 27.0.12077973, Rust with the `aarch64-linux-android` target, and `cargo-ndk` 4.1.2. Gradle, AGP, Kotlin, NDK, and Spatial SDK match Meta's current `PremiumMediaSample` baseline.

```powershell
$env:JAVA_HOME = "<jdk-17>"
$env:ANDROID_HOME = "<android-sdk>"
$env:ANDROID_NDK_HOME = "$env:ANDROID_HOME\ndk\27.0.12077973"
pwsh -NoProfile -File .\build-native-lsl.ps1 -Profile release
.\gradlew.bat testDebugUnitTest
.\gradlew.bat assembleDebug
```

Media3 uses the headset's Android platform decoders and renders directly to a Spatial SDK surface. FFmpeg is intentionally not bundled: Media3's FFmpeg extension is an audio decoder, while a software video pipeline would enlarge the APK and compete with the Spatial renderer for CPU and thermal budget. Rust is isolated to one in-process JNI library for LSL; it does not create another Android process. See [`docs/ENGINE-DECISION.md`](./docs/ENGINE-DECISION.md) for the evidence, alternatives, and official-liblsl fallback gate.

The native library must exist at `native-lsl/target/jniLibs/arm64-v8a/libaffect_tracker_vr_lsl.so`. The Ready screen blocks Start when the library or LSL outlet construction is unavailable.

## Network boundary

LSL is local-network only. The computer and Quest must share an IPv4 LAN whose access point permits multicast and client-to-client traffic. The APK performs no cloud upload and declares no broad storage permission.

Physical-device install, controller, playback, frame-time, and LSL/LabRecorder qualification remain separate from a successful host build. Follow the serial-scoped Quest workflow and retain generated APKs/device evidence outside Git.

## Debug controller diagnostic CLI

Debug APKs expose one narrow, `android.permission.DUMP`-protected broadcast while the immersive activity is alive. It drives the same `AffectEngine` and Flubber draw path as the configured Touch stick, but it does not create another app, controller owner, or OpenXR session. Release builds do not register the receiver.

```powershell
.\tools\affect-vr.ps1 status -DeviceSerial <serial>
.\tools\affect-vr.ps1 joystick -Direction up -DurationMs 900 -DeviceSerial <serial>
.\tools\affect-vr.ps1 verify-reactivity -Direction right -DeviceSerial <serial>
```

`verify-reactivity` requires an active immersive session and succeeds only after the Android Flubber canvas reports a changed affect draw for that command ID. This is a fast internal-pipeline diagnostic, never a substitute for the Full gate's attended physical Touch-controller evidence.

## Hierarchical readiness gates

`verify-readiness.ps1` stops at the first failed tier and builds the APK only once before device work:

```powershell
.\verify-readiness.ps1 -Gate Host
.\verify-readiness.ps1 -Gate Launcher -DeviceSerial <serial>
.\verify-readiness.ps1 -Gate Session -DeviceSerial <serial>
.\verify-readiness.ps1 -Gate Full -DeviceSerial <serial>
.\verify-readiness.ps1 -Gate Soak -DeviceSerial <serial> -SoakMinutes 30
```

After a Host gate passes, later headset gates can reuse those exact APK bytes without recompiling by passing the printed hash as `-ExpectedAdmittedApkSha256 <sha256>`. The verifier rejects any byte mismatch. Device gates apply a bounded one-hour QFM keep-awake hold by default so a doffed/asleep display cannot masquerade as a renderer failure.

The tiers are shared web/Quest contract tests, pure viewer-placement tests, and a simulated 30-minute Flubber soak; locked Kotlin/Rust builds and lint; immutable APK inspection; exact-device preflight/deployment plus consuming-runtime UI text and screenshot; then attended controller Start, live-pose lock, completed alpha-blended Flubber draw, controller inventory, countdown/first-frame markers, a physical thumbstick edge, a post-input reactive Flubber draw, a transparent-corner trigger grab with measured movement and release, screenshot, and bounded device soak. A foreground process or entity-created marker alone never passes readiness.
