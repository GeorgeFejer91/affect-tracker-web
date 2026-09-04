# Affect Tracker Research v1 charter

## Status and precedence

This file is the sole active product and architecture authority for Affect
Tracker Research v1. It supersedes the former feature-rich program, whose
complete source and documentation remain in Playground and Git history.

This is a target contract, not implementation or qualification evidence.
[`40-ROADMAP.md`](./40-ROADMAP.md) records what has actually landed, and
[`30-TESTING-AND-RELEASE.md`](./30-TESTING-AND-RELEASE.md) defines the evidence
required before a Research v1 claim.

## Product decision

The product has exactly two user-visible application modes:

1. **Setting Up the Experiment**; and
2. **Running the Experiment**.

Dialogs, disclosures, recovery prompts, and the seven Setup accordions are
parts of those modes, not additional modes. Active Research removes the former
WebXR, native Quest, Party, Ground Control, remote-control, direct Polar, Face,
and other Playground surfaces from the active application. Their history is
preserved without giving it active product or release authority.

The desktop product name is **Affect Research**. It retains bundle identifier
`io.github.georgefejer91.affecttracker` and existing application-data
compatibility, but all new Research data uses an explicit Research namespace.
There is no automatic import of legacy application data.

## Supported delivery surfaces

Qualify these surfaces first and only:

| Surface | Active role | Capability boundary |
| --- | --- | --- |
| Tauri on Windows | Setup and Run, workspace ownership, native input, bundled native media, durable records, sampling clock, and outbound LSL | Rust authority behind narrow typed commands; packaged Windows/WebView2/libVLC evidence required |
| Static web in desktop Google Chrome | Setup and Run using a user-authorized workspace root and browser-local journal | Current stable desktop Chrome against the exact static/deployed build |
| Static web in desktop Microsoft Edge | Same browser contract, qualified separately | Current stable desktop Edge against the exact static/deployed build |

The browser has no LSL or native/global-input authority. macOS, Linux, Firefox,
Safari, mobile, WebXR, and native Quest are not active-v1 support targets. The
static application may be served by GitHub Pages under the renamed project path
but must not require a backend, account, CDN, remote runtime asset, or silent
third-party API.

Qualified Windows playback for workspace and repository video uses the pinned,
bundled libVLC 3.0.23 x64 runtime. The application never downloads native media
at runtime, searches `%PATH%` or the registry, or treats a system VLC install as
an acceptable dependency. Missing, modified, extra, symlinked,
wrong-architecture, or unavailable native media fails closed. The WebView video
element is available only as an explicitly selected `unqualifiedWebview`
development mode whose attempt evidence remains permanently unqualified.

## Setting Up the Experiment

Setup is a compact research instrument. Its layout has seven ordered,
single-open top-level accordions on the left and one persistent live feedback
preview on the right. Opening one accordion closes the other six without
discarding valid edits.

### 1. Workspace & Libraries

- The researcher chooses one parent workspace root.
- The application creates or validates exactly these children beneath that
  root: `stimuli/`, `settings/`, `outputs/`, and `recovery/`.
- Video drop/import accepts complete videos, copies or stages them through the
  owning adapter, and supports recursive discovery plus explicit **Rescan**.
- **Load settings.json** accepts any compatible settings file after complete
  validation or explicit migration.
- **Save settings.json** writes the canonical normalized file to
  `settings/<experiment-id>.settings.json`.
- Tauri owns the workspace through narrow root/run commands and never exposes
  arbitrary native paths to the WebView.
- Chrome and Edge use a File System Access directory handle obtained in a
  secure context through a direct user gesture, renew access when browser
  permission requires it, and keep journal/lock metadata in the isolated
  `affect-research/v1` IndexedDB/storage namespace.

For Windows qualified playback, Rust revalidates a selected local/repository
source against its opaque identity before issuing a bounded native media grant.
One Rust-owned actor owns the libVLC instance, media, player, callbacks, and
teardown on its required thread. It renders into an application-owned child
window attached to the Run stage. The WebView may send only a validated viewport
rectangle and receives an opaque media-session ID plus bounded state; it never
receives or supplies a native filesystem path.

