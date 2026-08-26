# Project metadata and global goals

## Canonical identity

- Project: **Affect Tracker**
- Canonical repository: <https://github.com/GeorgeFejer91/affect-tracker-web>
- Public web application: <https://GeorgeFejer91.github.io/affect-tracker-web/>
- Primary branch: `main`
- License: BSD-3-Clause
- Origin attribution: [`afourcade/AffectTracker`](https://github.com/afourcade/AffectTracker)
- Canonical Windows working clone: `C:\Users\gyorg\Documents\GitHub\affect-tracker-web`

The Git repository root is the central project folder. Do not create a second independent "master" copy. On another machine or after a workspace move, discover the canonical local root with `git rev-parse --show-toplevel`; the absolute Windows path above is informational, not a portable configuration value.

## Project goal

Maintain one research-quality 2D valence/arousal tracker with three coordinated delivery forms:

1. a static, self-contained GitHub Pages application for online studies, local CSV acquisition, portable customization, video experiments, and an experimental Meta Quest WebXR selectable video library; and
2. a cross-platform Tauri v2 desktop companion with a Rust authority layer, transparent always-on-top overlay, global physical-input capture, and always-on local LSL streams; and
3. a native Meta Quest Spatial SDK APK with local spatial video, compositor passthrough, Touch or explicit Polar H10 affect input, and same-LAN LSL.

The web, desktop, and Quest applications must feel like the same instrument. Shared affect semantics, rendering mathematics, portable settings, terminology, accessibility, and privacy rules should remain aligned unless this directory records an explicit platform exception.

## Global constraints

- Research data stays participant-local unless a reviewed mode explicitly asks the participant or researcher for a destination. The experimental WebXR study may send its completed CSV only to an HTTPS webhook typed for that run; the URL is not persisted, and download remains available if delivery is absent or fails. The separate explicit remote-Flubber mode may publish only the anonymous final X/Y pair through the public VDO.Ninja room defined in `66-EXPERIMENTAL-REMOTE-FLUBBER.md`; it is never an experiment-record upload. The independent settings beacon may publish only one immutable copy of the complete portable settings JSON under `68-EXPERIMENTAL-SETTINGS-BEACON.md`; it sends no research records or live coordinates and requires preview plus explicit Apply at the receiver.
- Never record composed text, clipboard content, application contents, unrelated window titles, or other unnecessary personal data. Pointer movement is permitted only under the explicit, visible web-only Experimental Touch/Trackpad source described in `60-EXPERIMENTAL-TOUCH-TRACE.md`; raw points are logged only during active experiment playback. Polar H10 physiology is permitted only after the user-triggered browser chooser or native launcher Connect/permission flow described in `65-EXPERIMENTAL-POLAR-STREAM.md`; raw ECG remains bounded in memory and is never persisted.
- Keep the browser app static and GitHub Pages-compatible. Do not add a backend, telemetry, CDN, runtime package dependency, or remote asset silently.
- Keep native authority in Rust behind narrow typed Tauri commands/events/channels. Treat WebView input and imported settings as untrusted.
- Preserve product-module correspondence across UI and code. Every top-level product surface or accordion has one explicit protocol boundary with its own state, responsibilities, privacy/data contract, and tests. Shared shells coordinate visibility and documented precedence but do not absorb module-specific acquisition or business rules; native authority is exposed through matching narrow domain adapters rather than a generic privileged command layer.
- Preserve least-privilege capabilities, restrictive CSP, local packaged content, and clean native-resource shutdown.
- Do not claim browser features can provide the same transparent, click-through, OS-global overlay or global input capture as Tauri.
- Preserve Windows, macOS, and Linux packaging. State Linux Wayland global-input limitations accurately.
- Preserve BSD-3-Clause licensing, upstream attribution, release notices, lockfiles, and reproducible CI.
- Do not publish signed/notarized/store releases or handle signing credentials without explicit user authorization.

## Source-of-truth map

- `for-ai/`: durable project intent, constraints, architecture, testing, roadmap, and agent workflow.
- `site/src/math.js`: canonical SVG affect renderer for both delivery forms.
- `site/src/portable-settings.js` and `site/settings.json`: canonical browser-side portable settings contract/defaults.
- `src-tauri/`: authoritative Rust state, validation, persistence, input monitoring, lifecycle, and LSL implementation.
- `site/`: static online application and online-only experiment module; optional VDO.Ninja transport is checked in locally and requires no CDN, package install, or project backend.
- `site/src/touch-trace.js`: browser-only trajectory filtering, equal-distance geometry, direct continuous and gated live move-and-hold feedback, adaptive calibration, and trace fitting.
- `site/src/polar-stream.js`: browser-only Web Bluetooth capability boundary, Polar H10 PMD/heart-rate decoding, bounded ECG/RR metrics, and GATT lifecycle.
- `site/src/flubber-remote.js`: browser-neutral VDO.Ninja discovery, data-channel lifecycle, 12-byte Flubber coordinate protocol, sequencing, scheduling, staleness, diagnostics, and test injection boundary.
- `site/src/settings-beacon.js`: browser-neutral VDO.Ninja discovery and reliable ordered transfer for one immutable, validated portable-settings snapshot; it is independent from the coordinate protocol.
- `site/vendor/vdoninja/1.5.5/`: locally loaded unmodified official VDO.Ninja SDK distribution/source, MPL-2.0 license, provenance notice, and verified hashes.
- `vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/PolarH10Manager.kt`: application-scoped native Quest H10 discovery, official-SDK streaming, readiness, lifecycle, and privacy boundary.
- `vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/PolarMetrics.kt`: native bounded mirror of the browser's ten metric definitions, per-axis mappings, and readiness gate.
- `site/src/mobile.js`: browser-only narrow touch-capable viewport detection for one-time smartphone Touch Lab discovery; responsive presentation remains in `site/styles.css`.
- `site/src/theme-bootstrap.js`, `site/src/retro-theme.js`, and `site/assets/retro-ui/`: browser-local pre-paint Windows 95 skin restoration, deterministic low-volume UI cue routing, and pinned local Kenney CC0 audio. The theme never enters portable settings or forks product behavior.
- `site/src/accordion-protocols.js`: canonical registry for the four top-level web modules, their distinct responsibilities, mutually exclusive open state, and cross-module Touch/Trackpad activation rule.
- `site/webxr.html`, `site/src/webxr-study.js`, `site/src/webxr-study-core.js`, and `site/src/webxr-stimuli.js`: experimental headset-browser study entrypoint, flat/equirectangular WebXR/WebGL adapter, selectable repository-hosted stimulus catalog, Quest-controller, explicitly assigned Polar-metric, or explicit remote-coordinate affect input, stimulus-aware CSV download, and explicit per-run webhook delivery.
- `for-ai/70-RESEARCH-PROVENANCE.md` and `for-ai/references.bib`: source-decision ledger and citation-ready bibliography.
- `for-ai/65-EXPERIMENTAL-POLAR-STREAM.md`: normative Polar Stream support, privacy, metric, mapping, precedence, and qualification contract.
- `for-ai/66-EXPERIMENTAL-REMOTE-FLUBBER.md`: normative public discovery, wire protocol, input ownership, privacy, observability, and hardware qualification contract for browser-to-browser Flubber coordinates.
- `for-ai/68-EXPERIMENTAL-SETTINGS-BEACON.md`: normative public discovery, static snapshot, validation, preview/apply, and privacy contract for browser-to-browser portable settings.
- `desktop/`: Tauri WebView presentation and typed native adapter.
- `.github/workflows/`: deployment, verification, and native packaging automation.

If these sources disagree, stop and resolve the inconsistency deliberately. Do not silently choose whichever implementation is easiest.
