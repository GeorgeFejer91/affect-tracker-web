# Testing and release gates

## Web gates

- Run the Node built-in unit suite.
- Preserve mapping extrema/midpoint, profile normalization, seeded repeatability, finite/closed paths, coordinate input, ring-buffer, CSV, dragging, and sampling tests.
- Verify the project-path GitHub Pages URL and absence of unexpected runtime requests after deployment.
- Verify shared settings normalization, desktop-compatible JSON round-trips, opacity/transparency endpoints, imports, exports, and checked-in `site/settings.json` defaults.
- Verify optional advanced bindings, cross-grid collision rejection, legacy version-1 defaults, bounded feature adjustments, and finite modified SVG geometry.
- Verify local and YouTube experiment configuration, URL parsing, start/finish validation, user-activated fullscreen entry and automatic exit (including declined/unsupported fallback), exact neutral reset, countdown, player shielding, centered 16:9 layout, the Flubber centered directly below the video without overlap, physical-input markers, stimulus timestamps, automatic end/export, and cleanup. Confirm the checked-in video stays below GitHub's 100 MB per-file limit and plays in current Chrome, Firefox, Safari, and Edge.
- Verify Document Picture-in-Picture feature detection, checkbox open/close lifecycle, live shape/color/opacity mirroring, origin-page restoration, and the unsupported-browser message in a real browser.
- Verify synthetic stationary, straight, arc, circle, corner, sinusoid, and zigzag paths; translation/rotation/scale and 30/60/120/240 Hz invariance; equal-distance interpolation; timestamp gaps; duplicate rejection; finite output; 1€ ground-truth values; adaptive bounds, bootstrap, minimum spans, asymmetric response, confidence, inactivity, and reset.
- Verify a three-point rapid swipe reaches full speed confidence and high mapped arousal; repeated two-point touch micro-strokes within 900 ms share speed evidence but reset shape geometry and exclude lifted-finger displacement; a longer gap clears the speed window. The target must approach its maximum during the post-movement hold, and inactivity uses the documented 1.8-second hold plus gradual 3-second release instead of a rapid reset.
- Verify hover-driven mouse/touchpad input, primary touch/pen capture, coalesced-event fallback, UI exclusion, unsupported multitouch logging, Flubber drag suppression, manual-event logging without affect changes, and the strict raw-movement privacy boundary.
- Verify the third **Touch/Trackpad Playground** accordion is visibly experimental, mutually exclusive with Settings and Experiment, exposes an unambiguous tracking switch, accepts movement over its practice surface while continuing to exclude other controls, and mirrors live pointer type, shape, speed, confidence, trace feedback, and displayed coordinates in a labelled jagged↔round/slow↔fast color map without storing practice coordinates.
- Verify the Settings feature-space marker is the live canonical Flubber path, follows smoothed displayed coordinates, changes color with the palette, and supports pointer capture/drag plus arrow-key coordinate selection without page scrolling.
- Verify the playground cursor checkbox is disabled outside touch mode, persists locally, hides the pointer over movement/Flubber/experiment areas only while active, keeps the pointer visible over settings for reversal, and records the effective `cursor_hidden` condition plus toggle events.
- Verify the four-second high-DPI trace fit, preserved aspect ratio, degenerate paths, fading/reduced-motion behavior, mobile layout order, and no video/Flubber/trace overlap.
- Verify `pointer_raw`, `touch_metric`, `sample`, and `event` rows are chronological and distinguishable; `speed_continuity_active` records the micro-stroke carry decision; append-only experiment storage does not roll over; active time pauses during buffering; final/partial export and retry retain all rows; long-trial warnings remain non-blocking.
- Run a 240 Hz, 30-minute synthetic analyzer workload before research release and keep average ingest/update cost below 1 ms with bounded buffers and finite values.

## Desktop gates

- `cargo fmt --all -- --check`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- Production Vite build.
- At least one real Tauri launch/build smoke test on every supported OS before calling a release cross-platform.

Pure Rust tests cover affect math, direct-coordinate and directional clamping, smoothing, opposite-action cancellation, settings validation/migration, binding collisions, physical token naming, LSL sample schema, marker generation, and lifecycle state. Frontend tests cover the shared renderer, four-anchor color mapping, and typed IPC adapter behavior.

Advanced feature actions must be tested for bounded animation speed, amplitude, disorder, opacity, and size changes; global actions must remain observable in marker output and persist without corrupting in-progress affect state.

Rust tests must deserialize and validate `site/settings.json`. Any portable settings schema change requires coordinated browser tests, Rust tests, documentation, and an explicit schema-version decision.

## LSL qualification

- Resolve both streams using an independent LSL consumer.
- Record with current LabRecorder.
- Confirm the marker stream receives every physical key/button press and release plus wheel direction while another application is focused, without typed-character payloads.
- Confirm channel count/type/order, nominal rate tolerance, timestamps, metadata, markers, restart behavior, sleep/wake, and clean shutdown.
- Test missing or incompatible native LSL dependencies and report a useful status rather than crashing.
- Grant and verify macOS Accessibility permission; test Linux raw input under X11 and clearly report Wayland limitations.
- Perform an extended soak test before a research release.

## Release boundary

CI should test pull requests and build unsigned artifacts on Windows, macOS, and Linux. Publishing installers, creating a public GitHub release, enabling an updater, signing, notarizing, or store submission requires explicit authorization. Build each production artifact on the matching OS and preserve lockfiles, checksums, attribution, and license notices.

The `desktop-release.yml` workflow is the canonical packaging path. A `desktop-v*` tag produces Windows x64 NSIS, Linux x64 AppImage/DEB, and universal macOS DMG artifacts from one commit. Do not publish a release unless every matrix job completes successfully.

## Definition of parity

A change to coordinates, mappings, smoothing defaults, input actions, pause/reset semantics, seed handling, accessibility language, or shared record meaning must be assessed in both runtimes. Platform-only features such as LSL and click-through overlays need an explicit browser counterpart or an explicit documented exception. The stimulus experiment, touch-trace source, and their extended browser CSV fields are explicit online-only exceptions.
