# Architecture and parity contract

## Repository layout

```text
site/                 dependency-free GitHub Pages application
desktop/              Tauri WebView source and Vite configuration
src-tauri/            Rust application, capabilities, configuration, tests
test/                 browser/shared JavaScript tests
for-ai/               mandatory project contract
.github/workflows/    Pages and desktop verification/release automation
```

`site/src/math.js` is the canonical SVG affect renderer used by both runtimes. Desktop code imports it during the Vite build. Do not fork or copy its formulas into a second JavaScript renderer.

The Quest APK cannot execute the browser SVG renderer. Its native `FlubberGeometry` is an independently implemented platform adapter over the same constants, seed algorithm, profiles, and frame equations. JavaScript-generated golden vertices are the conformance authority; a Kotlin change that alters them requires an explicit renderer-contract decision.

`site/src/portable-settings.js` is the canonical cross-runtime settings validator/serializer for web code, and `site/settings.json` is the checked-in hosted default. Rust has an independent typed deserializer and validator for the identical versioned schema; keep its contract test green whenever either side changes.

`site/src/vr-session.js` owns the additive Quest envelope and exporter. It nests a normalized portable settings v1 object without extending that schema. Pixel overlay position/size remain round-trippable web/desktop data but are not Quest placement authority; `vr.flubber` owns metric placement and the optional `showAffectValues` diagnostic presentation switch.

Advanced feature bindings are stored separately from required affect/action bindings. They are optional, but their physical tokens share one global uniqueness constraint with core bindings. Visual multipliers modify the canonical renderer output without replacing the valence/arousal mapping formulas.

## Runtime ownership

### Browser

The WebView/browser owns affect state, input timing, logging, preferences, and SVG rendering. It has no native privileges.

The browser can import/export the shared settings JSON. It retains desktop-only LSL metadata unchanged, but must clearly disclose that browsers do not publish LSL. Browser-local preferences override `site/settings.json` after the first customized visit.

The online experiment module is deliberately browser-only. A media-adapter boundary gives the bundled static MP4 and optional YouTube IFrame player the same prepare/start/stop/current-time lifecycle. The parent page owns countdown and sampling time, covers the player with an input shield, disables player keyboard controls, and restores normal layout after automatic CSV export. The default MP4 is a checked-in Pages asset; the YouTube API is loaded only after the user explicitly selects YouTube and starts an experiment.

`site/src/touch-trace.js` is a dependency-free browser-only signal layer. It owns the 1€ position filters, equal-distance resampling, turn metrics, bounded rolling histograms, asymmetric range smoothing, confidence gating, gated live target integration/hold, continuous-mode inactivity decay, and trace-fit geometry. `app.js` owns Pointer Events acquisition, UI exclusion, rendering, experiment lifecycle, and logging. The portable settings schema remains version 1; `inputSource`, touch feedback behavior, trace visibility, and cursor hiding are separate browser-local preferences.

The signal layer also owns the exported cold-start speed constants: lower `0.15 D/s`, upper `0.80 D/s`, and their log-feature midpoint `expm1((log1p(low)+log1p(high))/2)`, approximately `0.4387 D/s`. They are physical movement anchors derived from published deliberate-drag/quick-swipe measurements, not affect classifiers. Adaptive p10/p90 bounds remain authoritative after calibration evidence accumulates. Any change to these constants requires an algorithm-version decision, exact tests, and an update to `for-ai/70-RESEARCH-PROVENANCE.md`.

Cursor hiding is presentation-only: `app.js` applies `is-touch-cursor-hidden` only while the touch source is active. CSS removes the pointer from capture, Flubber, and fullscreen experiment surfaces but restores an ordinary cursor at `.panel-stack`, preventing an invisible-control trap. Every CSV row records the effective condition as `cursor_hidden`; toggles also create an event row.

The third top-level **Touch/Trackpad Playground** accordion is the discovery and practice surface for this browser-only mode. Its switch sets `inputSource` directly, its embedded trace canvas mirrors the shared analyzer without storing practice coordinates, and its metrics mirror the optional floating trace. A second cached palette canvas presents the same four-color affect space as Settings, with a read-only point and numeric outputs bound to displayed `currentX/currentY`. The playground surface is the sole settings-panel region permitted to feed pointer movement; other native controls remain excluded. Only one of the settings, experiment, or playground accordions may be open at a time.

`site/src/mobile.js` owns only the narrow touch-capable viewport predicate. A clean smartphone visit opens the Touch Lab once and persists `mobileTouchIntroSeen`; it never changes `inputSource`, so movement privacy still requires the explicit switch. CSS owns the compact three-tab navigation, viewport-relative full-screen sheet, safe-area/dynamic-height handling, large non-scrolling gesture surface, and portrait/phone-landscape breakpoints. The playground's additional SVG preview reuses the already-generated canonical path and color each frame; it does not generate or fork Flubber geometry. Mobile presentation must not increment the touch algorithm version unless signal processing or recorded semantics also change.

