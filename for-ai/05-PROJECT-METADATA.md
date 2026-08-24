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

Maintain one research-quality 2D valence/arousal tracker with two coordinated delivery forms:

1. a dependency-free GitHub Pages application for online studies, local CSV acquisition, portable customization, video experiments, and an experimental Meta Quest WebXR selectable video library; and
2. a cross-platform Tauri v2 desktop companion with a Rust authority layer, transparent always-on-top overlay, global physical-input capture, and always-on local LSL streams.

The web, desktop, and Quest applications must feel like the same instrument. Shared affect semantics, rendering mathematics, portable settings, terminology, accessibility, and privacy rules should remain aligned unless this directory records an explicit platform exception.

## Global constraints

- Research data stays participant-local unless a reviewed mode explicitly asks the participant or researcher for a destination. The experimental WebXR study may send its completed CSV only to an HTTPS webhook typed for that run; the URL is not persisted, and download remains available if delivery is absent or fails.
- Never record composed text, clipboard content, application contents, unrelated window titles, or other unnecessary personal data. Pointer movement is permitted only under the explicit, visible web-only Experimental Touch/Trackpad source described in `60-EXPERIMENTAL-TOUCH-TRACE.md`; raw points are logged only during active experiment playback. Polar H10 physiology is permitted only after the user-triggered browser chooser described in `65-EXPERIMENTAL-POLAR-STREAM.md`; raw ECG remains bounded in memory and is never persisted.
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
- `site/`: dependency-free online application and online-only experiment module.
- `site/src/touch-trace.js`: browser-only trajectory filtering, equal-distance geometry, direct continuous and gated live move-and-hold feedback, adaptive calibration, and trace fitting.
- `site/src/polar-stream.js`: browser-only Web Bluetooth capability boundary, Polar H10 PMD/heart-rate decoding, bounded ECG/RR metrics, and GATT lifecycle.
- `site/src/mobile.js`: browser-only narrow touch-capable viewport detection for one-time smartphone Touch Lab discovery; responsive presentation remains in `site/styles.css`.
- `site/src/accordion-protocols.js`: canonical registry for the four top-level web modules, their distinct responsibilities, mutually exclusive open state, and cross-module Touch/Trackpad activation rule.
- `site/webxr.html`, `site/src/webxr-study.js`, `site/src/webxr-study-core.js`, and `site/src/webxr-stimuli.js`: experimental headset-browser study entrypoint, flat/equirectangular WebXR/WebGL adapter, selectable repository-hosted stimulus catalog, Quest-controller or explicitly assigned Polar-metric affect input, stimulus-aware CSV download, and explicit per-run webhook delivery.
- `for-ai/70-RESEARCH-PROVENANCE.md` and `for-ai/references.bib`: source-decision ledger and citation-ready bibliography.
- `for-ai/65-EXPERIMENTAL-POLAR-STREAM.md`: normative Polar Stream support, privacy, metric, mapping, precedence, and qualification contract.
- `desktop/`: Tauri WebView presentation and typed native adapter.
- `.github/workflows/`: deployment, verification, and native packaging automation.

If these sources disagree, stop and resolve the inconsistency deliberately. Do not silently choose whichever implementation is easiest.
