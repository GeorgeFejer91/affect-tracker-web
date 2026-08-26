# Read this first

This directory is the durable brief for the Affect Tracker project. Every future AI agent must read every Markdown file here, in filename order, before taking any project action.

The repository root is the central project folder. [`05-PROJECT-METADATA.md`](./05-PROJECT-METADATA.md) records its identity, goals, global constraints, and source-of-truth map. [`50-AGENT-WORKFLOW.md`](./50-AGENT-WORKFLOW.md) defines the mandatory agent approach, skill routing, living-documentation policy, and Git checkpoint/clean-tree rules. [`60-EXPERIMENTAL-TOUCH-TRACE.md`](./60-EXPERIMENTAL-TOUCH-TRACE.md), [`65-EXPERIMENTAL-POLAR-STREAM.md`](./65-EXPERIMENTAL-POLAR-STREAM.md), and [`66-EXPERIMENTAL-REMOTE-FLUBBER.md`](./66-EXPERIMENTAL-REMOTE-FLUBBER.md) are the normative contracts for the web-only movement prototype, browser/native H10 prototype, and explicit browser-to-browser coordinate transport. [`70-RESEARCH-PROVENANCE.md`](./70-RESEARCH-PROVENANCE.md) is the mandatory source ledger for research-derived ideas.

## Project purpose

Provide one valence/arousal affect tracker in three delivery forms:

1. An online, static and self-contained GitHub Pages application suitable for browser studies and integration beside web stimuli such as videos, including an explicitly experimental Meta Quest WebXR library with the flat Great Dictator clip and eight CEAP-360VR one-minute immersive stimuli. Optional remote Flubber uses only its checked-in VDO.Ninja SDK, never a CDN or project backend.
2. An offline, downloadable Tauri desktop companion for Windows, macOS, and Linux that can remain above other applications and publish research data through Lab Streaming Layer (LSL).
3. A native Meta Quest Spatial SDK APK that plays researcher-provided local video, displays the same procedural Flubber on a transparent movable spatial panel, accepts Touch-controller input or explicitly assigned Polar H10 metrics, and publishes the desktop-compatible LSL schema over the local network.

The three forms must share affect semantics and visual mathematics. Differences are permitted only where the runtime requires them, such as browser CSV export, desktop global input, and Quest spatial placement/video playback.

## Non-negotiable workflow

- Read this directory before source files.
- Preserve the BSD-3-Clause license and attribution to `afourcade/AffectTracker`.
- Keep browser operation local and private by default: no analytics, telemetry, CDN, external font, or silent runtime API dependency. The bundled experiment stimulus is repository-hosted. YouTube is an explicit user-selected stimulus source and must disclose the third-party connection before playback.
- Pointer trajectories are a narrow privacy exception: capture them only while the user has visibly selected Experimental Touch/Trackpad control, and write raw points only during active experiment playback.
- Physiological data are a second explicit opt-in exception: Polar H10 acquisition requires either a user-triggered browser chooser or the native launcher's explicit Connect action plus Android nearby-device permission, retains only bounded raw ECG in memory, and never writes raw 130 Hz ECG to CSV, LSL, JSON, or portable settings.
- Remote Flubber is a third explicit opt-in exception: only a fresh user press may connect to VDO.Ninja, only final anonymous X/Y coordinates may leave the source browser, and every session must disclose public discovery, peer-IP visibility, third-party signaling/STUN/TURN, and possible relay latency. See `66-EXPERIMENTAL-REMOTE-FLUBBER.md`.
- Treat Tauri WebViews and IPC arguments as untrusted. Native authority stays in Rust behind narrow typed commands.
- Do not introduce remote WebView content, generic shell execution, unrestricted filesystem/network permissions, silent global input capture, or any network path outside the reviewed exceptions above.
- Test web, desktop, and Quest behavior proportionally to each change, using cross-language golden vectors where code cannot be shared directly.
- Update these documents when an approved product requirement or architecture decision changes.
- **Publication is part of completion.** After every completed and validated in-scope change—including source, assets, configuration, tests, and `for-ai/` documentation—create a coherent commit and push it to the canonical GitHub repository as soon as practical. This is standing project authorization for routine publication; do not leave finished work only in a local commit or ask again for ordinary push permission. A web-facing change is not complete until the exact pushed commit has passed the standard GitHub Pages workflow and the public project-path URL has been opened and verified. For a non-site change, verify that the commit is publicly visible in the canonical repository and that the Pages workflow remains healthy; do not falsely imply that repository-only files are served by the website. Delay publication only for an explicit user request for local-only/no-push work, failed validation, unavailable credentials/CI, ambiguous ownership, or another concrete safety blocker, and report that blocker immediately.
