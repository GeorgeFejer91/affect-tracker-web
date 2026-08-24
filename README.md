# Affect Tracker: Web + Desktop + VR

Three matched Affect Tracker delivery forms inspired by [AffectTracker](https://github.com/afourcade/AffectTracker):

- A dependency-free online application hosted on GitHub Pages for browser studies.
- An offline Tauri v2/Rust desktop companion with click-to-capture global key/mouse/wheel bindings, a click-through always-on-top overlay, and always-on local Lab Streaming Layer output.
- A native Meta Quest Spatial SDK video player under [`vr/`](./vr/) that loads a local video/session manifest, renders a transparent movable Flubber, accepts Touch-controller input, and publishes same-LAN LSL.

All forms use the same valence/arousal mappings. Web and desktop share the JavaScript renderer directly; Quest uses a native allocation-bounded port checked against JavaScript golden vectors.

Live site: <https://GeorgeFejer91.github.io/affect-tracker-web/>

Experimental Meta Quest WebXR study: <https://GeorgeFejer91.github.io/affect-tracker-web/webxr.html>

Desktop source: [`desktop/`](./desktop/) and [`src-tauri/`](./src-tauri/)

## Mandatory project brief for AI agents

Every AI agent must read [`AGENTS.md`](./AGENTS.md) and every file in [`for-ai/`](./for-ai/) before doing anything else in this repository. That directory records the product requirements, cross-delivery parity contract, architecture, test gates, and roadmap.

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

### Experimental Touch/Trackpad control

Open the visibly marked **Touch/Trackpad Playground — Experimental** accordion and switch on **Enable touch/trackpad tracking** to map an unrestricted two-dimensional pointer trajectory into the display:

- Repeated coherent circular or elliptical thumb loops move valence right. Uncontrolled multi-direction movement with dominant V/W-like turns moves it left, even when the thumb naturally bows the legs between turns.
- Faster movement raises arousal; slower movement lowers it. Stopping is inactivity and is never classified as slow movement.
- Touchscreens and pens use browser Pointer Events. A laptop touchpad appears to the page as an OS-accelerated mouse cursor trajectory; browsers do not expose its raw finger contacts.

Cold-start speed calibration uses viewport-normalized movement: `0.15` viewport diagonals/second (D/s) represents a deliberate slow command, the log-space midpoint is about `0.44 D/s`, and `0.80 D/s` represents a quick command. These anchors are grounded in published front-screen drag/swipe measurements, then progressively replaced by the participant's p10/p90 range. Affect studies support faster movement as a useful arousal-related feature, but do not establish portable diagnostic thresholds across people, tasks, devices, or OS-accelerated touchpads. The labels therefore describe lower/hold/higher-arousal **control commands**, not detected emotional states.

The default **Gated move-and-hold** behavior lets the participant keep drawing until the Flubber reaches the intended state. While fresh movement is arriving, confidence-weighted speed and shape evidence outside a `0.12` dead zone continuously moves the target at up to `0.4` normalized units per second: fast/slow raises/lowers arousal and circular/angular moves valence right/left. Stopping closes the movement window after 400 ms and freezes the exact reached position without a release-time jump or neutral decay. Each completed window contributes only one representative sample to participant-specific calibration, preventing a long gesture from outweighing many short gestures. Calibration blends from safe priors over the first 20 qualified windows.

**Continuous live response** remains available for comparison. It follows movement in real time, holds the last result for 1.8 seconds, and then returns gradually toward neutral. In both behaviors, the playground shows detected pointer type, shape, speed, confidence, the last four seconds of movement, and a live valence–arousal color map with a moving dot. Two measured movement segments are enough for full speed confidence. Rapid touch/pen strokes beginning within 900 ms share recent speed evidence and compare their own on-surface directions, allowing an up/down/up sequence to become angular evidence during the active swipe. Separate strokes are never geometrically joined and the lifted-finger jump is never counted. **Hide mouse cursor while tracking** removes the pointer over movement/stimulus areas while deliberately leaving it visible over settings so the option is reversible. Enable **Show movement trace beneath Flubber** to mirror the trace in a floating normalized overview below the Flubber. Neither rectangle constrains movement. Flubber dragging and directional manual changes are disabled while this source is selected, although Reset remains available and physical inputs remain logged during experiments.

This is an experimental movement-feedback prototype, not validated emotion recognition or diagnosis. Its algorithm, limitations, calibration rationale, and research provenance are documented in [`for-ai/60-EXPERIMENTAL-TOUCH-TRACE.md`](./for-ai/60-EXPERIMENTAL-TOUCH-TRACE.md) and [`for-ai/70-RESEARCH-PROVENANCE.md`](./for-ai/70-RESEARCH-PROVENANCE.md).

### Smartphone web viewer

The GitHub Pages application has a touch-first phone layout; no native smartphone app is required. On the first visit from a narrow touch-capable device, **Touch Lab** opens automatically but tracking remains off until the participant explicitly enables it. The phone viewer provides three compact 48 px tabs, safe-area/notch support, dynamic viewport height, a live Flubber preview beside the 2D valence–arousal map, and a large non-scrolling swipe pad. Secondary response, calibration, privacy, and display controls remain available in a collapsed options section. Portrait phones up to 600 CSS px wide and coarse-pointer phone landscape viewports up to 500 CSS px tall receive the compact layout.

Direct finger input uses primary W3C Pointer Events and pointer capture. The active swipe pad has `touch-action: none`, while surrounding settings remain vertically scrollable. Coalesced points are used when the browser supplies them and ordinary dispatched points remain the Safari-compatible fallback. Additional simultaneous touches are ignored. Phone layout changes presentation and discovery only; it uses the same `touch-trace-v9` signal algorithm, privacy boundary, adaptive calibration, and experiment CSV schema as larger browsers. The swipe-area trace uses raw surface coordinates without adaptive fitting or smoothing. V9 requires coherent winding for circular evidence and combines dominant corners, directional disorder, sign changes, and reversals for the angular/random command; elliptical thumb loops are accepted.

## Visual mapping

The animation preserves the default AffectTracker mapping while using deterministic seeded irregularity and frame-rate-independent input smoothing:

```text
frequency = 1.5 + arousal             (0.5–2.5 Hz)
amplitude = 0.3 + 0.1 × arousal       (0.2–0.4)
shape mix = (valence + 1) / 2          (pointy→rounded)
disorder  = 0.4 × (1 - valence)        (irregular→regular)
```

The SVG has 192 radial samples and 16 projections. Both apps expose a four-anchor Up/Down/Left/Right palette and an exact interactive 2D color-space picker; the neutral center blends outward toward the configured axis colors. In the web Settings panel, the picker contains a miniature copy of the live animated Flubber and numeric coordinates. Click, drag, or use the arrow keys to move it while judging palette choices.

## Logging and privacy

The normal tracker session keeps a fixed-size ring buffer of at most 10,000 records:

- Semantic input events such as key/button presses, wheel changes, resets, mode changes, drag completion, export, and buffer clearing.
- Affect samples at 20 Hz while the page is visible.

Everything stays inside the current browser tab. Nothing is uploaded and there are no analytics. Closing or refreshing the page discards records that have not been downloaded. Use **Download CSV** to export the current session in chronological order.

### Remote study demonstration

Choose **Start experiment** to run a 3–2–1 countdown, force affect to neutral, begin an isolated 20 Hz recording session, and show a protected 16:9 stimulus centered at the largest size that leaves the Flubber unobstructed. The player has no controls, cannot receive pointer or keyboard interaction, and automatically exports the experiment CSV when the selected segment ends. Every experiment row includes monotonic elapsed time, ISO wall time, stimulus identity/time, current and target valence/arousal, and widget position. During acquisition, physical key press/release, mouse-button press/release, and wheel events are also recorded; typed characters are never recorded. Pointer movement is captured and written only when the visibly enabled Experimental Touch/Trackpad source is active and the stimulus is actually playing. It cannot capture other tabs, browser chrome, background pages, or other applications.

The top-left interface uses three mutually exclusive accordion toggles: **Affect Tracker Settings**, **Experiment**, and **Touch/Trackpad Playground**. Experiment sessions use an append-only chunked CSV writer so raw pointer points and 20 Hz samples never roll over with the normal 10,000-record buffer. Buffering pauses active-time sampling, partial trials are marked with a stop reason, and a failed export can be retried from the Experiment panel.

Touch experiments distinguish `pointer_raw`, `touch_metric`, `sample`, and `event` rows. Extended columns retain observed pointer coordinates, filtered speed, cross-stroke speed-continuity state, circle/angular scores, winding, radial variation, heading entropy, dominant-corner count, direction-reversal evidence, cursor visibility, feedback behavior, gate identity/duration/commit, live rates and accumulated live deltas, per-gate calibration counts, adaptive bounds, confidence, normalized touch targets, displayed affect state, wall time, active playback time, and player time so researchers can reconstruct or replace the online normalization. Trials configured over 30 minutes show a local file-size warning without blocking playback.

The default stimulus is [`site/assets/dictator-3-study.mp4`](./site/assets/dictator-3-study.mp4), a 1920×1080 H.264/AAC copy of `Dictator 3.m4v` trimmed so its first frame corresponds to the original 90-second point. It is preloaded from GitHub Pages and does not contact a third party. Researchers can instead select **YouTube URL**, paste any supported watch/share/embed URL, and provide explicit start and finish seconds. That optional mode connects to YouTube and is subject to YouTube embedding permissions and playback policy; the affect CSV still remains local.

The widget appearance, position, bindings, input behavior, and panel state are saved in `localStorage`. Affect values and history are not persisted.

### Experimental Meta Quest WebXR study

Open [`site/webxr.html`](./site/webxr.html) in Meta Quest Browser and choose either the bundled flat-screen Great Dictator clip or one of eight full-sphere CEAP-360VR stimuli. The CEAP choices are exact one-minute excerpts from the dataset's validated frame ranges and are silent because the distributed source files contain no audio. The right controller thumbstick continuously steers valence and arousal, left **X** resets to neutral, and left **Y** pauses or resumes playback. Presentation can use a virtual background, headset passthrough behind the flat video, or passthrough with Flubber alone and no video. An optional pre-entry controller-follow mode rigs Flubber just above the selected left or right grip pose, with an independent 0.5–2× size control; fixed placement remains the default, and a brief tracking loss holds the last valid pose. The page samples at 20 Hz and prepares a stimulus-labelled CSV download when the video finishes or the immersive session exits. Every row includes stimulus provenance, presentation mode, and Flubber configuration. A researcher may enter a per-run HTTPS webhook before entering VR; if delivery fails or no webhook is configured, the CSV remains available for headset download. The webhook address is not persisted.

This path is intentionally isolated from the general browser tracker. It does not publish LSL, load arbitrary local/YouTube stimuli, import saved tracker settings, or use the experimental touch trace. The APK launcher button opens the hosted URL through Android's browsable-link intent. Physical controller mapping, media playback, file download, and webhook delivery still require acceptance testing in Meta Quest Browser before study use. CEAP media are not covered by the repository's BSD-3-Clause software license; see [`site/assets/ceap/NOTICE.md`](./site/assets/ceap/NOTICE.md) for the dataset reference and excerpt details.

## Shared customization JSON

The online and desktop apps expose the same input behavior, physical bindings, four-axis colors, flubber size, visibility, position, and 0–100% transparency control. Their advanced menus also expose animation speed, pulse amplitude, shape disorder, and optional input assignments for increasing or decreasing those features, transparency, and size. Choose **Export settings JSON** in either app and import that file in the other. A desktop-exported file therefore produces the same flubber palette, geometry, transparency, controls, and placement in the browser, subject only to viewport constraints and the desktop overlay versus browser black-stage difference.

The portable schema stores transparency as `overlay.opacity` (`1` is opaque, `0` is fully transparent). Additive version-1 `visual` and `advancedBindings` fields preserve backward compatibility with older version-1 files. The schema also carries the LSL stream metadata: GitHub Pages preserves those values for round-tripping, although a browser cannot publish LSL.

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

It covers the affect mappings, normalized profiles, deterministic offsets, path generation, smoothing, keyboard/wheel movement, widget and experiment-video/trace constraints, stimulus configuration parsing, ring-buffer rollover, append-only experiment logging, session reset, experiment context fields, CSV escaping, 1€ conformance values, theoretical and thumb-like angular/circular path metrics, sampling-rate invariance, continuous inactivity decay, gated live move-and-hold integration, release-without-overshoot, per-window adaptive calibration, raw surface projection, and normalized floating-trace fitting.

## Deployment

Pushes to `main` run the tests and deploy only the contents of `site/` through GitHub Actions and GitHub Pages. In the repository settings, Pages must use **GitHub Actions** as its source.

The separate desktop workflow builds the WebViews and runs Rust formatting, checks, tests, and clippy on Windows, macOS, and Linux. Release tags package the unsigned installers on their matching operating systems.

## Attribution and license

The affect mapping, circular projection model, and visual concept derive from:

> Fourcade A, Malandrone F, Roellecke L, Ciston A, Mooij JD, Villringer A, Carletto S and Gaebler M (2025). AffectTracker: real-time continuous rating of affective experience in immersive virtual reality. Frontiers in Virtual Reality 6:1567854. <https://doi.org/10.3389/frvir.2025.1567854>

The original AffectTracker project is Copyright © 2024 Antonin Fourcade and is distributed under the BSD 3-Clause License. This web implementation retains that license and attribution; see [LICENSE](./LICENSE).
