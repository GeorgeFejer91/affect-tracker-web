# Read this first

This directory is the durable brief for the Affect Tracker project. Every future AI agent must read every Markdown file here, in filename order, before taking any project action.

The repository root is the central project folder. [`05-PROJECT-METADATA.md`](./05-PROJECT-METADATA.md) records its identity, goals, global constraints, and source-of-truth map. [`50-AGENT-WORKFLOW.md`](./50-AGENT-WORKFLOW.md) defines the mandatory agent approach, skill routing, living-documentation policy, and Git checkpoint/clean-tree rules.

## Project purpose

Provide one 2D valence/arousal affect tracker in two delivery forms:

1. An online, dependency-free GitHub Pages application suitable for browser studies and integration beside web stimuli such as videos.
2. An offline, downloadable Tauri desktop companion for Windows, macOS, and Linux that can remain above other applications and publish research data through Lab Streaming Layer (LSL).

The two forms must share affect semantics and visual mathematics. Differences are permitted only where the runtime requires them, such as browser CSV export versus native LSL streaming.

## Non-negotiable workflow

- Read this directory before source files.
- Preserve the BSD-3-Clause license and attribution to `afourcade/AffectTracker`.
- Keep browser operation local and private by default: no analytics, telemetry, CDN, external font, or silent runtime API dependency. The bundled experiment stimulus is repository-hosted. YouTube is an explicit user-selected stimulus source and must disclose the third-party connection before playback.
- Treat Tauri WebViews and IPC arguments as untrusted. Native authority stays in Rust behind narrow typed commands.
- Do not introduce remote WebView content, generic shell execution, unrestricted filesystem/network permissions, or silent global input capture.
- Test web and desktop behavior proportionally to each change.
- Update these documents when an approved product requirement or architecture decision changes.
