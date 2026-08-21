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

## Runtime ownership

### Browser

The WebView/browser owns affect state, input timing, logging, preferences, and SVG rendering. It has no native privileges.

The browser can import/export the shared settings JSON. It retains desktop-only LSL metadata unchanged, but must clearly disclose that browsers do not publish LSL. Browser-local preferences override `site/settings.json` after the first customized visit.

Document Picture-in-Picture is a browser-only, transient presentation mode. It mirrors the canonical SVG renderer, requires a user gesture, is feature-detected, is never persisted in portable JSON, and cannot be described as a transparent, click-through, globally monitored substitute for the Tauri overlay. CSS must leave its HTML/body/widget surfaces transparent and undecorated, but the browser-owned frame and OS compositor remain outside application control.

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
