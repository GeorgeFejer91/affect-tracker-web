# Testing and release gates

## Web gates

- Run the Node built-in unit suite.
- Preserve mapping extrema/midpoint, profile normalization, seeded repeatability, finite/closed paths, coordinate input, ring-buffer, CSV, dragging, and sampling tests.
- Verify the project-path GitHub Pages URL and absence of unexpected runtime requests after deployment.

## Desktop gates

- `cargo fmt --all -- --check`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- Production Vite build.
- At least one real Tauri launch/build smoke test on every supported OS before calling a release cross-platform.

Pure Rust tests cover affect math, smoothing, target clamping, opposite-action cancellation, settings validation/migration, shortcut collisions, LSL sample schema, marker generation, and lifecycle state. Frontend tests cover the shared renderer and typed IPC adapter behavior.

## LSL qualification

- Resolve both streams using an independent LSL consumer.
- Record with current LabRecorder.
- Confirm channel count/type/order, nominal rate tolerance, timestamps, metadata, markers, restart behavior, sleep/wake, and clean shutdown.
- Test missing or incompatible native LSL dependencies and report a useful status rather than crashing.
- Perform an extended soak test before a research release.

## Release boundary

CI should test pull requests and build unsigned artifacts on Windows, macOS, and Linux. Publishing installers, creating a public GitHub release, enabling an updater, signing, notarizing, or store submission requires explicit authorization. Build each production artifact on the matching OS and preserve lockfiles, checksums, attribution, and license notices.

The `desktop-release.yml` workflow is the canonical packaging path. A `desktop-v*` tag produces Windows x64 NSIS, Linux x64 AppImage/DEB, and universal macOS DMG artifacts from one commit. Do not publish a release unless every matrix job completes successfully.

## Definition of parity

A change to coordinates, mappings, smoothing defaults, input actions, pause/reset semantics, seed handling, accessibility language, or record meaning must be assessed in both runtimes. Platform-only features such as LSL and click-through overlays need an explicit browser counterpart or an explicit documented exception.