Native player state is authoritative for sampling segments. Decoded Playing
opens a segment; pause, buffering, end, error, teardown, media-grant failure, or
loss of the actor fences sampling before status is projected to the WebView.
Rendering cadence and WebView media events never authorize native samples.

The native runtime is built from the exact repository pin and deterministic
file-hash manifest, with upstream license notices retained. The unavoidable
dynamic-library/libVLC/Win32 FFI is confined to a small adapter with documented
ownership, callback, panic, and teardown invariants. Adding that `unsafe`
adapter requires explicit user approval; the existing safe pin/stager/
capability groundwork is not equivalent to the actor or qualification.

### 2. Experiment

- Required fields are experiment ID, title, and participant count.
- Participant IDs are `P001` through the requested count, using at least three
  digits and enough zero-padding for the largest ID.
- Continuous rating is always enabled and has no off toggle.
- Sampling frequency is an integer from 1 through 240 Hz, default 130 Hz.
- There is no single-summary or summary-only rating option.
- Between complete videos, the researcher selects exactly one transition:
  fixed duration; deterministic jitter selected from the entered durations; or
  participant-controlled **Continue when ready**.

### 3. Stimuli & Counterbalancer

Only complete videos are active-v1 stimuli. Each item has exactly one explicit
source:

- a workspace video file;
- a checked-in repository asset; or
- an **Experimental YouTube** URL.

Condition columns are video pools. One column containing every video is the
ordinary one-hat workflow; there is no separate mixed-pool switch. Multiple
columns form a stratified design, and every pool declares its
videos-per-participant count. A video belongs to one pool only, and one
participant never receives the same video twice.

Condition order defaults to Williams order and may be changed to cyclic order.
Active v1 does not generate factorial permutations.

`balanced-v1` is the only allocation algorithm. It allocates every participant
slot automatically by comparing eligible videos in this exact order:

1. lowest total exposure across the plan;
2. lowest exposure at the current within-participant position; and
3. a deterministic seeded-hash tie-break.

When the declared design makes it feasible, exposure counts differ by no more
than one. The plan stores the seed, algorithm version, canonical pools, per-pool
counts, order method, and every selected item/position. The same normalized
inputs must produce the same plan and hash in Rust and the browser.

Start is blocked unless participant/slot capacity can cover every selected
video while respecting pool counts and no-participant-duplicate rules. The
preflight names each uncovered item and reports the exact minimum adjustment to
participant count or the affected pool count.

Setup provides a virtualized participant preview, the canonical plan hash, and
an `assignment-plan.csv` export. Participant state is one of **Available**,
**Active**, **Partial**, or **Complete**, reconstructed from workspace locks,
recovery journals, and manifests. These are observed states, never editable
flags.

### 4. Input

The closed preset list contains:

- Arrow keys;
- WASD;
- IJKL;
- numpad;
- pointer/trackpad Grid;
- mouse buttons and wheel;
- gamepad D-pad;
- gamepad left stick; and
- gamepad right stick.

Arrow keys are the default, with step size `0.1`. Step applies only to digital
edge presses; operating-system key repeat is ignored. Pointer and analog
presets are continuous/absolute and display step size as **N/A**.

Custom binding asks the researcher to select a direction and then perform the
desired keyboard, mouse, wheel, or gamepad action. It rejects conflicts across
the complete binding set and provides an inert live test before Start.
`InputBindingV1` is the one serialized binding authority.

### 5. Visual

The persistent right-hand preview projects current settings and input without
owning research state or sampling time. Its overlay is an in-application,
normalized preview/run feedback position; active v1 does not require a native
transparent desktop overlay.

Visual controls are:

- independent **Grid** and **Flubber** visibility toggles;
- Flubber Size as a percentage of the stage;
- Transparency;
- **Hide Visual Feedback**; and
- normalized draggable overlay position.