The Settings feature-space canvas remains the manual direct-coordinate control. Its positioned marker is a miniature instance of the canonical rendered SVG path, so it shares the live geometry, phase, palette, and smoothed displayed coordinates with the main Flubber. Pointer capture supports continuous dragging without page scrolling; arrow keys remain the keyboard path.

Touch/pen `pointerdown` begins a new geometry segment and resets the 1€ filters. When the new stroke begins within 900 ms of the prior delivered point, only the bounded five-sample speed windows carry forward. This gives alternating micro-swipes enough evidence to reach full speed confidence without measuring the off-surface displacement or connecting separate strokes for curvature. Mouse/touchpad hover remains one ordinary cursor trajectory; gaps above 400 ms retain the full-reset behavior.

The default gated feedback path groups delivered movement into a window that closes after 400 ms without a valid point. Incoming points refresh confidence-weighted shape/speed evidence for immediate feedback, while representative gate observations remain limited to 20 Hz and bounded storage. Evidence outside the 0.12 dead zone becomes a signed `0.04..0.4` units/second velocity and is integrated with timestamp-derived `dt` while movement is fresh. The target therefore moves continuously for as long as the participant draws, clamps to `[-1,1]`, and freezes at gate close; closing never adds a second step. Because this velocity is already bounded and smooth, the rendered Flubber/grid state follows the gated target directly rather than adding a lagging exponential layer. Touch/pen pointer-up stops integration immediately; mouse/touchpad cursor input expires after 80 ms without movement. Only the completed gate representative is added to each adaptive range, giving short and long gestures equal calibration weight. Gated calibration retains up to 120 completed windows and blends from priors over 20 qualified gates. The optional continuous path retains 1,200 feature samples, the 100-sample bootstrap, 300 ms attack, 1.8-second hold, and 3-second neutral release. Switching behavior resets analyzer calibration but seeds the new behavior from the existing affect target.

Normal sessions continue to use `AffectLogger`'s 10,000-row ring buffer. An experiment creates one `ExperimentCsvWriter`: it serializes append-only rows into roughly 1,000-row chunks, keeps chronological sequence numbers, and never sends high-rate pointer records through the ring buffer. Experiment elapsed time is wall-clock monotonic; `active_elapsed_ms` advances only while the player is playing, and stimulus time comes from the active media adapter.

Document Picture-in-Picture is a browser-only, transient presentation mode. It mirrors the canonical SVG renderer, requires a user gesture, is feature-detected, is never persisted in portable JSON, and cannot be described as a transparent, click-through, globally monitored substitute for the Tauri overlay. CSS must leave its HTML/body/widget surfaces transparent and undecorated, but the browser-owned frame and OS compositor remain outside application control.

The Experimental Touch/Trackpad input source, raw pointer rows, adaptive calibration, and trace panel are explicit online-only exceptions. Tauri state, portable settings version 1, and LSL schemas must not change merely to mirror this research prototype.

### Desktop

Rust owns authoritative affect state and durable settings. The `monio` raw-input hook maps global physical events to actions and marker records. A bounded background loop advances smoothed state, emits compact snapshots to both Tauri windows, and supplies the always-on LSL service. The WebView renders snapshots and issues narrow product commands.

Do not make the SVG animation loop the source of LSL timestamps. Rendering can stall independently of research sampling.

## Tauri boundary

Allowed product-level commands include reading/saving settings, obtaining a snapshot/status, applying a directional action or exact coordinate, reset/pause, and toggling overlay editing/visibility. There is no LSL start/stop command. Validate ranges, lengths, enum values, colors, and input-binding conflicts in Rust.

The overlay capability is intentionally narrower than the settings capability. Neither window gets shell, arbitrary filesystem, or general HTTP authority. Packaged content is local and the CSP remains restrictive.

### Quest

The Quest control plane has one required root `active-session.json`, which is both the default video declaration and the sole runtime-profile authority. The SAF loader independently validates up to 24 optional standard v1 manifests under `sessions/`, retains each optional manifest's session/video identity and explicit projection/stereo/loop fields, then overlays the active affect, Flubber, controller, and LSL profile before staging it. The active staged fingerprint participates in every optional fingerprint, so changing universal settings invalidates stale cached choices. Up to 24 otherwise-unclaimed files under `media/` are also settled, hashed, metadata-probed, and offered with an app-generated session ID; they inherit the active projection/stereo/loop defaults and are visibly labelled as such. A manifest remains required whenever those defaults are not correct. Selection is ephemeral launcher state and rewrites nothing. The optional Flubber value readout is rendered by the same native transparent `FlubberView`: geometry stays frame-driven, while one locale-stable string containing only the current bounded `X` and `Y` coordinates refreshes at a bounded 10 Hz when enabled. The Ready screen may pass one typed per-run Boolean override initialized from the universal profile; it neither mutates the staged fingerprint nor rewrites JSON. The readout introduces no second panel, process, renderer, or sampling authority.

