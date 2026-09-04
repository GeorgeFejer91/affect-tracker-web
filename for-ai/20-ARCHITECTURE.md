# Research architecture and authority contract

## Status

This file refines the sole active authority in
[`15-RESEARCH-V1-CHARTER.md`](./15-RESEARCH-V1-CHARTER.md). It describes the
target architecture; it is not evidence that the current feature-rich runtime
already conforms. Delivery status belongs in `40-ROADMAP.md`.

## Authority map

| Concern | One active authority | Adapters/consumers |
| --- | --- | --- |
| Settings | Strict normalized `ResearchSettingsV1` | Setup form, JSON load/save, explicit legacy importer |
| Input bindings | `InputBindingV1` inside normalized settings | Windows input adapter; Chrome/Edge event and Gamepad adapters |
| Stimulus library | Workspace catalogue with exact source identity and verification state | Tauri file commands; browser File System Access; checked-in demo assets; experimental YouTube metadata adapter |
| Assignment | Pure deterministic `balanced-v1` resolver producing `ResolvedAssignmentPlanV1` | Virtualized preview, `assignment-plan.csv`, run preparation |
| Participant/attempt state | Locks, journals, and `ResearchRunManifestV2` | Four-state chooser projection; never editable flags |
| Run lifecycle | One run authority per attempt | Setup Start, Run Pause/Stop Early, recovery |
| Affect state | One bounded current/target x/y engine | Inputs, Grid/Flubber renderer, recorder, Windows LSL |
| Sampling | Run-owned monotonic scheduler | Canonical rows and Windows regular LSL outlet |
| Recording | Canonical typed sample/event model | CSV, TSV, `events.jsonl`, manifest, recovery journal |
| Presentation | In-app normalized Grid/Flubber renderer | Persistent Setup preview and adjacent Run feedback; never a clock |
| LSL | Windows Rust outbound adapter | Regular eight-channel state plus irregular semantic markers |

No UI handler, renderer, WebView, video player, or LSL adapter creates a second
settings, allocation, affect, lifecycle, timestamp, or record authority.

## Contract family

The active closed-world family is `ResearchSettingsV1`,
`ResolvedAssignmentPlanV1`, `InputBindingV1`, `ResearchSampleV1`,
`ResearchEventV1`, and `ResearchRunManifestV2`. Canonical JSON plus SHA-256 bind
normalized settings and resolved plan. Outputs bind both hashes and exact
stimulus identities.

Readers reject unknown fields and keys, duplicate IDs, unsupported versions or
algorithm tokens, invalid enum/color/path values, non-finite or out-of-range
numbers, excessive counts/depth/bytes, and hash mismatches. A changed meaning
requires a new version or an explicit migration; it never becomes permissive
interpretation.

The old portable-settings v1 remains byte/meaning compatible with its existing
readers. A separately selected importer may produce Research settings only
after showing every defaulted and discarded field. It preserves the source
file and writes a new schema identity. No browser storage or Tauri app-data is
automatically migrated.

## Setup composition

One Setup shell owns only the exact seven-accordion order, single-open state,
status summary, and Start orchestration. Each accordion keeps a narrow owner:

1. Workspace & Libraries — root authorization, directory creation, import,
   recursive rescan, catalogue, settings load/save;
2. Experiment — identity, participant ID range, sample rate, transition policy;
3. Stimuli & Counterbalancer — pools, counts, source identity, verification,
   deterministic plan and capacity preflight;
4. Input — presets, custom capture, conflict validation, live test;
5. Visual — normalized overlay, Grid/Flubber visibility and geometry, colors;
6. Advanced — outbound LSL fields and six independent affect mappings; and
7. Review & Start — aggregate preflight, derived participant/demographic data,
   output selections, lock/reservation, and atomic mode transition.

The persistent preview receives immutable projected settings and affect state.
It cannot mutate a run, sample from animation frames, or act as a native
transparent overlay. One normalized overlay position is shared between Setup
preview and Run feedback. Lock position is the sole drag-disable owner and is
forced true once Run starts.

## Workspace and media boundary

