# Affect Tracker Desktop

This directory contains the local WebView source for the Tauri v2 companion. The authoritative native application lives in [`../src-tauri`](../src-tauri). During the Vite build, the desktop imports the canonical Flubber renderer from [`../site/src/math.js`](../site/src/math.js) and the same five-mode face coordinator used by GitHub Pages from [`../site/src/face-engines.js`](../site/src/face-engines.js). Detailed modes use the bundled Vitruvian GLB and Three.js renderer, then fall back locally through the project-owned photo atlas to [`../site/src/face.js`](../site/src/face.js).

## Windows

- `settings`: ordinary configuration window with a synchronized live preview: selected local face mode left, canonical Flubber right, with photo-atlas and SVG compatibility fallbacks.
- `overlay`: transparent, borderless, always-on-top Flubber-only visualization. It ignores pointer events while locked and receives pointer events only in explicit edit-position mode.

## Synchronized affect preview and traversal

Rust is the only desktop authority for affect state. Each compact snapshot supplies the exact same `currentX`, `currentY`, and `phase` object to both settings-window renderers, so facial deformation and the Flubber's shape, pulse, and rate of change move together. The presentation selector offers AFFEC empirical 3D, MediaPipe-rigged atlas 3D, continuous FACS-style 3D, an 11 × 11 morph matrix, and a photoreal atlas blend. The first four deform the same locally packaged morph head; the final mode bilinearly blends a compact 3 × 3 project-owned synthetic atlas. No camera or recognition model runs in the app. These are non-diagnostic coordinate visualizations, and reduced motion never changes the selected coordinates.

Two session traversal modes are available:

- **Continuous** retains the Rust engine's existing target smoothing.
- **11×11 matrix** exposes 121 exact states from `-1` to `+1` on both axes in `0.2` increments, including neutral at center cell `(5,5)`. A selected target follows the shortest 8-connected path: both indices change together while a diagonal step is possible, followed by cardinal steps if one axis arrives first. The rate is bounded to `0.5–10` states per second, Stop holds the current state, and Reset returns to exact neutral.

Mode, rate, current/target cells, and queued path are transient Rust state. They do not extend portable settings version 1. Native snapshots expose their presentation status, but the regular LSL outlet keeps its existing eight-channel order and publishes the actual current/target coordinates in either mode.

## Portable Study native runtime

The desktop Study Studio selects the native `StudyAuthorityV1`, so validation, publication, run preparation, state transitions, and event sequencing pass through the same Rust reducer compiled to WASM for Pages and WebXR. Accepted event batches are durably appended to an app-owned `.partial.csv`. A terminal transition creates a strict result manifest bound to the final CSV digest and then finalizes the manifest and CSV through atomic file renames; a failed finalization keeps the recoverable partial CSV authoritative.

The native asset vault is a content-identity and persistence foundation. Import streams selected bytes through staging, checks the expected SHA-256 and byte length, commits one content-addressed object, and updates its path-free catalog atomically. Preparing a run requires every published `contentAsset` to exist in that vault, freshly re-hashes and re-measures the app-owned object, fails on any missing or mismatched content, and stores the observed digest/length snapshot in the active run. Finalization copies that immutable evidence into `ResultManifestV1` with `verified: true`; it does not trust a later mutable alias or expose a native path.

This does not yet make the vault a complete native media pipeline. MIME and container values are caller-supplied allowlisted declarations recorded as `SuppliedUnprobed`; there is no trusted codec, duration, audio-presence, projection, or stereo-layout probe. The native picker UI, integrated player, opaque-ID custom protocol with bounded Range responses, partial-record recovery UI, and packaged Windows/macOS/Linux qualification remain open. The shared Studio currently plays its WebView `File` bindings/object URLs.

