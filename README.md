# Affect Tracker: Web + Desktop

A matched pair of 2D affect trackers inspired by [AffectTracker](https://github.com/afourcade/AffectTracker):

- A dependency-free online application hosted on GitHub Pages for browser studies.
- An offline Tauri v2/Rust desktop companion with configurable global shortcuts, a click-through always-on-top overlay, and local Lab Streaming Layer output.

Both forms use the same canonical SVG renderer and the same valence/arousal mappings.

Live site: <https://GeorgeFejer91.github.io/affect-tracker-web/>

Desktop source: [`desktop/`](./desktop/) and [`src-tauri/`](./src-tauri/)

## Mandatory project brief for AI agents

Every AI agent must read [`AGENTS.md`](./AGENTS.md) and every file in [`for-ai/`](./for-ai/) before doing anything else in this repository. That directory records the product requirements, web/desktop parity contract, architecture, test gates, and roadmap.

## Controls

| Input | Effect |
| --- | --- |
| Left/Right or A/D | Decrease/increase valence |
| Up/Down or W/S | Increase/decrease arousal |
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

The SVG has 192 radial samples and 16 projections. Polar angle selects the green→red→green color gradient, while distance from neutral controls saturation.

## Logging and privacy

The page keeps a fixed-size ring buffer of at most 10,000 records:

- Semantic input events such as key/button presses, wheel changes, resets, mode changes, drag completion, export, and buffer clearing.
- Affect samples at 20 Hz while the page is visible.

Everything stays inside the current browser tab. Nothing is uploaded, and there are no analytics or external network dependencies. Closing or refreshing the page discards records that have not been downloaded. Use **Download CSV** to export the current session in chronological order.

The widget position, widget size, panel state, and input mode are saved in `localStorage`. Affect values and history are not persisted.

## Desktop companion

**Affect Tracker Desktop** uses the bundle identifier `io.github.georgefejer91.affecttracker`. It contains two local windows:

- A normal settings window for live coordinates, shortcut mappings, input behavior, overlay appearance, and LSL configuration.
- A transparent overlay that floats above other applications. It is click-through while locked and draggable only in explicit edit mode.

Rust owns authoritative affect coordinates, smoothing, timestamps, settings, native shortcuts, tray lifecycle, and LSL publication. The desktop WebViews contain presentation only and communicate through narrow typed commands. Closing the settings window quits the process and removes the overlay; the tray menu also provides an explicit Quit action.

The safe default bindings use combinations such as `Control+Alt+Right`, avoiding silent capture of ordinary WASD/arrow input in other applications. Users can edit every assignment, and invalid or conflicting shortcuts are rejected.

### Desktop LSL schema

The regular float stream defaults to `AffectTracker` at 50 Hz with these channels:

```text
current_valence, current_arousal, target_valence, target_arousal,
radius, angle_degrees, animation_active, input_active
```

The separate `AffectTrackerMarkers` stream carries irregular semantic markers such as press/release, reset, pause, settings changes, and overlay movement. Both streams remain local to LSL; the application does not upload study data to a web service.

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

The separate desktop workflow builds the WebViews and runs Rust formatting, checks, tests, and clippy on Windows, macOS, and Linux. Public installer publication, signing, notarization, and updater configuration remain explicit release steps.

## Attribution and license

The affect mapping, circular projection model, and visual concept derive from:

> Fourcade A, Malandrone F, Roellecke L, Ciston A, Mooij JD, Villringer A, Carletto S and Gaebler M (2025). AffectTracker: real-time continuous rating of affective experience in immersive virtual reality. Frontiers in Virtual Reality 6:1567854. <https://doi.org/10.3389/frvir.2025.1567854>

The original AffectTracker project is Copyright © 2024 Antonin Fourcade and is distributed under the BSD 3-Clause License. This web implementation retains that license and attribution; see [LICENSE](./LICENSE).