**Lock position** is the sole Disable Dragging control. It applies to the same
normalized overlay position and is always forced locked after Run starts. Grid
and Flubber may be shown independently or together. Hiding either or all visual
feedback never stops sampling.

The nested **Flubber** group owns outline enabled, outline thickness, and halo
enabled. The nested **Grid** group owns grid-line thickness, outline enabled,
outline thickness, and cursor size.

The **Color & Gradient** group owns the four directional valence/arousal anchor
colors, idle color, outline color, halo color, and cursor color. Every color has
a color wheel, hexadecimal entry, and reset. This group is the sole halo-color
owner; the Flubber group does not duplicate that field.

### 6. Advanced

#### Outbound LSL

The fields are Enable LSL, state stream name, stream type, marker stream name,
and source ID. LSL is Tauri/Windows-only and outbound. Chrome and Edge preserve
imported values but cannot start a run while Enable LSL is true.

#### Flubber–Affect Mapping

Each mapping is independent and has Min, Max, **Driven By**, Reverse, and a live
preview. The only drivers are `x-axis`, `y-axis`, `angle`, and `radius`.

| Mapping | Allowed output | Default Min | Default Max | Default driver | Default Reverse |
| --- | --- | ---: | ---: | --- | --- |
| Oscillation Frequency | 0–10 Hz | 0.5 | 2.5 | `y-axis` | Off |
| Edge Smoothness | 0–1 | 0 | 1 | `x-axis` | Off |
| Projection Amplitude | 0–1 | 0.2 | 0.4 | `y-axis` | Off |
| Pulse Synchrony | 0–1 | 0.2 | 1 | `x-axis` | Off |
| Wave-size Variation | 0–1 | 0 | 0.8 | `x-axis` | On |
| Saturation | 0–1 | 0 | 1 | `radius` | Off |

Normalize `x-axis` and `y-axis` from `[-1,1]`, radius from `[0,1]`, and angle
from `[0,360)` into `t` in `[0,1]`. Neutral angle is deterministically zero.
When Reverse is enabled, replace `t` with `1-t`; then compute
`lerp(Min, Max, t)`. Min and Max remain within the mapping's allowed output.
All six outputs derive from one authoritative coordinate snapshot and never
become a second affect or timing authority.

### 7. Review & Start

Review shows the complete blocking/non-blocking preflight, resolved participant
schedule, output formats/path, settings and assignment hashes, input test,
stimulus verification, storage estimate, sampling/timing status, and Windows
LSL status.

The participant chooser shows exactly the four reconstructed states
**Available**, **Active**, **Partial**, and **Complete**. Selecting a completed or
partial participant for another run requires a visible rerun warning and
creates a new attempt; it never overwrites or edits prior evidence.

Immediately before Start, collect these required transient values:

- first name and last name;
- age, integer 1–120;
- gender: Woman (`W`), Man (`M`), Non-binary (`N`), Self-described (`S`), or
  Prefer not to say (`X`); and
- handedness: Left (`L`), Right (`R`), or Ambidextrous (`A`).

Raw names and any self-description are never persisted. Persist only an
uppercase two-grapheme participant code formed from the last extended grapheme
of the first name followed by the first extended grapheme of the last name,
plus age and the enumerated gender/handedness codes.

CSV and TSV are independent output toggles and at least one must be selected.
Start is enabled only after every blocking check passes. Start atomically locks
the participant/attempt, freezes settings, bindings, demographics, assignment,
and normalized geometry, creates output/recovery ownership, and enters Run.

## Running the Experiment

Run displays only:

- the current complete stimulus;
- the configured normalized Grid/Flubber feedback overlay;
- compact session, stimulus timing, write/recovery, and Windows LSL status;
- **Pause**; and
- **Stop Early**.

Setup controls are unavailable. Settings, bindings, derived demographics,
assignment, and geometry remain frozen for the attempt. The overlay is locked.

