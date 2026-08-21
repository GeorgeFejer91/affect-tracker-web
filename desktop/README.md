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

## LSL streams

The desktop app publishes a regular eight-channel float stream and a separate irregular marker stream. Stream settings are validated and persisted by Rust. Publication is performed by the native background loop rather than the SVG animation frame.

The locked `labstream` implementation avoids a platform-specific liblsl binary dependency. Before a public research release, qualify it against current LabRecorder on Windows, macOS Intel/ARM, Linux X11, and Linux Wayland. See [`../for-ai/30-TESTING-AND-RELEASE.md`](../for-ai/30-TESTING-AND-RELEASE.md).
