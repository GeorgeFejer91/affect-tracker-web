# Product requirements

## Shared affect model

Both applications represent valence as `x` and arousal as `y`, each clamped to `[-1, 1]`, starting at neutral `(0, 0)`.

The shared visual mappings are:

```text
frequency = 1.5 + y
amplitude = 0.3 + 0.1y
shapeMix = (x + 1) / 2
disorder = 0.4(1 - x)
```

The SVG uses 192 angular samples, 16 projections, deterministic seeded phase/amplitude offsets, frame-time-based animation, and exponential coordinate smoothing. Both runtimes expose four configurable Up/Down/Left/Right hex colors and an exact 2D blended feature-space picker; neutral remains visually neutral.

## Online application

- Hosted completely by GitHub Pages under the repository project path.
- Works without a build step or runtime dependency after static assets load.
- Fullscreen black study surface with a draggable affect widget.
- Configurable keyboard, mouse-button, wheel/trackpad, and accessible on-screen controls; arrow keys are the defaults.
- An advanced menu can optionally bind physical inputs to increase or decrease animation speed, pulse amplitude, shape disorder, transparency, and widget size.
- Interactive 2D color-space coordinate selection and four persisted axis colors.
- Continuous and step modes, reset, pause, reduced-motion support, and visible focus.
- Browser-only 10,000-record normal-session ring buffer with 20 Hz affect sampling and CSV export. Experiments use an append-only, chunked CSV writer that never rolls over and remains available for retry if export fails.
- A separate browser-local `inputSource` selects ordinary manual controls or the visibly labelled **Experimental Touch/Trackpad** prototype. It is not part of portable settings version 1 and has no Tauri/LSL counterpart.
- In the experimental source, pointer shape maps to valence and pointer speed maps to arousal. Touch/pen capture works page-wide; mouse and laptop touchpads use the OS-accelerated cursor trajectory exposed by the browser. Manual direction controls remain logged but cannot change affect, and Flubber dragging is disabled.
- Short rapid paths must produce useful arousal feedback after two measured movement segments. The last mapped touch result is held for 1.8 seconds after input and then decays gradually with a 3-second time constant, allowing participants to reach and perceive extrema without continuous long movement.
- The optional, locally persisted movement-trace panel shows the last four seconds below the Flubber with aspect-preserving normalization, fading rainbow segments, detected pointer type, shape/speed labels, and calibration confidence. It is feedback, not a constrained drawing surface.
- Three stacked, mutually exclusive accordion toggles label the surfaces **Affect Tracker Settings**, **Experiment**, and **Touch/Trackpad Playground**. The playground is visibly marked **Experimental**, contains the primary enable/disable tracking switch, and shows a live practice trace plus shape, speed, confidence, and pointer-type feedback without requiring a video experiment.
- Online-only experiment module that requests fullscreen from the Start-button gesture, runs a 3–2–1 countdown, resets to neutral, records an isolated 20 Hz session, protects a centered 16:9 player, keeps the Flubber centered directly beneath the video without overlap, automatically downloads CSV at the selected segment end, and exits fullscreen during cleanup. A declined or unsupported fullscreen request must not prevent the experiment.
- The preloaded GitHub Pages example is a repository-hosted 1080p H.264/AAC video trimmed at the source's 90-second point. Researchers may alternatively provide any embeddable YouTube URL plus explicit start and finish seconds; this optional connection is disclosed and never changes the desktop app.
- Experiment CSV rows add experiment/stimulus identity and stimulus time. Acquisition records every physical key press/release, mouse-button press/release, and wheel event without typed text. When—and only when—the experimental source is visibly active, every observed/coalesced pointer point is written as `pointer_raw`, 20 Hz touch features/bounds as `touch_metric`, and displayed coordinates as `sample`.
- No upload, analytics, account, server, or persistent affect history. The movement prototype quantifies path behavior for feedback; it is not validated emotion recognition or diagnosis.
- Must remain suitable for placing next to or integrating with browser-based study stimuli.
- In supporting browsers, provide an explicit user-activated Document Picture-in-Picture checkbox that mirrors the live Flubber in an always-on-top browser-owned window. Make every site-controlled surface transparent, borderless, and edge-to-edge; request reduced browser chrome. It must close with the originating page and degrade clearly when unsupported. Never claim the browser-controlled frame or compositor surface is transparent.

