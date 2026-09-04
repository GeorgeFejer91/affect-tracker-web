# Testing and release gates

## Status

These gates apply only to Affect Research v1. The feature-rich application's
tests and physical receipts remain historical evidence in Playground and do
not qualify the changed Research runtime.

The first internal target is `0.4.0-alpha.1`. Documentation, schemas, mocks,
compilation, a staged native runtime, or one successful adapter never establish
a stable or research-ready claim. Acceptance evidence must bind the exact Git
commit, settings/plan contract versions, built artifact hashes, OS/browser
versions, hardware, and test receipt.

## Automated candidate gates

Run the repository's exact commands from a clean candidate checkout:

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm build:pages
pnpm desktop:build
pnpm audit --audit-level=moderate
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --manifest-path src-tauri/Cargo.toml --locked --all-features
cargo test --manifest-path src-tauri/Cargo.toml --locked --all-features
cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --all-features -- -D warnings
```

Build the unsigned NSIS candidate only after staging and verifying the required native-media runtime.
Inspect the resulting installer and installed application rather than treating
the bundler exit code as runtime evidence.

### Contracts and settings

- Round-trip `ResearchSettingsV1`, `ResolvedAssignmentPlanV1`,
  `InputBindingV1`, `ResearchSampleV1`, `ResearchEventV1`, and
  `ResearchRunManifestV2` through Rust and browser readers.
- Reject unknown fields, duplicate keys/IDs, wrong schemas/versions/algorithms,
  invalid enums/colors/paths, non-finite/out-of-range numbers, excessive
  counts/depth/bytes, and settings/plan/stimulus hash drift.
- Prove canonical JSON and SHA-256 equality across Rust and browser fixtures.
- Exercise explicit legacy import, reporting every default and discard. Prove
  that existing app data and browser storage never migrate automatically.
- Verify all seven Setup accordions, their exact order and single-open state,
  persistent preview, settings load/save, 1–240 Hz bounds with 130 Hz default,
  always-on continuous rating, and absence of summary-only acquisition.

### Counterbalancing and participant identity

- Property-test one-hat and multi-pool plans across participant/video/count
  bounds. Prove unique pool ownership, no within-participant duplicate,
  deterministic Williams/cyclic order, and no factorial-permutation path.
- Prove `balanced-v1` selects lowest total exposure, then lowest position
  exposure, then seeded hash. Identical normalized inputs must reproduce the
  same plan and hash, with exposure differing by no more than one whenever the
  constraints make that feasible.
- For every capacity failure, name all uncovered stimuli and show the exact
  participant-count or affected-pool-count adjustment.
- Test virtualized preview, `assignment-plan.csv`, concurrent starts,
  lock/journal/manifest reconstruction, reruns, and create-new attempt numbers.
- Cover Unicode extended-grapheme participant codes and uppercase expansion.
  Prove raw names and self-description never reach storage, output, filenames,
  markers, logs, crash state, or IPC after derivation.

### Input, visual feedback, and mappings

- Golden-test Arrow, WASD, IJKL, numpad, pointer/trackpad, mouse button/wheel,
  gamepad D-pad, left stick, and right stick presets plus custom capture.
- Prove conflict rejection, input-test receipt invalidation after any binding or
  device change, OS key-repeat suppression, Arrow/0.1 defaults, and Step Size
  **N/A** for continuous/absolute inputs.
- On Windows, require the Rust input authority to own capture, test, run
  preparation, device epochs, and the allowed input region. WebView controls
  such as Pause and Stop Early must never be interpreted as rating input.
- Verify Grid and Flubber independently/together, Size %, Transparency, hidden
  feedback without stopped acquisition, normalized drag bounds, sole Lock
  position ownership, forced Run lock, outline/halo/cursor geometry, and every
  color wheel/hex/reset path.
- Golden-test all six mapping labels, bounds, defaults, drivers, Reverse,
  neutral angle zero, axes/corners, min=max, and interpolation.

### Browser workspace, recording, and recovery

- Exercise secure-context/user-activation directory selection, exact handle
  retention, permission renewal/revocation, recursive import/rescan bounds, and
  isolated `affect-research/v1` IndexedDB/local-storage keys.
- Prove workspace readiness with actual create/read/delete probes. Validate
  settings, journals, events, ratings, and manifests strictly; reject path
  traversal, malformed JSON, stale hashes, missing/extra output tails, and
  conflicting attempt artifacts.
- Prove worker session/command/provenance epochs prevent stale rows from being
  relabelled across stimulus, pause, resume, recovery, or later attempts.
- Test accepted-batch journaling before acknowledgement, explicit timing gaps,
  pending finalization, byte-identical retry, evidence quarantine, and
  finalization after reload without restarting media or sampling.
- Verify CSV/TSV toggles are independent with at least one selected. Both files
  must serialize the same canonical rows, columns, ordering, values, and count.

### Native workspace boundary

- Assert `librariesReady` reflects all four exact canonical workspace
  libraries. Remove a library, replace it with a file or a new same-path
  directory, and replace it with a symlink/junction to an external directory;
  status and every privileged operation must fail closed without recreating the
  library or exposing a native path.
- Exercise durable readiness probes in both `recovery/` and a temporary nested
  `outputs/<experiment>/<participant>/<session>/` hierarchy. Verify exact
  cleanup, path-free receipts/errors, and failure when either hierarchy cannot
  be used.
- For actual run creation, place a file, an outside-target junction, and a
  same-path directory replacement at each nested experiment/participant
  boundary. Assert that the runtime never follows it, revalidates around the
  participant lock, preserves create-new session semantics, and emits no output
  beyond the selected workspace.
- Treat Windows reparse-point races as an explicit residual boundary until a
  separately reviewed safe handle/file-ID design exists; passing junction and
  replacement tests is not evidence of a race-free sandbox.

## Native Windows media gate

Qualified workspace/repository playback uses the bundled libVLC 3.0.23 x64
runtime and no other VLC installation.

### Supply-chain and package evidence

- Verify the official archive SHA-256
  `992d19dbd0b8a7cde9167d2f7780b1ef6f92acc8a71acfa736101a21f35181e1`
  and source SHA-256
  `e891cae6aa3ccda69bf94173d5105cbc55c7a7d9b1d21b9b21666e69eff3e7e0`
  against `src-tauri/native-media/libvlc-runtime-v1.json`.
- Stage only the required DLLs, plugin tree, and upstream notices. Verify the
  complete generated file-hash manifest and reject links, Windows directory
  junctions/reparse points, traversal, extra, missing, modified, or
  wrong-architecture files. A real-junction regression must prove the verifier
  rejects before traversal and never changes the external target.
- Package with `AFFECT_RESEARCH_REQUIRE_LIBVLC_RUNTIME=1`; prove the build fails
  closed when the tree is absent or altered. The running app must not inspect a
  system VLC, `%PATH%`, registry location, or runtime download URL.
- Retain applicable source-offer/license obligations and use libVLC only as a
  descriptive dependency name; Affect Research must not adopt VLC branding.
- Every distributed Windows alpha artifact must include the exact pinned
  libVLC source archive, the machine-readable runtime pin, and a provenance
  record binding repository, workflow/run, Git commit, runtime-pin identity,
  and installer/source SHA-256 plus byte lengths. Every external build action
  is pinned to an exact commit and the materialized checkout must remain clean.
  The local `pnpm desktop:bundle` wrapper must activate the same required-runtime
  gate. The artifact name also includes the full commit SHA; a mutable filename
  or unbound aggregate pass count is not release evidence.

### Player-actor security and lifecycle evidence

The in-process actor cannot be accepted until the explicit user approval for
its contained `unsafe` dynamic-library/libVLC/Win32 boundary is recorded. Audit
the implementation for exact ABI/symbol versions, pointer ownership, one-thread
affinity, bounded callbacks, stale-generation fencing, panic containment,
child-window ownership, and callbacks-after-teardown prevention.

- Revalidate opaque media identity, root generation, hash, byte length,
  duration, and decode evidence immediately before Prepare. No WebView path or
  arbitrary native handle may cross IPC.
- Prove only native decoded Playing opens sampling. Pause, buffering, end,
  error, actor loss, window close, and teardown must fence sampling before UI
  projection and retain an authoritative recovery boundary.
- Test Prepare/Play/Pause/Resume/Stop/End/Error, stimulus transition, rerun,
  recovery restart from zero, rapid command races, stale callbacks, and clean
  repeated shutdown.
- Test supported containers/codecs, corrupt/truncated/zero-length/renamed files,
  missing plugins, audio present/absent, output device changes, mute/volume
  policy, seek prohibition, multi-monitor movement, resize, minimize/restore,
  and 100/125/150/200% display scaling.
- Exercise native-library load and symbol failure without process crash. Run
  leak/handle-growth and forced-termination checks on the packaged candidate.
- Prove `unqualifiedWebview` is an explicit opt-in, never an automatic fallback,
  and that status, first event, journal, receipt, and manifest all retain the
  unqualified label. Its media errors must still stop native sampling.
- For the unqualified desktop probe, require decoded-frame callbacks at the
  deterministic near-start, midpoint, and near-end positions; reject metadata,
  seek, or short-play evidence without those frames. Assert the
  `representativeFramesV1` / `webviewVideoFrameCallback` /
  `attestedUnqualified` labels and one-use grant consumption on success,
  rejection, and explicit revocation.
- Race delayed events from a detached prior video against the current source,
  lifecycle IPC against status polls, and an older status response against a
  newer response. Require run/participant/attempt/hash/playback receipt binding,
  per-source element generations, and fail-closed unknown-outcome reconciliation.

Runtime staging, a verified capability response, or successful unit tests alone
do not satisfy this gate.

## Persistence and adversity gates

- Verify create-new output directories and attempt counters never overwrite.
  Every terminal attempt contains the frozen settings snapshot, semantic
  `events.jsonl`, `ResearchRunManifestV2`, and selected rating files, all bound
  to exact settings/plan/stimulus identity.
- Test controlled Stop Early as terminal Partial separately from crash/write
  recovery. Resume is offered only for a valid recoverable journal and only at
  a safe boundary; a partially viewed stimulus restarts from the beginning.
- Exercise quota/full disk, read-only/unwritable workspace, revoked browser
  permission, unavailable IndexedDB, process/tab termination, power-loss
  simulation, corrupt/truncated journals, manifest/output disagreement,
  finalization interruption, and idempotent retry.
- Inject lifecycle event/checkpoint failures and prove native sampling/input
  authority stops while the last durable journal remains recoverable. Reject
  evidence shorter than journaled prefixes; permit only deterministic repair
  beyond those prefixes. Exercise the explicit Setup pending-finalization action
  without demographics or acquisition preflights and bind its receipt to the
  exact durable run, participant, attempt, outcome, settings, plan, and playback
  provenance.
- Prove accepted evidence is never silently discarded, backfilled, relabelled,
  overwritten, or called Complete before durable finalization and lock release.

## Timing qualification

Run separate visible 30-minute tests at 130 Hz on the exact packaged Windows
Tauri candidate, current desktop Chrome, and current desktop Edge. Each receipt
must show:

- mean steady-state rate from 129 through 131 Hz;
- p95 scheduler lateness no greater than two configured periods;
- input-to-authoritative-state p95 no greater than two periods in Tauri and
  three periods in Chrome/Edge;
- zero silent sequence gaps, invented catch-up rows, timestamp backfill,
  corrupt rows, or unreported stalls; and
- one explicit timing-gap event for every missed slot.

Also test 1 Hz and 240 Hz, pause, native/browser buffering, visibility loss,
minimize/restore, sleep/wake, every between-video policy, neutral reset,
state-anchor age, clock mapping, and recorded monotonic/LSL-compatible time and
jitter. Rendering must never control the scheduler.

## LSL qualification

- Resolve the regular state and irregular marker outlets with an independent
  current receiver and LabRecorder.
- Confirm eight Float32 channels in exact order, configured nominal rate,
  source metadata, LSL/monotonic timestamp relationship, lifecycle markers,
  restart, disconnect/reconnect, sleep/wake, gap reporting, and clean shutdown.
- Verify missing or incompatible LSL fails Start with a useful bounded status,
  and Chrome/Edge preserves imported values but blocks Start when LSL is enabled.
- Confirm markers contain no raw names, typed text, arbitrary error/path data,
  settings bodies, or video data. Do not claim clock identity with independently
  running Polar software.

## Accessibility, containment, and deployed evidence

- Complete Setup and Run using only the keyboard. Verify visible focus,
  semantic labels/status, polite announcements, non-color meaning, contrast,
  200% zoom/reflow, and reduced-motion behavior.
- Test exact two-mode navigation and seven Setup accordions in the real Pages
  build and packaged Tauri application. Hiding feedback must not hide timing,
  write/recovery, or LSL status.
- Verify the allowlisted Pages and desktop build closures contain no WebXR,
  Quest, remote/VDO/BRSP, Party/Ground Control, direct Polar, face, touch,
  calibration, retro, phone/Picture-in-Picture, or legacy media assets/routes.
- Qualify current Chrome and Edge separately against the exact deployed commit,
  including cache-bypassed loading at
  `https://GeorgeFejer91.github.io/affect-tracker-research/`.
- Test Experimental YouTube URL/video-ID normalization, metadata, unverified
  status, no byte hash, offline/blocked behavior, and qualification exclusion.
  Tauri must reject it until its CSP/referrer/player feasibility has a separate
  receipt.

## Release boundary

CI may validate the static artifact and unsigned Windows candidate. The internal
`0.4.0-alpha.1` label remains non-stable and non-research-ready until every
applicable automated, installed-artifact, timing, media, recovery, input, LSL,
accessibility, and physical workflow gate above passes for one exact candidate.

Publishing or signing an installer, creating a public GitHub Release, enabling
an updater, submitting to a store, or handling production credentials requires
explicit authorization. Test the exact artifact before promotion; never rebuild
after approval and call it the same release.