`vr/` is an isolated Android/Spatial SDK source boundary. `SessionLoader` owns SAF authorization, stable-copy observation, universal-profile application, manifest/hash/media validation, bounded default-layout discovery, and last-good staging. Media3 owns decode state and enables its compatible-decoder fallback within the platform's installed decoder set; `SpatialVideoCoordinator` owns immutable shape/stereo panel registrations and world carriers; pure `SpatialPlacement` owns the head-pose-relative placement equations; and the activity owns the one OpenXR/Spatial frame loop, controller input, avatar visibility, placement locking, and lifecycle markers. The activity explicitly selects the Interaction SDK input backend and retains Spatial SDK's registered `LocomotionSystem` because `VRFeature` also supplies that exact object to ISDK as its `ExternalControllerInputHandler`. It immediately calls `enableLocomotion(false)` and reasserts the `Disabled` state from the late polling system, so `areControllersInUse()` remains false and teleport/snap/world movement cannot start while the bridge continues its per-frame input-result reset. Controller rigging, tracked pose, pointer/grab input, and the late-feature affect polling system remain registered. Controller polling runs after the controller/avatar entities exist, matching the working MesmerPrism Spatial app lifecycle while preserving exclusive affect ownership of the stick. Each selected hand resolves its local controller attachment first, then its player-avatar controller, then the bounded all-controller fallback; hand-specific thumb bits retain routing. Two additional inputs remain inside that same `VrActivity`: ISDK `PointerEvent.scrollInfo` for a physical stick scrolling a panel, and Spatial SDK's `VrActivity.pinGameController` MotionEvent route for joystick-class devices. Spatial SDK 0.13.2 registers an `InputDeviceListener` but does not seed devices connected before activity creation, so the APK enumerates the already-present gamepad/joystick sources using the SDK's exact source masks before pinning; it does not read `/dev/input`, request privileged input permissions, or open another OpenXR session. All physical routes feed the single `AffectEngine`, are gated by visible-Flubber lifetime rather than LSL/video/panel focus, display the selected route and X/Y receipt in-app, and emit route-specific SDK→target/current→canvas receipts. Spatial SDK's app-owned Touch render model preserves tracked pose and pointer presentation but is not treated as equivalent to Meta Home's shell-owned button-articulation model. The manifest declares Meta's optional hand-tracking and render-model capabilities and their vendor permissions because Spatial SDK's Interaction SDK input/controller representation uses those official declarations; neither grants broad filesystem access. A debug-only, `android.permission.DUMP`-protected typed broadcast can emulate a bounded stick direction through the same engine/draw path for pipeline diagnosis, but it is never physical Touch evidence. The native Flubber panel keeps its established apparent content size inside a 2.5× transparent alpha-blended compositor surface and explicitly carries `IsdkPanelDimensions`, `IsdkGrabbable`, and complete-surface grab-handle collision widths. An entity-created marker is not accepted as proof until its Android canvas reports a completed shape draw. Video bytes never enter JSON or LSL.

The native LSL adapter is a Rust `cdylib` behind a four-call JNI boundary. It owns outlet construction and wire publication; Kotlin owns app/session lifecycle and supplies typed snapshots through a bounded, preallocated command pool to one dedicated worker. The library and worker remain inside the APK process. Multicast permission is held only while outlets are active. FFmpeg is not a v1 video engine: Media3/platform hardware decode remains the media path, while official `liblsl` is the pinned-interface fallback if the young `labstream` implementation fails physical interoperability gates.

## LSL boundary

LSL is an in-process Rust service behind a small adapter. Keep native-library and crate-specific details out of commands and domain state. The service owns outlet lifecycle and accepts typed snapshots/markers through bounded or coalescing communication.

If direct FFI is introduced later, it requires an explicit review and must isolate all `unsafe` code with documented ownership, ABI, teardown, and thread-affinity invariants.

## Platform expectations

- Windows and macOS are first-class release targets.
- Linux packages target mainstream X11 environments for raw global input. Wayland may support the transparent overlay but generally blocks the X11 hook; never claim full Wayland global-capture support without a separately tested backend and permission model.
- Native packages are built on matching GitHub-hosted operating systems.
- Signing/notarization and public release publication require explicit user authorization and credentials; CI may verify unsigned development bundles beforehand.
