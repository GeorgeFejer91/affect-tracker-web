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

## Runtime ownership

### Browser

The WebView/browser owns affect state, input timing, logging, preferences, and SVG rendering. It has no native privileges.

### Desktop

Rust owns authoritative affect state and durable settings. Native shortcut events update the Rust engine. A bounded background loop advances smoothed state, emits compact snapshots to both Tauri windows, and supplies the LSL service. The WebView renders snapshots and issues narrow product commands.

Do not make the SVG animation loop the source of LSL timestamps. Rendering can stall independently of research sampling.

## Tauri boundary

Allowed product-level commands include reading/saving settings, obtaining a snapshot/status, applying a directional action, reset/pause, toggling overlay editing/visibility, and starting/stopping LSL. Validate ranges, lengths, enum values, and shortcut conflicts in Rust.

The overlay capability is intentionally narrower than the settings capability. Neither window gets shell, arbitrary filesystem, or general HTTP authority. Packaged content is local and the CSP remains restrictive.

## LSL boundary

LSL is an in-process Rust service behind a small adapter. Keep native-library and crate-specific details out of commands and domain state. The service owns outlet lifecycle and accepts typed snapshots/markers through bounded or coalescing communication.

If direct FFI is introduced later, it requires an explicit review and must isolate all `unsafe` code with documented ownership, ABI, teardown, and thread-affinity invariants.

## Platform expectations

- Windows and macOS are first-class release targets.
- Linux supports mainstream X11 and Wayland environments, but always-on-top, tray, transparent-window, and global-shortcut behavior must be smoke-tested per desktop/compositor.
- Native packages are built on matching GitHub-hosted operating systems.
- Signing/notarization and public release publication require explicit user authorization and credentials; CI may verify unsigned development bundles beforehand.
