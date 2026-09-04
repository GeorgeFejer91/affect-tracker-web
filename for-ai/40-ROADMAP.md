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
  diagnostic that exposes trailing silence, unmatched state updates, and
  visibility loss without claiming full-application qualification;
- Rust Research contract, workspace, runtime, scheduler, persistence, input,
  LSL, participant-state, and narrow Tauri command modules, including exact
  run-ID binding for renderer lifecycle/finalization commands, selected-library
  revalidation, retry-safe terminal-output promotion, durable-prefix recovery,
  and reload-only pending-finalization;
- unqualified WebView generation/run fences, ordered native status projection,
  strict Start/Resume/terminal receipt binding, explicit unknown-outcome
  reconciliation, and a reachable acquisition-free finalization action.

The latest recorded combined local run passed 203/203 JavaScript tests. The
Rust all-feature and no-default-feature matrices both passed 112/112 tests;
format, both-matrix check and clippy, dependency audit, Pages/desktop builds,
Research-only artifact closure, and the required-runtime NSIS bundle gate also
passed. These dirty-tree/local automated results are not an exact committed-
candidate or installed-artifact receipt; physical gates still require
exact-candidate qualification before publication.

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
3. Extend persistence injection to initial-session, streaming, and journal-
   before-sync boundaries; exercise real full-disk/power-loss and directory-
   entry durability; and add packaged Setup-to-Run/recovery tests.
4. Commit the combined safe candidate, re-run every JavaScript/Rust/build/
   advisory gate in CI, inspect its isolated artifacts, and launch the exact
   unsigned Windows installer.
5. Publish the validated implementation branch through normal repository
   safeguards, verify CI, merge deliberately, deploy Research Pages, and bind
   all later qualification receipts to the exact resulting candidate.

## Qualification receipts — all pending

No installed-artifact, physical-workflow, native-playback, timing, LSL, or
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