Sampling runs only while a video is actively playing. On Windows qualified
runs, only Rust-owned libVLC lifecycle state may establish that fact. Between
videos sampling stops, the affect state resets to neutral, and the configured
fixed, deterministic-jitter, or participant-controlled transition runs. Visual
feedback never covers the video; it remains adjacent within the run stage.

**Stop Early** is controlled termination and finalizes an explicitly partial
attempt. A crash, power loss, forced termination, or storage interruption leaves
the journal as authoritative recovery evidence. Recovery resumes only at a safe
stimulus boundary. A video that was only partially played restarts from its
beginning; active v1 never resumes mid-video or fabricates the missing interval.

Successful completion durably writes the completion receipt and manifest
before releasing the participant lock and returning to Setup.

## Contract family and versioning

The active closed-world contract family is:

- `ResearchSettingsV1`;
- `ResolvedAssignmentPlanV1`;
- `InputBindingV1`;
- `ResearchSampleV1`;
- `ResearchEventV1`; and
- `ResearchRunManifestV2`.

Every contract rejects unknown fields, duplicate identifiers or keys,
unsupported versions/algorithms, invalid enums, non-finite or out-of-range
numbers, unsafe paths, excessive sizes/counts/depth, and hash mismatches.

Canonical JSON and SHA-256 bind the exact normalized settings and resolved
assignment plan. Every output binds both hashes and the exact stimulus identity.
The existing portable-settings schema remains unchanged and is not the Research
schema. An explicit importer may convert a legacy file only when it reports
every defaulted and discarded field and emits the new schema. There is no
silent local-storage, app-data, or settings migration.

## Authority and timing

Tauri Rust owns native input, the configured sampling scheduler, monotonic and
wall timestamps, workspace/persistence, allocation locks, and outbound LSL.
The WebView receives narrow projections and issues typed root/run commands; it
never receives arbitrary filesystem authority.

Chrome and Edge run the scheduler in a dedicated worker, journal accepted
records in `affect-research/v1`, and use the user-authorized File System Access
root for workspace artifacts. Permission renewal is explicit and cannot silently
switch roots.

`requestAnimationFrame` owns presentation only and never sampling. The
configured 1–240 Hz frequency, default 130 Hz, controls continuous rating rows
and the Tauri regular LSL state stream only. A missed deadline produces one
typed timing-gap event. No adapter emits catch-up rows or backfills a later
state under earlier timestamps.

Each row records both LSL-compatible and monotonic timing, anchor age, and
observable jitter/gap context so cadence can be audited rather than inferred.
Each uninterrupted sampling segment schedules its first row one full period
after the authoritative stimulus-start or resume boundary. Scheduler lateness
is the non-negative delay from that row's own deadline; scheduler jitter is the
signed change in lateness from the previous accepted row in the same segment,
and is exactly zero for the segment's first row. `animationActive` is true only
while Flubber is enabled and its acquisition segment is actively playing.

## Outbound LSL

Windows Tauri publishes one regular Float32 state outlet at the configured
sampling frequency and one irregular semantic marker outlet. The regular
channel order is fixed:

1. `current_valence`;
2. `current_arousal`;
3. `target_valence`;
4. `target_arousal`;
5. `radius`;
6. `angle_degrees`;
7. `animation_active`; and
8. `input_active`.

Markers cover bounded lifecycle, stimulus, input-edge, pause/resume, timing-gap,
write/recovery, and completion/partial events. They never contain composed
text, raw names, arbitrary error text, settings JSON, native paths, or video
bytes. LSL is not cloud upload, inbound control, or direct sensor acquisition.

## Workspace, output, and recovery records

Every attempt uses a create-new directory:

```text
outputs/<experiment-id>/<participant-id>/<session-stem>/
```

The session stem is deterministic in shape and includes participant ID,
two-grapheme code, age, gender, handedness, UTC timestamp, and attempt counter,
for example:

```text
P001_EF_A27_GW_HR_20260903T143012482Z_R01
```

Attempt counters and create-new semantics prevent overwrite. Every attempt
always writes the frozen settings snapshot, semantic `events.jsonl`, and
`ResearchRunManifestV2`, plus the selected rating outputs. CSV and TSV serialize
the same canonical rows with identical columns, order, values, and row count;
only delimiter escaping differs.

