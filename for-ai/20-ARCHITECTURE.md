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

`site/src/portable-settings.js` is the canonical cross-runtime settings validator/serializer for web code, and `site/settings.json` is the checked-in hosted default. Rust has an independent typed deserializer and validator for the identical versioned schema; keep its contract test green whenever either side changes.

Advanced feature bindings are stored separately from required affect/action bindings. They are optional, but their physical tokens share one global uniqueness constraint with core bindings. Visual multipliers modify the canonical renderer output without replacing the valence/arousal mapping formulas.

## Runtime ownership

### Browser

The WebView/browser owns affect state, input timing, logging, preferences, and SVG rendering. It has no native privileges.

The browser can import/export the shared settings JSON. It retains desktop-only LSL metadata unchanged, but must clearly disclose that browsers do not publish LSL. Browser-local preferences override `site/settings.json` after the first customized visit.

The online experiment module is deliberately browser-only. A media-adapter boundary gives the bundled static MP4 and optional YouTube IFrame player the same prepare/start/stop/current-time lifecycle. The parent page owns countdown and sampling time, covers the player with an input shield, disables player keyboard controls, and restores normal layout after automatic CSV export. The default MP4 is a checked-in Pages asset; the YouTube API is loaded only after the user explicitly selects YouTube and starts an experiment.

`site/src/touch-trace.js` is a dependency-free browser-only signal layer. It owns the 1€ position filters, equal-distance resampling, turn/winding/corner/directional metrics, classifier-only covariance whitening for ellipse tolerance, bounded rolling histograms, asymmetric range smoothing, confidence gating, gated live target integration/hold, continuous-mode inactivity decay, raw surface projection, and normalized overview fitting. `app.js` owns Pointer Events acquisition, UI exclusion, rendering, experiment lifecycle, and logging. Display fitting is never a classifier input. The portable settings schema remains version 1; `inputSource`, touch feedback behavior, trace visibility, and cursor hiding are separate browser-local preferences.

The signal layer also owns the exported cold-start speed constants: lower `0.15 D/s`, upper `0.80 D/s`, and their log-feature midpoint `expm1((log1p(low)+log1p(high))/2)`, approximately `0.4387 D/s`. They are physical movement anchors derived from published deliberate-drag/quick-swipe measurements, not affect classifiers. Adaptive p10/p90 bounds remain authoritative after calibration evidence accumulates. Any change to these constants requires an algorithm-version decision, exact tests, and an update to `for-ai/70-RESEARCH-PROVENANCE.md`.

Cursor hiding is presentation-only: `app.js` applies `is-touch-cursor-hidden` only while the touch source is active. CSS removes the pointer from capture, Flubber, and fullscreen experiment surfaces but restores an ordinary cursor at `.panel-stack`, preventing an invisible-control trap. Every CSV row records the effective condition as `cursor_hidden`; toggles also create an event row.

The third top-level **Touch/Trackpad Playground** accordion is the discovery and practice surface for this browser-only mode. Its switch sets `inputSource` directly, its embedded trace canvas mirrors the shared analyzer without storing practice coordinates, and its metrics mirror the optional floating trace. A second cached palette canvas presents the same four-color affect space as Settings, with a read-only point and numeric outputs bound to displayed `currentX/currentY`. The playground surface is the sole settings-panel region permitted to feed pointer movement; other native controls remain excluded. Only one of the settings, experiment, or playground accordions may be open at a time.

`site/src/mobile.js` owns only the narrow touch-capable viewport predicate. A clean smartphone visit opens the Touch Lab once and persists `mobileTouchIntroSeen`; it never changes `inputSource`, so movement privacy still requires the explicit switch. CSS owns the compact three-tab navigation, viewport-relative full-screen sheet, safe-area/dynamic-height handling, large non-scrolling gesture surface, and portrait/phone-landscape breakpoints. The playground's additional SVG preview reuses the already-generated canonical path and color each frame; it does not generate or fork Flubber geometry. Mobile presentation must not increment the touch algorithm version unless signal processing or recorded semantics also change.

The Settings feature-space canvas remains the manual direct-coordinate control. Its positioned marker is a miniature instance of the canonical rendered SVG path, so it shares the live geometry, phase, palette, and smoothed displayed coordinates with the main Flubber. Pointer capture supports continuous dragging without page scrolling; arrow keys remain the keyboard path.

Touch/pen `pointerdown` begins a new geometry segment and resets the 1€ filters. When the new stroke begins within 900 ms of the prior delivered point, bounded five-sample speed windows and up to six qualified per-stroke direction summaries carry forward. Direction summaries are computed only from each stroke's own on-surface start/end vector after at least `0.01D` of path and displacement; the algorithm compares adjacent directions but never creates a segment across a lifted-finger gap. This gives alternating micro-swipes enough evidence to reach full speed confidence and become live angular evidence without measuring off-surface displacement or treating the gap as curvature. Within each continuous stroke, the equal-distance geometry buffer retains 513 points/512 segments (`2.56D`), enough to keep several screen-spanning direction changes in the same estimate. Mouse/touchpad hover remains one ordinary cursor trajectory; its backtracking and dominant corners are detected directly, and gaps above 400 ms retain the full-reset behavior.

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

## LSL boundary

LSL is an in-process Rust service behind a small adapter. Keep native-library and crate-specific details out of commands and domain state. The service owns outlet lifecycle and accepts typed snapshots/markers through bounded or coalescing communication.

If direct FFI is introduced later, it requires an explicit review and must isolate all `unsafe` code with documented ownership, ABI, teardown, and thread-affinity invariants.

## Platform expectations

- Windows and macOS are first-class release targets.
- Linux packages target mainstream X11 environments for raw global input. Wayland may support the transparent overlay but generally blocks the X11 hook; never claim full Wayland global-capture support without a separately tested backend and permission model.
- Native packages are built on matching GitHub-hosted operating systems.
- Signing/notarization and public release publication require explicit user authorization and credentials; CI may verify unsigned development bundles beforehand.
