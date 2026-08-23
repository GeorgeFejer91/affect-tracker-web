# Affect Tracker VR

Native Meta Spatial SDK delivery for Quest 2, Quest Pro, Quest 3, and Quest 3S (Horizon OS 69+).

## Session loading

1. Launch the APK. A visible 2D Quest panel explains the shared folder and keeps Start disabled.
2. Press **Authorize / change folder** and authorize `Documents/AffectTrackerVR` in the system folder picker. The picker is never opened from immersive mode or without an explicit press.
3. Create `Documents/AffectTrackerVR/media` if it is not already present.
4. In the web tracker, open **Customization and settings JSON → Export a Meta Quest video session**.
5. Select the local video, declare projection/stereo, configure placement/controllers (including controller-model visibility), and export.
6. Copy the unchanged video into `media/`. Copy `active-session.json` into `Documents/AffectTrackerVR` last.
7. Optional: put additional standard version-1 session manifests in `Documents/AffectTrackerVR/sessions/`. The launcher shows a button only after that manifest and its referenced media independently pass the same settling, length, hash, metadata, and layout checks as the active session. See [`open-media/`](./open-media/) for four reproducible test choices.
8. Put on the headset, look comfortably forward, choose a validated experiment, then press **Start experiment**. LSL opens immediately; the flat screen and alpha-blended Flubber recenter from the live head pose, Flubber appears during a 3-second countdown, and video begins afterward. The mapped thumbstick remains active whenever the visible Flubber exists, including countdown and pause. Hold either trigger anywhere on the transparent Flubber square—even an empty corner—to move it laterally or in depth.

The app observes the same filename/size twice, verifies byte length and SHA-256, probes decoder metadata, and asks Media3 to prepare the active Quest decoder. Container/codec support is therefore whatever Media3 and that headset advertise; projection/stereo are never guessed. `active-session.json` remains the default and fallback choice. Invalid or incomplete optional manifests are reported but cannot displace it.

Controller input remains in the immersive `VrActivity`. The activity explicitly creates the Interaction SDK input backend and retains Spatial SDK's `LocomotionSystem` only because `VRFeature` shares that object with ISDK as its controller-input bridge. It switches the system to `Disabled` and guards that state, preventing teleport and snap/world movement while preserving controller-state reset, models, tracked pose, pointer/grab input, and the app's affect controls. The controller reader is registered in Spatial SDK's late-system phase, after the controller/avatar entities exist. The primary path reads Meta's hand-specific `Controller` thumb-direction bits, preferring the selected hand's local attachment, then its player-avatar hand, then a bounded all-controller fallback. A physical panel-scroll event and the Spatial runtime's pinned game-controller MotionEvent path are supported fallbacks; pre-connected joystick devices are seeded before pinning because Spatial SDK 0.13.2's listener observes only later add/change callbacks. Every accepted physical route feeds the same 2D affect engine and Flubber canvas. The in-app status panel names the selected source and displays its current X/Y receipt. The configured `left` or `right` JSON mapping selects X/Y or RX/RY; no privileged raw-input access or second OpenXR session is used.

`showControllerModels` controls Spatial SDK's app-owned Touch render model. It preserves tracked controller pose and pointer presentation, but it is not Meta Home's shell-owned button-articulation model. Button/stick receipt is therefore shown explicitly in the app panel and verified through the app-owned input-to-Flubber marker chain.

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