Tauri appends and flushes to app-owned recovery/output files through atomic
file operations. Chrome/Edge first commits the authoritative journal, then
materializes workspace outputs when permission is available. Full disk, quota,
revoked permission, failed download/write, close, crash, and finalization errors
must retain all accepted evidence for retry. Corrupt journals are isolated and
reported, never silently repaired or discarded.

Local and repository video sources must pass exact identity, SHA-256, byte
length, full duration, and decode preflight before Start. Repository media is
limited to small demonstration assets.

Experimental YouTube is unverified and noncanonical. Its record preserves the
URL/video ID and observed metadata but has no byte hash and is excluded from
qualified reproducibility claims. It must fail honestly when offline. Tauri may
offer it only after exact CSP and referrer feasibility is implemented and
qualified; otherwise the Tauri preflight rejects it.

## Historical lineage boundary

WebXR and native Quest, the mirrored-study program, remote/VDO/BRSP and
Party/Ground Control, direct Polar, Face/Photoatlas, Touch inference, Screen
Calibration, retro/phone/Picture-in-Picture presentation, and cross-platform
desktop packaging are absent from the active Research source and product.
Their source, documentation, notices, evidence, and full Git graph are
preserved in
[`GeorgeFejer91/affect-tracker-playground`](https://github.com/GeorgeFejer91/affect-tracker-playground)
and this repository's history.

Reactivation requires an explicit charter amendment, named authority/data
boundary, schema and platform decision, source/licensing review, new tests, and
qualification on the changed build. Historical evidence cannot qualify a
changed Research runtime.

## Privacy, accessibility, and observability

Active Research stores no raw names, self-described gender text, composed
keystrokes, clipboard contents, unrelated application/window names, raw pointer
trajectory, physiology, face/camera data, or remote identifiers. Global native
input, when selected on Windows, is disclosed and records only the bounded
physical controls required by `InputBindingV1`.

Setup and Run require semantic controls, keyboard operation, visible focus,
non-color-only state, high contrast, reduced-motion support, and polite status
announcements. Hiding visual feedback must not hide safety, write/recovery,
timing, or LSL status and must not create an invisible-control trap.

Visible diagnostics include settings/plan hashes, participant state and attempt,
input test, stimulus verification, storage estimate/status, configured and
observed sample timing, journal/write state, and outbound LSL state. They exclude
raw names, arbitrary invalid payloads, native paths, secrets, and video bytes.

## Active-v1 release claim

The first internal target is `0.4.0-alpha.1`. It is not research-ready or stable
until the exact candidate passes all gates in `30-TESTING-AND-RELEASE.md`,
including:

- strict schema round-trip/rejection/hash/import fixtures;
- property and fixture coverage for one-hat and multi-pool `balanced-v1`,
  Williams/cyclic order, no duplicates, capacity, reruns, and deterministic
  balance;
- input and mapping goldens;
- CSV/TSV equality, name erasure, no-overwrite, partial/final, quota, crash,
  corrupt-journal, and safe-boundary restart tests;
- separate 30-minute 130 Hz Windows Tauri, visible Chrome, and visible Edge
  runs with observed 129–131 Hz, p95 lateness no greater than two periods,
  input-state p95 no greater than two periods in Tauri and three periods in the
  browser, and zero silent gaps, backfill, or corrupt records;
- independent LSL receiver qualification; and
- adverse visibility, permission, IndexedDB, tab, forced-termination, full-disk,
  LSL, video, and offline-YouTube tests plus accessibility review.

Windows acceptance additionally requires an integrity-verified packaged
libVLC runtime, the separately approved and audited native player actor, exact
player-to-scheduler lifecycle fencing, and installed-artifact playback, error,
resize/DPI, audio, shutdown, and recovery tests. A staged runtime or successful
build alone is not playback evidence.

Landing this documentation changes no runtime and satisfies none of those
implementation or qualification gates.
