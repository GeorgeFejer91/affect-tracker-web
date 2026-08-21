# Affect Tracker Desktop

This directory contains the local WebView source for the Tauri v2 companion. The authoritative native application lives in [`../src-tauri`](../src-tauri), and both desktop windows import the canonical shape renderer from [`../site/src/math.js`](../site/src/math.js) during the Vite build.

## Windows

- `settings`: ordinary configuration and live-preview window.
- `overlay`: transparent, borderless, always-on-top affect visualization. It ignores pointer events while locked and receives pointer events only in explicit edit-position mode.

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

## Global input and permissions

Click a binding field in Settings and press a key, mouse button, or wheel direction to capture it. Plain arrow keys control the two affect axes by default. The native hook continues receiving the configured controls while other applications are focused and emits identifiers for all physical key, mouse-button, and wheel events to the marker stream. It deliberately ignores typed-character events and mouse movement.

- macOS users must grant Accessibility permission to Affect Tracker Desktop.
- Linux global capture currently uses X11/XRecord. The overlay may still render under Wayland, but the global input hook is not guaranteed there.

## LSL streams

The desktop app automatically publishes a regular eight-channel float stream and a separate irregular marker stream for the entire app session. Stream settings are validated and persisted by Rust; changing them restarts the outlets without exposing a manual start/stop switch. Publication is performed by the native background loop rather than the SVG animation frame.

The locked `labstream` implementation avoids a platform-specific liblsl binary dependency. Before using a build for research, qualify it against current LabRecorder on Windows, macOS Intel/ARM, and the intended Linux/X11 study environment. See [`../for-ai/30-TESTING-AND-RELEASE.md`](../for-ai/30-TESTING-AND-RELEASE.md).
