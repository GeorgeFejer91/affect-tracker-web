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

Polar angle selects the green-to-red-to-green gradient position. Polar radius controls saturation. The SVG uses 192 angular samples, 16 projections, deterministic seeded phase/amplitude offsets, frame-time-based animation, and exponential coordinate smoothing.

## Online application

- Hosted completely by GitHub Pages under the repository project path.
- Works without a build step or runtime dependency after static assets load.
- Fullscreen black study surface with a draggable affect widget.
- Arrow/WASD, wheel/trackpad, and accessible on-screen controls.
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
- Provides system-tray controls for settings, overlay visibility/editing, reset, LSL state, and quit.
- Native Rust owns affect state, smoothing, timestamps, persisted settings, global shortcuts, and LSL publication.
- Users can assign shortcuts for positive/negative valence, positive/negative arousal, reset, pause, settings, and overlay editing.
- Shortcut conflicts and invalid mappings must produce actionable errors. Reconfiguration unregisters replaced shortcuts.
- Bare-key system-wide capture is not a v1 requirement. Global shortcut combinations are the safe default.
- Settings include input mode, step size, held-input speed, smoothing response, overlay size/opacity/position, LSL names/rate/autostart, and shortcut bindings.
- The canonical native icon is `desktop/icons/app-icon.svg`; regenerate platform PNG, ICO, and ICNS assets with `pnpm desktop:icons` after changing it.
- Settings persist in the operating system application configuration directory. Affect history does not silently persist.

## LSL output

The desktop app publishes two outlets when enabled:

1. `AffectTracker` (configurable name/type), regular `float32`, default 50 Hz:
   - `current_valence`
   - `current_arousal`
   - `target_valence`
   - `target_arousal`
   - `radius`
   - `angle_degrees`
   - `animation_active`
   - `input_active`
2. `AffectTrackerMarkers`, irregular string markers for input press/release, reset, pause/resume, mapping changes, overlay movement, and session lifecycle.

Streams include schema/app version, session UUID, coordinate range, units, sample rate, and source identity metadata. LSL operates locally and must never be described as cloud upload.

## Accessibility and privacy

- Keyboard access, semantic controls, labels, visible focus, high contrast, and polite status announcements are required.
- Respect `prefers-reduced-motion` without disabling affect input.
- Global shortcuts and autostart are user-controlled and can be disabled.
- No keystroke text, clipboard contents, unrelated window names, or background activity is logged.
- Local recording/export behavior must be explicit and documented.