One selected root contains `stimuli/`, `settings/`, `outputs/`, and `recovery/`.
All generated paths are descendants of that root and are constructed from
validated bounded identifiers; the WebView never supplies or receives an
arbitrary native path.

Tauri Rust owns root selection, safe child creation, staged copy/import,
recursive rescan, streaming hashes, media probes, create-new output ownership,
locks, and atomic file finalization behind narrow typed root/run commands.

Chrome and Edge obtain one File System Access directory handle in a secure
context from an immediate user activation. They retain the handle only through
browser-managed storage, surface permission loss, renew access through another
explicit gesture, and never substitute a different root. IndexedDB/storage
uses the isolated namespace `affect-research/v1` for locks, allocation records,
journals, and recovery metadata.

Workspace and repository videos are complete-file sources. Before Start, hash
and measure the exact bytes, probe full duration, and prove decode readiness.
Repository media is limited to small demonstrations and uses the same identity
contract.

Experimental YouTube is a separate unverified adapter. It retains normalized
URL/video ID and observed metadata, has no byte hash, fails honestly offline,
and is excluded from qualified reproducibility. The active overlay is adjacent
to rather than on top of the player. Tauri exposes YouTube only after exact CSP
and referrer behavior passes; otherwise native preflight rejects that source.

## Assignment architecture

The planner accepts canonically ordered pools, per-pool counts, participant IDs,
Williams or cyclic order, and a seed. One all-video pool is naturally the
one-hat design; multiple pools are stratified. No video may occur in two pools
or twice for one participant.

For each participant slot, `balanced-v1` chooses the eligible video with lowest
total exposure, then lowest exposure at that position, then lowest seeded hash
under a fully specified byte encoding. The implementation maintains exposure
difference no greater than one whenever the constraints permit it.

Capacity preflight is part of planning, not a best-effort runtime warning. It
must enumerate uncovered videos and calculate the minimum participant-count or
pool-count adjustment. A valid result is immutable `ResolvedAssignmentPlanV1`
with algorithm version, seed, normalized input, exact schedule, exposure and
position counts, condition order, canonical hash, and CSV projection.

Run preparation atomically reserves one participant/attempt against the current
plan and workspace. Locks, journals, and manifests reconstruct Available,
Active, Partial, and Complete. Reruns allocate a new attempt counter and retain
all earlier evidence.

## Participant derivation boundary

Review receives transient first name, last name, age, gender choice, and
handedness choice. It validates age 1–120 and the closed gender/handedness enums.
The derivation owner uses Unicode extended grapheme clusters, takes the last
first-name grapheme plus first last-name grapheme, and uppercases the resulting
two-grapheme code consistently.

Only that code, age, gender code `W/M/N/S/X`, and handedness `L/R/A` enter run
identity/records. Raw names and self-description text are dropped before the
immutable Start input is constructed and must never reach logs, storage,
markers, crash reports, or filenames.

## Input and renderer boundaries

`InputBindingV1` normalizes the closed preset/custom action catalogue. Digital
actions are edge-triggered and ignore OS repeat. Pointer/trackpad Grid and
gamepad sticks supply continuous/absolute values and have no step-size meaning.
Custom capture observes exactly the next allowed physical action, then validates
global conflicts before replacing the binding.

The affect engine clamps current and target x/y to `[-1,1]`. Radius and angle
derive from the same snapshot. Mapping drivers normalize x/y, radius, or angle;
Reverse transforms `t` before linear interpolation. The six labels, bounds,
defaults, drivers, and reverse defaults are exactly those in the charter.

`site/src/math.js` may remain the procedural geometry baseline, but active
mapping parameters come only from validated Research settings. Grid/Flubber
visibility, color, geometry, and feedback hiding are presentation state.
Rendering consumes a snapshot and never supplies research timestamps or
samples.

## Run and timing boundary

Start is one fail-closed transition:

1. validate settings, workspace, stimuli, capacity, plan/hash, input, output
   choice, storage estimate, timing support, and platform-specific LSL;
2. derive privacy-safe participant fields and choose a create-new attempt;
3. atomically write the lock/reservation and initial journal;
4. freeze settings, plan, bindings, demographics, assignment, and geometry; and
5. enter Run only after durable success.

