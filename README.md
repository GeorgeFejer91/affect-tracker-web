# Affect Tracker: Web + Desktop

A matched pair of 2D affect trackers inspired by [AffectTracker](https://github.com/afourcade/AffectTracker):

- A dependency-free online application hosted on GitHub Pages for browser studies.
- An offline Tauri v2/Rust desktop companion with click-to-capture global key/mouse/wheel bindings, a click-through always-on-top overlay, and always-on local Lab Streaming Layer output.

Both forms use the same canonical SVG renderer and the same valence/arousal mappings.

Live site: <https://GeorgeFejer91.github.io/affect-tracker-web/>

Desktop source: [`desktop/`](./desktop/) and [`src-tauri/`](./src-tauri/)

## Mandatory project brief for AI agents

Every AI agent must read [`AGENTS.md`](./AGENTS.md) and every file in [`for-ai/`](./for-ai/) before doing anything else in this repository. That directory records the product requirements, web/desktop parity contract, architecture, test gates, and roadmap.

## Controls

| Input | Effect |
| --- | --- |
| Left/Right arrows (default) | Decrease/increase valence |
| Up/Down arrows (default) | Increase/decrease arousal |
| Mouse wheel or trackpad | Change arousal |
| Shift + wheel | Change valence |
| Space | Pause or resume shape motion |
| R | Return the affect target to neutral |
| Drag the shape | Move the widget without changing affect |

Continuous mode moves while a direction is held. Step mode changes the target by `0.1` per press. The on-screen direction pad follows the selected mode.

## Visual mapping

The animation preserves the default AffectTracker mapping while using deterministic seeded irregularity and frame-rate-independent input smoothing:

```text
frequency = 1.5 + arousal             (0.5–2.5 Hz)
amplitude = 0.3 + 0.1 × arousal       (0.2–0.4)
shape mix = (valence + 1) / 2          (pointy→rounded)
disorder  = 0.4 × (1 - valence)        (irregular→regular)
```

The SVG has 192 radial samples and 16 projections. Both apps expose a four-anchor Up/Down/Left/Right palette and an exact interactive 2D color-space picker; the neutral center blends outward toward the configured axis colors.

## Logging and privacy

The page keeps a fixed-size ring buffer of at most 10,000 records:

- Semantic input events such as key/button presses, wheel changes, resets, mode changes, drag completion, export, and buffer clearing.
- Affect samples at 20 Hz while the page is visible.

Everything stays inside the current browser tab. Nothing is uploaded, and there are no analytics or external network dependencies. Closing or refreshing the page discards records that have not been downloaded. Use **Download CSV** to export the current session in chronological order.

The widget appearance, position, bindings, input behavior, and panel state are saved in `localStorage`. Affect values and history are not persisted.

## Shared customization JSON

The online and desktop apps expose the same input behavior, physical bindings, four-axis colors, flubber size, visibility, position, and 0–100% transparency control. Choose **Export settings JSON** in either app and import that file in the other. A desktop-exported file therefore produces the same flubber palette, geometry, transparency, controls, and placement in the browser, subject only to viewport constraints and the desktop overlay versus browser black-stage difference.

The portable schema stores transparency as `overlay.opacity` (`1` is opaque, `0` is fully transparent). It also carries the LSL stream metadata: GitHub Pages preserves those values for round-tripping, although a browser cannot publish LSL.

Repository maintainers can replace [`site/settings.json`](./site/settings.json) with an exported version-1 file to change the hosted defaults. Returning browsers retain their own `localStorage` preferences; clear site data or import the JSON to apply new defaults immediately. Settings import/export stays local and never uploads the file.

### Float over other applications from the browser

In browsers that support Document Picture-in-Picture, enable **Float Flubber over other apps** under Customization. The live SVG then moves into a browser-owned always-on-top window and returns to the page when that window closes. The originating page must remain open, the browser controls the floating window position, and configured controls only work while either Affect Tracker window is focused. Unsupported browsers show a disabled checkbox and can use the desktop companion instead. The page-controlled Picture-in-Picture surface is transparent, borderless, edge-to-edge, and requests the minimum available browser chrome.

This is intentionally transient and is not stored in the portable settings JSON. Chromium may still draw an opaque compositor surface and always retains security-critical window controls; a website cannot remove those. Unlike the Tauri overlay, the browser window is not click-through, cannot guarantee OS-level transparency, cannot monitor global input, and cannot publish LSL.

## Desktop companion

**Affect Tracker Desktop** uses the bundle identifier `io.github.georgefejer91.affecttracker`. It contains two local windows:

- A normal settings window for live coordinates, physical-input mappings, an interactive color-space picker, overlay appearance, and LSL configuration.
- A transparent overlay that floats above other applications. It is click-through while locked and draggable only in explicit edit mode.

Rust owns authoritative affect coordinates, smoothing, timestamps, settings, global raw-input monitoring, tray lifecycle, and LSL publication. The desktop WebViews contain presentation only and communicate through narrow typed commands. Closing the settings window quits the process and removes the overlay; the tray menu also provides an explicit Quit action.

The four default affect bindings are the plain arrow keys. Click any binding field and then press a key, click a mouse button, or scroll to assign that physical control. Bindings remain active while another application is focused; duplicate or invalid assignments are rejected. macOS requires Accessibility permission for global input monitoring. The Linux package currently supports global capture under X11; Wayland compositors may block it.

### Desktop LSL schema

The regular float stream defaults to `AffectTracker` at 50 Hz with these channels:

```text
current_valence, current_arousal, target_valence, target_arousal,
radius, angle_degrees, animation_active, input_active
```

The separate `AffectTrackerMarkers` stream carries irregular markers for every physical key press/release, mouse-button press/release, wheel event, and semantic app action. It records physical identifiers (for example `ArrowUp` or `Left`), never composed characters or typed text. Both streams start automatically whenever the app runs and remain local to LSL; saved stream names, rate, and source ID are reused on later launches. The application does not upload study data to a web service.

### Build the desktop companion

Install Node.js 22, pnpm 11, stable Rust, the current Tauri v2 prerequisites for your OS, CMake, and a native C/C++ compiler. Then run:

```sh
pnpm install --frozen-lockfile
pnpm desktop:build
cargo test --manifest-path src-tauri/Cargo.toml
cargo tauri dev
```

See [`desktop/README.md`](./desktop/README.md) for the LSL feature fallback and qualification requirements. Unsigned development builds are not a substitute for signed/notarized public installers.

### Desktop downloads

Cross-platform packages are published on the [GitHub Releases page](https://github.com/GeorgeFejer91/affect-tracker-web/releases). Each desktop release includes:

- Windows x64 NSIS installer (`.exe`).
- Linux x64 AppImage and Debian package (`.AppImage` and `.deb`).
- Universal macOS disk image for Apple Silicon and Intel (`.dmg`).

The initial packages are unsigned. Windows SmartScreen, macOS Gatekeeper, or Linux desktop security tooling may therefore ask the user to confirm that they trust the download.

## Accessibility

- All controls use semantic HTML and visible keyboard focus states.
- The widget exposes its current coordinates to assistive technology.
- Status changes use a polite live region.
- When `prefers-reduced-motion` is enabled, whole-body pulsing is disabled and projection motion is reduced without disabling input or logging.

## Run locally

No build is required. Serve the `site` directory through any static server:

```sh
python -m http.server 8000 --directory site
```

Then open <http://localhost:8000/>. Opening `index.html` directly is not recommended because browser security rules can block ES module imports from `file:` URLs.

## Test the web application

The unit suite uses Node.js 22's built-in test runner and has no package dependencies:

```sh
pnpm test
```

It covers the affect mappings, normalized profiles, deterministic offsets, path generation, smoothing, keyboard/wheel movement, widget constraints, ring-buffer rollover, session reset, and CSV escaping.

## Deployment

Pushes to `main` run the tests and deploy only the contents of `site/` through GitHub Actions and GitHub Pages. In the repository settings, Pages must use **GitHub Actions** as its source.

The separate desktop workflow builds the WebViews and runs Rust formatting, checks, tests, and clippy on Windows, macOS, and Linux. Release tags package the unsigned installers on their matching operating systems.

## Attribution and license

The affect mapping, circular projection model, and visual concept derive from:

> Fourcade A, Malandrone F, Roellecke L, Ciston A, Mooij JD, Villringer A, Carletto S and Gaebler M (2025). AffectTracker: real-time continuous rating of affective experience in immersive virtual reality. Frontiers in Virtual Reality 6:1567854. <https://doi.org/10.3389/frvir.2025.1567854>

The original AffectTracker project is Copyright © 2024 Antonin Fourcade and is distributed under the BSD 3-Clause License. This web implementation retains that license and attribution; see [LICENSE](./LICENSE).
