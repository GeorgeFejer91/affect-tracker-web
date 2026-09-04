# Read this first

This directory is the durable active brief for **Affect Tracker Research**.
Every future agent must read every Markdown file here completely and in lexical
filename order before taking project action.

## Authority map

- [`15-RESEARCH-V1-CHARTER.md`](./15-RESEARCH-V1-CHARTER.md) is the sole active
  product and architecture authority.
- [`05-PROJECT-METADATA.md`](./05-PROJECT-METADATA.md) records repository,
  checkpoint, product, and source identity.
- [`10-PRODUCT-REQUIREMENTS.md`](./10-PRODUCT-REQUIREMENTS.md) restates the
  user-visible contract.
- [`20-ARCHITECTURE.md`](./20-ARCHITECTURE.md) assigns native, browser, media,
  timing, data, and presentation authority.
- [`30-TESTING-AND-RELEASE.md`](./30-TESTING-AND-RELEASE.md) defines acceptance
  and qualification evidence.
- [`40-ROADMAP.md`](./40-ROADMAP.md) is the implementation-status authority.
- [`50-AGENT-WORKFLOW.md`](./50-AGENT-WORKFLOW.md) defines change discipline and
  skill routing.
- [`70-RESEARCH-PROVENANCE.md`](./70-RESEARCH-PROVENANCE.md) and
  [`references.bib`](./references.bib) record active source decisions.

Target language is never evidence that implementation or qualification has
landed. Use the roadmap and exact candidate receipts before making a claim.

## Product boundary

Affect Research is a local-first continuous valence/arousal research instrument
with exactly two user-visible modes:

1. **Setting Up the Experiment** — authorize a workspace; load, validate, and
   save settings; configure experiment, stimuli, counterbalancing, input,
   visual feedback, mappings, and outbound LSL; then pass preflight.
2. **Running the Experiment** — freeze the resolved attempt, play complete
   stimuli, acquire ratings independently of rendering, persist local evidence,
   and complete or retain an explicit partial/recoverable result.

Active v1 qualifies only Windows Tauri and the static application in current
desktop Chrome and Edge. It has no WebXR, Quest, remote-control, collaboration,
direct physiology, face, touch-inference, account, upload, analytics, telemetry,
or backend surface.

## Non-negotiable boundaries

- Preserve BSD-3-Clause licensing and attribution to
  [`afourcade/AffectTracker`](https://github.com/afourcade/AffectTracker).
- Keep settings, plans, stimuli identity, ratings, events, journals, and
  manifests local to the selected workspace/application namespace.
- Treat WebView/browser input, imported JSON, directory contents, and every IPC
  argument as untrusted. Validate at the owning boundary.
- Freeze one normalized `ResearchSettingsV1`, one
  `ResolvedAssignmentPlanV1`, bindings, participant derivation, and geometry
  for each attempt.
- Keep the research scheduler independent of video rendering and animation.
  Emit a timing-gap event for missed deadlines; never invent catch-up rows.
- Never silently discard accepted rows or overwrite a prior attempt. Recovery
  resumes only at a safe stimulus boundary.
- Keep keyboard operation, visible focus, semantic labels/status, non-color
  meaning, contrast, and reduced-motion behavior.
- Tauri Rust owns native workspace, input, playback, scheduler, timestamps,
  persistence, and outbound LSL authority. The WebView receives only narrow
  typed projections and opaque identifiers.
- Qualified Windows local/repository playback targets bundled libVLC 3.0.23.
  The application never downloads it at runtime or searches for a system VLC.
  Missing, modified, wrong-architecture, or unavailable native playback fails
  closed. The WebView player is an explicitly selected, receipt-labelled
  unqualified development fallback only.
- The checked-in runtime pin, deterministic stager, tree verifier, and
  capability report do not constitute the player actor or playback
  qualification. The contained `unsafe` dynamic-library/libVLC/Win32 adapter
  remains subject to explicit user approval and audit.
- Update this directory whenever product scope, schema, authority, timing,
  privacy, supported platforms, persistence, media, LSL, or release gates
  change.

## Historical lineage

The former feature-rich application, its documentation, assets, tests, and
full branch/tag graph are preserved in the public
[`affect-tracker-playground`](https://github.com/GeorgeFejer91/affect-tracker-playground)
repository and remain reachable through this repository's Git history. They
were deliberately removed from the active Research source tree. Historical
presence or evidence never qualifies the changed Research runtime.
