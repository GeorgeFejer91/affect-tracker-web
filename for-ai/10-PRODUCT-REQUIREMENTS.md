# Product requirements

## Status

[`15-RESEARCH-V1-CHARTER.md`](./15-RESEARCH-V1-CHARTER.md) is the sole active
authority. This file restates its user-visible requirements. The former
feature-rich requirements remain available in Git history and the frozen
checkpoint; they are not active requirements in this branch.

The documentation describes the target. Current implementation status belongs
in [`40-ROADMAP.md`](./40-ROADMAP.md).

## Product and support boundary

- Desktop name: **Affect Research**.
- Exactly two modes: **Setting Up the Experiment** and **Running the
  Experiment**.
- First qualification targets: Tauri on Windows and the static application in
  current desktop Google Chrome and Microsoft Edge.
- Tauri retains bundle ID `io.github.georgefejer91.affecttracker` and legacy
  app-data compatibility, but new Research data uses a separate namespace and
  is never populated by automatic legacy import.
- Qualified Windows playback of workspace and repository videos uses the
  bundled, repository-pinned libVLC 3.0.23 x64 runtime. Affect Research never
  downloads native media code at runtime or discovers a system VLC install.
- WebXR, native Quest, remote control, Ground Control, Party/Universe, Remote
  Flubber, direct Polar, Face/Photoatlas, Touch inference, and the other former
  Playground surfaces are absent from the active source, navigation, and
  release claims. Their source and documentation remain in Playground/history.

## Setting Up the Experiment

Setup uses seven ordered, single-open accordions on the left and a persistent
live feedback preview on the right.

### Workspace & Libraries

- Choose one parent workspace root.
- Create or validate `stimuli/`, `settings/`, `outputs/`, and `recovery/`
  beneath that root.
- Drop/import complete videos recursively and provide **Rescan**.
- Load any compatible `settings.json` through strict validation or explicit
  reported migration.
- Save the normalized Research document as
  `settings/<experiment-id>.settings.json`.
- Windows uses a Rust-owned workspace boundary. Chrome/Edge uses a directly
  authorized File System Access root plus the isolated `affect-research/v1`
  IndexedDB/storage namespace.

### Experiment

- Require experiment ID, title, and participant count.
- Generate `P001` onward, using at least three digits and enough zero-padding
  for the largest participant number.
- Continuous rating is always enabled. No continuous toggle, single-summary,
  or summary-only option is present.
- Sampling frequency defaults to 130 Hz and accepts only integers 1–240.
- Between complete videos select fixed duration, deterministic jitter from the
  entered durations, or participant-controlled **Continue when ready**.

### Stimuli & Counterbalancer

- Every complete video is explicitly a workspace file, checked-in repository
  asset, or **Experimental YouTube** URL.
- On Windows, local and repository sources default to `nativeLibvlc`. A missing,
  altered, wrong-architecture, or unavailable native runtime blocks qualified
  Start. The separate `unqualifiedWebview` mode is a deliberate development
  fallback and is labelled unqualified in status, events, recovery, and the
  final manifest.
- Each condition column is one video pool. One column containing all videos is
  the one-hat workflow. Multiple columns are stratified pools; there is no
  mixed-pool switch.
- Each pool declares videos per participant. One video belongs to one pool and
  cannot repeat for one participant.
- Order defaults to Williams and may be changed to cyclic. Factorial
  permutations are excluded.
- `balanced-v1` automatically chooses each slot by lowest total exposure, then
  lowest exposure at that position, then deterministic seeded-hash tie-break.
  When feasible, exposure differs by no more than one.
- Store seed, algorithm version, normalized pools/counts/order, resolved plan,
  canonical SHA-256 plan hash, and exact stimulus identities.
- Block Start when participant/slot capacity cannot cover all videos. Name
  uncovered items and show the exact participant-count or affected-pool-count
  adjustment.
- Provide a virtualized participant preview and `assignment-plan.csv` export.
- Derive **Available**, **Active**, **Partial**, and **Complete** from locks,
  journals, and manifests. They are not editable flags.

### Input

- Presets: Arrow keys, WASD, IJKL, numpad, pointer/trackpad Grid, mouse
  buttons/wheel, gamepad D-pad, gamepad left stick, and gamepad right stick.
- Default: Arrow keys with step `0.1`.
- Digital step input responds only to physical edge presses and ignores OS key
  repeat. Pointer and analog presets are continuous/absolute and show step as
  **N/A**.
- Custom binding selects a direction, captures one keyboard/mouse/wheel/gamepad
  action, rejects any conflict, and supports an inert live test.

### Visual

- The preview and Run overlay are in-application feedback at one normalized
  position; a native transparent desktop overlay is not required.
- Expose independent Grid and Flubber visibility, Flubber Size as percent of
  stage, Transparency, Hide Visual Feedback, and draggable normalized position.
- **Lock position** is the sole Disable Dragging control and is forced on in
  Run. Hiding visuals never stops sampling.
- Flubber controls: outline enabled/thickness and halo enabled.
- Grid controls: line thickness, outline enabled/thickness, and cursor size.
- Color & Gradient owns four directional VA anchor colors plus idle, outline,
  halo, and cursor colors. Every color has wheel, hex, and reset. Halo color has
  no second owner.

### Advanced

LSL fields are Enable LSL, state stream, stream type, marker stream, and source
ID. LSL is outbound and Tauri/Windows-only. Chrome/Edge preserves imported
values but blocks Start while Enable LSL is true.

