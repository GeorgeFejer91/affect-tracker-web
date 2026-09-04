# Read this first

This directory is the durable brief for **Affect Tracker Research**. Every
future AI agent must read every Markdown file here, in lexical filename order,
before taking project action.

[`15-RESEARCH-V1-CHARTER.md`](./15-RESEARCH-V1-CHARTER.md) is the sole active
product and architecture authority. [`05-PROJECT-METADATA.md`](./05-PROJECT-METADATA.md)
records identity and the active/frozen source map;
[`10-PRODUCT-REQUIREMENTS.md`](./10-PRODUCT-REQUIREMENTS.md),
[`20-ARCHITECTURE.md`](./20-ARCHITECTURE.md), and
[`30-TESTING-AND-RELEASE.md`](./30-TESTING-AND-RELEASE.md) refine the active
requirements, ownership, and evidence gates. [`40-ROADMAP.md`](./40-ROADMAP.md)
is the implementation-status authority. Target language is never evidence that
the corresponding implementation or qualification has landed.

Documents explicitly marked **Frozen Playground/history** preserve the
feature-rich checkpoint's design, safety rules, provenance, and evidence. They
are not active-v1 requirements or release gates. Their code may remain during
the migration, but code presence is not support and must not be described as
removal. Safety, privacy, attribution, and licensing rules continue to bind any
frozen code that is still reachable.

## Active project purpose

Affect Tracker Research is a local-first continuous valence/arousal research
instrument with exactly two user-visible application modes:

1. **Setting Up the Experiment** — load, validate, edit, and save `settings.json`;
   position and lock the overlay; configure the controller, appearance,
   Flubber, Grid, outbound LSL, affect mappings, sampling, and automatic
   condition allocation; then deliberately start a session.
2. **Running the Experiment** — freeze the validated setup, collect continuous
   ratings, publish Windows LSL when enabled, persist local research rows, and
   finish or retain an explicitly partial record after interruption.

Active v1 has two supported delivery surfaces only:

- the Tauri desktop application on Windows; and
- the static web application in current desktop Google Chrome and Microsoft
  Edge.

The default sampling frequency is 130 Hz and the valid configured range is
1–240 Hz. Continuous rating is always enabled. Active v1 has no summary-only,
single-summary, step-acquisition, immersive, headset, remote, face, or direct
physiology mode.

## Non-negotiable workflow

- Preserve the BSD-3-Clause license and attribution to `afourcade/AffectTracker`.
- Keep research data participant-local. Active v1 has no upload, webhook,
  account, analytics, telemetry, remote-control, collaboration, or direct-sensor
  network path.
- Treat browser state, Tauri WebViews, imported JSON, and IPC arguments as
  untrusted. Validate schemas, ranges, identifiers, colors, mappings, and file
  ownership at the owning boundary.
- One run consumes one immutable normalized settings snapshot and one automatic
  `balanced-v1` allocation. Setup edits cannot drift into a running session.
- The research clock, recorder, and Windows LSL publisher must not depend on
  renderer cadence. Never invent catch-up samples after a stall.
- A final or interrupted run must remain recoverable as local CSV or TSV. Never
  silently discard accepted rows.
- Keep keyboard access, labels, visible focus, high contrast, reduced-motion
  behavior, and polite status announcements without changing coordinate
  meaning.
- Test only the active Windows Tauri and desktop Chrome/Edge support matrix for
  active-v1 release claims. Historical platform evidence remains historical.
- Do not extend, repair, or expose a frozen feature unless the user explicitly
  reactivates it through a charter change. Narrow security, privacy, licensing,
  or build-containment work remains permissible when frozen code is still
  shipped or reachable.
- Update this directory whenever requirements, schemas, authority, data fields,
  privacy, supported platforms, or release gates change.
- Publication is part of a completed validated implementation change, subject
  to the user's current instructions and repository safeguards. Documentation-
  only planning or an explicit no-commit/no-push request does not authorize Git
  or GitHub mutation.

## Frozen Playground/history

The feature-rich checkpoint preserves the former mirrored Pages/Tauri/WebXR
program, native Quest application, remote-control and VDO.Ninja protocols,
Face/Photoatlas work, direct Polar H10 acquisition, Touch/Trackpad inference
prototype, and the other presentation experiments documented below. These are
reference material only for active v1 unless a later charter explicitly
reactivates a bounded feature.