## Desktop companion

- Product name: `Affect Tracker Desktop`.
- Bundle identifier: `io.github.georgefejer91.affecttracker`.
- Built with Tauri v2, Rust, HTML/CSS, native ES modules, and SVG.
- Runs without internet access on Windows, macOS, and Linux.
- Uses a normal settings window and a separate transparent, borderless, always-on-top overlay window.
- Overlay is click-through when locked and draggable only in explicit edit-position mode.
- Provides system-tray controls for settings, overlay visibility/editing, reset, and quit.
- Closing the main settings window quits the entire application and removes the overlay; it must never leave an orphan floating widget.
- Native Rust owns affect state, smoothing, timestamps, persisted settings, global raw-input monitoring, and LSL publication.
- Users assign positive/negative valence, positive/negative arousal, reset, pause, settings, and overlay editing by clicking a field and physically pressing a key, mouse button, or wheel direction.
- Optional advanced global bindings adjust animation speed, pulse amplitude, shape disorder, transparency, and overlay size in bounded increments; every assignment remains collision-free across standard and advanced actions.
- Plain arrow keys are the default affect controls. Assignments remain active while other applications are focused; conflicts and invalid mappings produce actionable errors.
- Settings include input mode, step size, held-input speed, smoothing response, axis colors, overlay size/transparency/position, persisted LSL names/rate/source, and physical input bindings.
- The canonical native icon is `desktop/icons/app-icon.svg`; regenerate platform PNG, ICO, and ICNS assets with `pnpm desktop:icons` after changing it.
- Settings persist in the operating system application configuration directory. Affect history does not silently persist.

## Portable settings

- `site/settings.json` is the canonical version-1 JSON defaults file and must deserialize as native Rust `Settings` without migration.
- Web and desktop import and export the same complete JSON object. Palette, size, opacity, visibility, coordinates, input behavior, bindings, and LSL metadata must round-trip without visual or semantic loss.
- Version 1 remains the active schema: `visual` and `advancedBindings` are additive fields with defaults, so older version-1 files import safely with neutral visual multipliers and no advanced assignments.
- The user-facing transparency control spans 0% (fully opaque) through 100% (fully transparent); the JSON stores the inverse `overlay.opacity` in `[0,1]`.
- The web app exposes every portable customization. It preserves LSL metadata for transfer but cannot publish LSL, and global browser bindings only operate while the page is focused.
- Browser preferences may override bundled defaults for returning users. Replacing `site/settings.json` changes defaults for new/clean browser profiles; importing applies a file immediately.
- Experiment stimulus source/URL/timing are browser-study configuration, not portable Flubber settings, and are intentionally absent from the desktop-compatible version-1 JSON.

## LSL output

The desktop app publishes two outlets automatically for its entire process lifetime:

1. `AffectTracker` (configurable name/type), regular `float32`, default 50 Hz:
   - `current_valence`
   - `current_arousal`
   - `target_valence`
   - `target_arousal`
   - `radius`
   - `angle_degrees`
   - `animation_active`
   - `input_active`
2. `AffectTrackerMarkers`, irregular string markers for every physical key press/release, mouse-button press/release, wheel event, reset, pause/resume, mapping changes, overlay movement, and session lifecycle. Emit physical identifiers, never composed characters or typed text.

Streams include schema/app version, session UUID, coordinate range, units, sample rate, and source identity metadata. LSL operates locally and must never be described as cloud upload.

## Accessibility and privacy

- Keyboard access, semantic controls, labels, visible focus, high contrast, and polite status announcements are required.
- Respect `prefers-reduced-motion` without disabling affect input.
- Global monitoring and LSL are core runtime behavior, not optional start/stop toggles. The UI must disclose this clearly.
- No typed characters, clipboard contents, unrelated window names, or application contents are logged. The web-only experimental source has the narrowly scoped pointer-movement exception documented above; it cannot observe other tabs, browser chrome, or applications. Physical key identifiers and button/wheel events are emitted to local desktop LSL by design.
- Local recording/export behavior must be explicit and documented.
