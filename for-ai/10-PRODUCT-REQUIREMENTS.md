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
- Arrow/WASD, wheel/trackpad, and accessible on-screen controls.
- Interactive 2D color-space coordinate selection and four persisted axis colors.
- Continuous and step modes, reset, pause, reduced-motion support, and visible focus.
- Browser-only 10,000-record ring buffer with 20 Hz affect sampling and CSV export.
- No upload, analytics, account, server, or persistent affect history.
- Must remain suitable for placing next to or integrating with browser-based study stimuli.

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
- Plain arrow keys are the default affect controls. Assignments remain active while other applications are focused; conflicts and invalid mappings produce actionable errors.
- Settings include input mode, step size, held-input speed, smoothing response, axis colors, overlay size/opacity/position, persisted LSL names/rate/source, and physical input bindings.
- The canonical native icon is `desktop/icons/app-icon.svg`; regenerate platform PNG, ICO, and ICNS assets with `pnpm desktop:icons` after changing it.
- Settings persist in the operating system application configuration directory. Affect history does not silently persist.

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
- No typed characters, clipboard contents, mouse movement, unrelated window names, or application contents are logged. Physical key identifiers and button/wheel events are emitted to local LSL by design.
- Local recording/export behavior must be explicit and documented.