Tauri Rust owns its monotonic scheduler and timestamps. Chrome/Edge use a
dedicated worker rather than the window animation loop. The configured integer
1–240 Hz rate, default 130 Hz, drives continuous rating rows and the Windows
regular LSL state stream. A missed slot creates one `ResearchEventV1` timing-gap
record. There is no catch-up row, retrospective timestamp, or later-state
backfill.

Sampling runs only during active decoded video playback. Pause, buffering,
between-video transition, recovery, and terminal states create explicit gaps.
Between videos the state returns to neutral and the configured transition
owner runs.

Every sample records wall and monotonic timestamps, LSL-compatible timestamp,
state-anchor age, nominal rate, observable jitter/gap context, exact stimulus
identity/position, current and target x/y, radius, angle, six mapped values,
and input/feedback state.

## Recording, output, and recovery

The recorder owns one typed row sequence. CSV and TSV serialize identical
columns, order, values, and row counts; only delimiter escaping differs. The
two outputs are independently selected and at least one is required.

Output directories have this create-new shape:

```text
outputs/<experiment-id>/<participant-id>/<session-stem>/
```

The stem contains participant ID, two-grapheme code, age, gender, handedness,
UTC timestamp, and attempt counter, for example
`P001_EF_A27_GW_HR_20260903T143012482Z_R01`. No operation overwrites an existing
attempt directory.

Every attempt contains the frozen settings snapshot, semantic `events.jsonl`,
`ResearchRunManifestV2`, and selected rating files. The manifest binds settings
and plan hashes, participant/attempt identity, exact stimuli, timing summary,
output digests, recovery lineage, completion/partial state, and build/platform
identity.

Tauri appends accepted evidence and flushes at bounded time/lifecycle boundaries
before atomic finalization. The browser commits accepted event/sample batches to
its IndexedDB journal before materializing workspace files. Permission loss,
quota/full disk, write failure, forced termination, or finalization failure
retains the journal/partial record for explicit retry.

Recovery validates the journal and resumes only at a safe stimulus boundary. A
partially played video restarts at its beginning. Corrupt journals are isolated
with actionable status; they are never silently repaired, skipped, or called
complete. Stop Early uses the same durable terminal path with partial status.
Completion receipt/manifest durability precedes lock release and return to
Setup.

## Outbound LSL boundary

LSL is an outbound Windows adapter over the exact run sample/event streams. It
is not inbound control, sensor acquisition, browser capability, or cloud upload.
Enable/name/type/source settings are validated before Start.

The regular Float32 stream runs at the configured research rate with the fixed
ordered channels `current_valence`, `current_arousal`, `target_valence`,
`target_arousal`, `radius`, `angle_degrees`, `animation_active`, and
`input_active`. The irregular marker stream projects only bounded semantic
lifecycle, stimulus, input-edge, pause/resume, timing-gap, write/recovery, and
terminal events. It excludes raw names, composed characters, arbitrary error
text, settings bodies, native paths, and video data.

## Frozen code boundary

The active build must make frozen WebXR/Quest, remote/VDO/BRSP, Face/Photoatlas,
direct Polar, Touch inference, Ground Control/Party, Screen Calibration,
Windows 95, phone/Picture-in-Picture, matrix traversal, and cross-platform
packaging paths inert and absent from active navigation. Loading Research must
not construct their clients, request their permissions, or fetch their assets.

Historical code and provenance may remain during reduction. If reachable, its
existing privacy, security, attribution, and licensing constraints still bind.
No historical test, build, or physical receipt qualifies the changed Research
runtime.

## Platform expectations

- Package and qualify Tauri on Windows first. Retain the bundle ID while using
  the new product/data namespace.
- Qualify desktop Chrome and Edge independently, including File System Access,
  permission renewal, worker timing, IndexedDB recovery, video playback, and
  offline behavior.
- Do not claim macOS, Linux, Firefox, Safari, mobile, WebXR, Quest, or direct
  physiology support.
- Signing, public installer/release publication, and production credentials
  remain separately authorized actions.
