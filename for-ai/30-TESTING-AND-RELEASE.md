# Testing and release gates

## Web gates

- Run the Node built-in unit suite.
- Preserve mapping extrema/midpoint, profile normalization, seeded repeatability, finite/closed paths, coordinate input, ring-buffer, CSV, dragging, and sampling tests.
- Verify the project-path GitHub Pages URL and absence of unexpected runtime requests after deployment.
- Verify shared settings normalization, desktop-compatible JSON round-trips, opacity/transparency endpoints, imports, exports, and checked-in `site/settings.json` defaults.
- Verify optional advanced bindings, cross-grid collision rejection, legacy version-1 defaults, bounded feature adjustments, and finite modified SVG geometry.
- Verify local and YouTube experiment configuration, URL parsing, start/finish validation, user-activated fullscreen entry and automatic exit (including declined/unsupported fallback), exact neutral reset, countdown, player shielding, centered 16:9 layout, the Flubber centered directly below the video without overlap, physical-input markers, stimulus timestamps, automatic end/export, and cleanup. Confirm the checked-in video stays below GitHub's 100 MB per-file limit and plays in current Chrome, Firefox, Safari, and Edge.
- Verify Document Picture-in-Picture feature detection, checkbox open/close lifecycle, live shape/color/opacity mirroring, origin-page restoration, and the unsupported-browser message in a real browser.

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

A change to coordinates, mappings, smoothing defaults, input actions, pause/reset semantics, seed handling, accessibility language, or shared record meaning must be assessed in both runtimes. Platform-only features such as LSL and click-through overlays need an explicit browser counterpart or an explicit documented exception. The stimulus experiment and its extended browser CSV fields are an explicit online-only exception.
