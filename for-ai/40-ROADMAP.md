# Research v1 roadmap

[`15-RESEARCH-V1-CHARTER.md`](./15-RESEARCH-V1-CHARTER.md) defines the target.
This file records implementation and qualification truth. The first internal
candidate is `0.4.0-alpha.1`; it is neither stable nor research-ready.

## Repository transition — verified

- Research retains ancestry through exact pre-split commit
  `5df1e5365aacd2e59cd36347d752b003f1af432d`; the implementation branch was cut
  from charter commit `8a3df6fbb2be0cc20ebc4635ba85e4104a56a934`.
- `checkpoint/feature-rich-2026-09-03` and annotated tag
  `checkpoint-2026-09-03-feature-rich` resolve to exact approved commit
  `34a137d9d6d0f33a8e5ebef6c04bf8bc0219fd86` in Research and Playground.
- [`affect-tracker-playground`](https://github.com/GeorgeFejer91/affect-tracker-playground)
  preserves the complete branch/tag graph. Its `main` has one checkpoint
  descendant, relocation-only commit
  `5d1f5fa3d30f93b3f2797a74b02e1f336acb7bc3`; later pre-split source remains on
  `history/post-checkpoint-source-main` at
  `5df1e5365aacd2e59cd36347d752b003f1af432d`.
- The active Research working tree removes superseded WebXR/Quest, remote,
  Party/Ground Control, direct Polar, face, touch, calibration, retro, phone,
  and legacy study source/assets/tests. This reduction is recoverable from the
  refs above and is committed and pushed on the implementation branch at
  `b61f9bbd2547a2f971f44e0de2cbe1e4325243f7`.

## Implemented candidate slices

The current `research/video-protocol-v1` working candidate contains:

- allowlisted Research-only Pages and desktop entrypoints plus artifact-closure
  verification;
- strict JavaScript and Rust Research contracts, canonical JSON/SHA-256,
  explicit legacy-import reporting, and deterministic Williams/cyclic
  `balanced-v1` assignment;
- exactly two UI modes, seven ordered Setup accordions, persistent preview,
  participant planning, input configuration, visual/color/mapping controls,
  aggregate preflight, and restricted Run presentation;
- browser File System Access workspace handling, bounded recursive catalogue,
  write/read/delete readiness probe, real manifest/output audits, dedicated
  sampling worker, explicit timing gaps, IndexedDB journal, CSV/TSV parity,
  partial/final paths, pending-finalization recovery, and evidence quarantine;
- browser worker clock-origin mapping, session/command/provenance fencing, and
  fail-closed media-to-sampler behavior intended to prevent stale rows from
  crossing stimulus or recovery boundaries, plus a non-production worker-only
  diagnostic that exposes trailing silence, missing or unmatched planned state
  probes, exact-anchor mismatches, and visibility loss without claiming
  full-application qualification;
- direct `IndexedDbResearchJournal` adversity coverage for transaction abort,
  quota rejection, reload/reconciliation, and durable corrupt-evidence
  quarantine, using an atomic test harness that fails if the adapter touches
  `localStorage` or falls back to the in-memory journal;
- Rust Research contract, workspace, runtime, scheduler, persistence, input,
  LSL, participant-state, and narrow Tauri command modules, including exact
  run-ID binding for renderer lifecycle/finalization commands, selected-library
  revalidation, retry-safe terminal-output promotion, durable-prefix recovery,
  and reload-only pending-finalization;
- typed native persistence checkpoints across initial snapshots, empty event
  log, rating headers, streaming rows/events, and recovery journals; an input-
  authority exit fence; and conservative unpublished-session cleanup that
  revalidates exact directory identities and refuses swapped session/recovery
  links before removing its closed artifact set;
- exact LSL state/marker metadata validation plus an opt-in Windows local-
  socket loopback through the project service, covering discovery, inlets,
  payloads, timestamps, shutdown, and distinct-run restart without claiming an
  independent-receiver or LabRecorder qualification; and
- unqualified WebView generation/run fences, ordered native status projection,
  strict Start/Resume/terminal receipt binding, explicit unknown-outcome
  reconciliation, and a reachable acquisition-free finalization action.

The latest combined safe-hardening run passed 209/209 JavaScript tests. The
Rust all-feature matrix passed 119 tests with the explicitly environment-gated
LSL loopback ignored by default, and the no-default-feature matrix passed
118/118 tests. Format, both-matrix check and clippy, dependency audit,
Pages/desktop builds, Research-only artifact closure, the required-runtime NSIS
bundle gate, and a separately invoked real local LSL loopback also passed.
These local automated results do not qualify physical workflow, independent
LSL reception, long-run timing, or native VLC playback.

## Native input status — safe pointer and gamepad authority implemented

Implemented:

- one listen-only Rust `ResearchInputService` owns native Setup capture/test and
  Run input without adding a local `unsafe` surface;
- test receipts are one-use, expire after 15 minutes, and bind all four tested
  directions to the canonical binding hash and device epoch;
- OS repeat is suppressed, capture conflicts fail closed, Pause/focus/layout
  barriers publish inactive state without changing rating coordinates or
  rearming held keys, and Setup
  focus/binding/device changes invalidate evidence;
- mouse-button and wheel actions are restricted to native client-coordinate
  regions for the visible test, capture, and Run-feedback surfaces; and
- Pointer Grid projects only normalized coordinates after an inside-region
  primary-button press, and a Windows-only XInput adapter supplies D-pad,
  left-stick, right-stick, and custom gamepad-button semantics without exposing
  dependency device identities;
- a serialized callback barrier, bounded 128-edge FIFO, latest-state continuous
  coalescing with an observable safe-integer counter, authority-loss priority,
  persistence-failure classification, timeout-safe worker ownership, and durable
  fail-closed recovery prevent silent native-input loss; and
- Tauri no longer accepts WebView affect-state or gamepad-button updates as Run
  authority. Browser input behavior remains separate and unchanged.

The Tauri backend now enables Arrow keys, WASD, IJKL, numpad,
mouse-button/wheel, Pointer Grid, gamepad D-pad/sticks, and compatible custom
bindings when their native backends are available. This closes the software
adapter portion of the former native-input roadmap item. Hardware, DPI,
multi-monitor, focus, disconnect, latency, and Pause/Stop-region qualification
remains pending and no physical-device claim is made from automated tests.

## Native libVLC status — safe groundwork only

Implemented safe groundwork:

- exact libVLC 3.0.23 Windows x64 archive/source pins, official hashes, and a
  canonical 368-file / 142,167,916-byte staged-tree manifest identity;
- a deterministic staging/verifying script that rejects traversal, links,
  missing/extra/modified files, coordinated DLL-plus-manifest tampering, and
  wrong-architecture engine DLLs while preserving upstream notices;
- a build-time package gate controlled by
  `AFFECT_RESEARCH_REQUIRE_LIBVLC_RUNTIME=1`;
- a Windows x64 local bundle wrapper that always activates that gate, plus
  commit-pinned desktop workflow actions and repository/workflow/run/runtime-
  pin/installer/source provenance;
- a path-free native-media capability contract;
- run/receipt/recovery labelling for `nativeLibvlc` versus explicit
  `unqualifiedWebview`, including fail-closed media-error handling;
- an IPC authority fence that accepts renderer playback lifecycle/failure
  events only for the exact active run in the explicit unqualified WebView
  fallback. A future qualified libVLC run cannot treat WebView media events as
  native playback authority;
- per-source detached video generations, ordered status/lifecycle fencing,
  strict receipt binding, duration-end validation, and explicit restart-required
  handling when native terminal state cannot be reconciled; and
- explicit lower-trust WebView decode evidence requiring representative frame
  callbacks near the start, midpoint, and end. One-use media grants are
  consumed and this evidence remains labelled `attestedUnqualified`; it cannot
  satisfy the future native libVLC qualification gate.

Not implemented or qualified:

- dynamic DLL loading and libVLC symbol binding;
- the serialized libVLC player actor and callback fencing;
- the application-owned child HWND/render-rectangle adapter;
- native playback commands/events connected to exact media grants; or
- packaged playback, codec, DPI/resize, audio, recovery, shutdown, and soak
  receipts.

The capability therefore reports `playerActorReady: false` and
`qualifiedStartAvailable: false`; `nativeLibvlc` is the default but qualified
Start fails closed. Implementing the remaining direct FFI/Win32 adapter requires
explicit approval for the contained `unsafe` boundary, followed by focused
audit. Staging the DLLs does not remove that gate and is not playback
qualification.

## Open software work before candidate acceptance

1. After explicit approval, implement the contained native libVLC actor and its
   child-window adapter, connect player lifecycle atomically to the scheduler,
   and pass the security/lifecycle gates in
   [`30-TESTING-AND-RELEASE.md`](./30-TESTING-AND-RELEASE.md).
2. Implement native libVLC-owned duration/decode preflight and exact lifecycle
   authority for workspace/repository sources after the actor exists.
3. Exercise real full-disk/power-loss and directory-entry durability, real
   browser quota/permission loss, and packaged Setup-to-Run/recovery workflows;
   deterministic initial/streaming/journal and IndexedDB transaction fault
   coverage is now implemented.
4. Publish the combined safe-hardening commit, re-run every JavaScript/Rust/
   build/advisory gate in CI, inspect its isolated artifacts, and launch its
   exact unsigned Windows installer.
5. Publish the validated implementation branch through normal repository
   safeguards, verify CI, merge deliberately, deploy Research Pages, and bind
   all later qualification receipts to the exact resulting candidate.

## Qualification receipts — limited engineering evidence only

Exact committed candidate `69f1729fda0d45dbdbf4009659e9c3b0db12895e`
passed [Pages CI](https://github.com/GeorgeFejer91/affect-tracker-research/actions/runs/33921097839)
and [Desktop CI](https://github.com/GeorgeFejer91/affect-tracker-research/actions/runs/33921097853).
Desktop artifact `9955275027` bound that SHA and the pinned VLC runtime; its
artifact digest is
`bcb6ba7cce5cddc165235d0c3f751c7c6b2e326ed937f4a5d54056f070799a0e`
and its 39,648,784-byte unsigned NSIS installer SHA-256 is
`b66f0b9af4b1269847d70814e7229adc1eae5a5dce5c84b81d6969f1a2d86173`.
The installer was installed into an isolated temporary location, launched
responsively as **Affect Research**, and closed cleanly.
This is installer-integrity/startup evidence, not Setup-to-Run, native playback,
hardware, or installed-workflow qualification.

A ten-second current-Chrome Worker diagnostic at 130 Hz recorded 1300/1300
slots, zero gaps/missed/corrupt rows, five planned/sent/matched state probes,
130.048255 Hz mean rate, 4.776923 ms p95 lateness, and 12.199951 ms p95
state-to-sample latency. It correctly failed only the required 30-minute-window
gate. This is Worker-only diagnostic evidence, not a visible full-application
Chrome receipt. Current Edge remains untested because the required browser-
control endpoint was unavailable.

The project LSL service has also passed a same-process Windows local-socket
loopback for exact metadata, channel order, nominal rate, state/marker payloads,
timestamps, shutdown, and distinct-run restart. It is not independent-receiver,
LabRecorder, network reconnect, sleep/wake, packaged-candidate, or long-run
qualification. No physical-workflow, native-playback, 30-minute timing, or
accessibility qualification receipt currently exists for Research v1.

Before a stable or research-ready claim, record:

1. Separate visible 30-minute 130 Hz runs on declared Windows hardware in the
   packaged Tauri app, current Chrome, and current Edge: mean 129–131 Hz; p95
   lateness at most two periods; input-state p95 at most two Tauri periods and
   three browser periods; zero silent gaps/backfill/corrupt rows; explicit event
   for every missed slot.
2. Representative 1 Hz and 240 Hz runs plus pause/buffering, every transition,
   neutral reset, visibility/minimize, permission loss, unavailable IndexedDB,
   quota/full disk, forced termination, and safe-boundary recovery.
3. Independent LSL receiver and LabRecorder evidence for channel order,
   metadata, nominal rate, timestamps, markers, reconnect, gap reporting, and
   clean shutdown.
4. Real keyboard, mouse, wheel, pointer/trackpad, and supported gamepad checks;
   keyboard-only Setup/Run; visible focus; labels/status; non-color meaning;
   reflow/contrast; announcements; and reduced motion.
5. Installed native libVLC evidence for exact runtime integrity, supported media,
   player/scheduler lifecycle, errors, DPI/resize, audio, recovery, shutdown,
   forced termination, and a 30-minute run.
6. Cache-bypassed verification of the exact deployed Pages commit and real
   launch of the exact unsigned Windows installer artifact.

Experimental YouTube remains noncanonical and outside research qualification.
Until all applicable receipts exist, retain `0.4.0-alpha.1` and do not publish a
stable/signed installer, GitHub Release, updater, store build, or research-ready
claim.