Successful native study actions also project a deliberately small lifecycle allowlist into `AffectTrackerMarkers`: preparation/arming/start, pause/resume, block entry/completion, questionnaire submission, media playing/paused with bounded position, ready-to-finalize, stop, completion, and abort. Markers are enqueued only after the reducer result and its durable record operation succeed; terminal markers therefore require successful finalization. They may carry validated run/section/trial/block identifiers, generation, revision, sequence, and media position, but never questionnaire answers, affect samples, branch/retry details, settings/calibration payloads, health/stall text, or caller-provided reasons.

## FLUBBER Party

The settings window can explicitly host a Party and invite a smartphone browser's **Live FLUBBER**, or broadcast the Rust-authoritative desktop Flubber so a smartphone browser Party host can invite it. The host renders one bounded logical scene and sends the identical aggregate roster, X/Y, normalized placement, relative size, stale state, and shared appearance back to every invited source. The smartphone's Party camera remains a local projection, so phone-only pinch/range zoom and swipe pan do not alter the scene transmitted to other screens.

Party is experimental and separate from the offline desktop core. It starts only after **Host Party and scan** or **Broadcast desktop Flubber**, uses the checked-in VDO.Ninja v1.5.5 SDK with no camera or microphone, and stops on the explicit action or page teardown. VDO.Ninja internet signaling/STUN is still required even when WebRTC selects a direct Wi-Fi route, and TURN may relay traffic. Public signal names must not identify a participant. Returned scenes are display-only: they cannot change Rust affect state, persisted settings, markers, history, or LSL.

## Local development

Prerequisites:

- Node.js 22 and pnpm 11
- Current stable Rust
- Current Tauri v2 operating-system prerequisites

```sh
pnpm install --frozen-lockfile
pnpm desktop:build
cargo test --manifest-path src-tauri/Cargo.toml
cargo tauri dev
```

The default Cargo feature includes LSL through the pure-Rust `labstream` protocol implementation. For domain/UI work where network streaming is intentionally excluded:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features
```

That fallback build reports LSL as unavailable and is not a research-ready distribution.

## Portable settings

The settings screen imports and exports the same version-1 JSON used by GitHub Pages. The file includes controls, bindings, optional advanced feature bindings, Circle/Heart/Triangle/Square base shape, visual multipliers, palette, overlay geometry/visibility/opacity, and LSL metadata. The Heart uses the same affect-driven pulse and deformation as the other envelopes, including when coordinates arrive through the normal input routes. The advanced menu can map any captured key, mouse button, or wheel direction to bounded animation-speed, pulse-amplitude, shape-disorder, transparency, or size adjustments. The transparency slider displays 0–100%, while JSON stores inverse opacity from 1 to 0. Rust validates imported files before applying or persisting them; files larger than 256 KB are rejected by the UI, and older version-1 files without `visual.baseShape` default to Circle.

An exported file can be imported on the live site or checked in as `site/settings.json`. GitHub Pages preserves the LSL fields for later desktop use but cannot create an LSL outlet.

## Global input and permissions

Click a binding field in Settings and press a key, mouse button, or wheel direction to capture it. Plain arrow keys control the two affect axes by default. The native hook continues receiving the configured controls while other applications are focused and emits identifiers for all physical key, mouse-button, and wheel events to the marker stream. It deliberately ignores typed-character events and mouse movement.

- macOS users must grant Accessibility permission to Affect Tracker Desktop.
- Linux global capture currently uses X11/XRecord. The overlay may still render under Wayland, but the global input hook is not guaranteed there.

## LSL streams

The desktop app automatically publishes a regular eight-channel float stream and a separate irregular marker stream for the entire app session. Stream settings are validated and persisted by Rust; changing them restarts the outlets without exposing a manual start/stop switch. Publication is performed by the native background loop rather than the SVG animation frame.

The locked `labstream` implementation avoids a platform-specific liblsl binary dependency. Before using a build for research, qualify it against current LabRecorder on Windows, macOS Intel/ARM, and the intended Linux/X11 study environment. See [`../for-ai/30-TESTING-AND-RELEASE.md`](../for-ai/30-TESTING-AND-RELEASE.md).