Every mapping has Min, Max, driver (`x-axis`, `y-axis`, `angle`, or `radius`),
Reverse, and live preview:

| Mapping | Allowed | Defaults | Driver | Reverse |
| --- | --- | --- | --- | --- |
| Oscillation Frequency | 0–10 Hz | 0.5–2.5 | `y-axis` | Off |
| Edge Smoothness | 0–1 | 0–1 | `x-axis` | Off |
| Projection Amplitude | 0–1 | 0.2–0.4 | `y-axis` | Off |
| Pulse Synchrony | 0–1 | 0.2–1 | `x-axis` | Off |
| Wave-size Variation | 0–1 | 0–0.8 | `x-axis` | On |
| Saturation | 0–1 | 0–1 | `radius` | Off |

Normalize x/y, radius, and angle as specified by the charter; neutral angle is
zero. Reverse applies `t = 1-t` before linear Min/Max interpolation.

### Review & Start

- Show all preflight results, resolved schedule, output path/formats, settings
  and plan hashes, input test, stimulus verification, storage estimate, timing,
  and Windows LSL status.
- The chooser shows the four derived participant states. A rerun requires a
  warning and creates a new attempt.
- Require transient first/last names, age 1–120, enumerated gender, and
  handedness. Persist no raw name or self-description: only the uppercase code
  made from the last grapheme of the first name plus first grapheme of the last
  name, age, gender code `W/M/N/S/X`, and handedness `L/R/A`.
- CSV and TSV toggles are independent and at least one is required.
- Start only after every blocking check passes. It freezes settings, bindings,
  derived demographics, resolved assignment, normalized geometry, output
  targets, participant lock, and attempt identity.

## Running the Experiment

Run shows only the complete video, configured adjacent Grid/Flubber overlay,
compact session/timing/write/LSL status, **Pause**, and **Stop Early**. Feedback
must not cover the video.

Sampling occurs only while video playback is active. Between videos it stops,
coordinates reset to neutral, and the configured transition runs. Settings,
bindings, demographics, assignment, and geometry cannot change; position is
locked.

For Windows qualified runs, Rust-owned libVLC lifecycle state—not WebView media
events or animation frames—opens and closes sampling segments. Player pause,
buffering, end, error, teardown, or loss of the exact media grant fences the
scheduler and produces bounded semantic evidence.

Stop Early durably finalizes a partial attempt. Crash, power loss, forced
termination, or storage interruption leaves the journal authoritative.
Recovery resumes only at a safe video boundary. A partially played video starts
again at its beginning; mid-video resume and invented samples are prohibited.
Completion is durable before participant lock release and return to Setup.

## Settings and data products

Use the strict closed-world family `ResearchSettingsV1`,
`ResolvedAssignmentPlanV1`, `InputBindingV1`, `ResearchSampleV1`,
`ResearchEventV1`, and `ResearchRunManifestV2`. Unknown fields and invalid
versions, values, identifiers, paths, hashes, or algorithm tokens reject.

The former portable-settings v1 remains unchanged. Legacy import is explicit,
one-way, and reports every default/discard; no local storage or app-data is
silently migrated.

Write each attempt to:

```text
outputs/<experiment-id>/<participant-id>/<session-stem>/
```

For example:

```text
P001_EF_A27_GW_HR_20260903T143012482Z_R01
```

Create-new directories and attempt counters prevent overwrite. Always retain
the frozen settings snapshot, semantic `events.jsonl`, and
`ResearchRunManifestV2`, plus selected rating files. CSV and TSV have identical
canonical rows, columns, order, values, and count.

Local/repository videos require SHA-256, byte length, full duration, and decode
preflight. Repository videos are small demonstrations. YouTube records URL,
video ID, and observed metadata without a byte hash; it is noncanonical,
unverified, offline-failing, and excluded from reproducibility qualification.
Tauri exposes it only after CSP/referrer feasibility passes.

The Windows native runtime is packaged from the exact checked-in pin and
verified file manifest, including upstream license notices. Runtime integrity,
compilation, or staging alone does not qualify playback. The in-process
dynamic-library/libVLC/child-window actor requires its separately approved and
audited `unsafe` boundary plus installed-artifact media/lifecycle tests.

## Sampling and LSL

One sampling authority uses the configured 1–240 Hz value, default 130 Hz, for
rating rows and the Windows regular LSL state outlet. Rendering never owns the
clock. Missed slots emit a timing-gap event and are never backfilled.

Rows retain LSL-compatible and monotonic timestamps, state-anchor age, observed
jitter/gaps, current/target x/y, radius, angle, mapped values, and input state.

The Windows regular Float32 outlet preserves eight ordered channels:
`current_valence`, `current_arousal`, `target_valence`, `target_arousal`,
`radius`, `angle_degrees`, `animation_active`, and `input_active`. The irregular
marker outlet carries bounded semantic lifecycle/stimulus/input/timing/write/
recovery events without typed text, raw names, paths, settings bodies, or video.

## Accessibility and privacy

- Keyboard operation, visible focus, semantic labels, non-color state, high
  contrast, reduced motion, and polite announcements are required.
- Hiding feedback cannot hide timing, write/recovery, or LSL status.
- Store no raw names, self-described gender text, composed input, clipboard,
  unrelated app/window names, raw pointer trajectories, physiology, face/camera
  data, or remote identifiers.
- Research settings, plans, media identity, outputs, journals, and LSL remain
  local. No active-v1 account, upload, webhook, peer transport, or telemetry is
  permitted.
