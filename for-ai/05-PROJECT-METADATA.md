# Project metadata and source map

## Canonical identity

- Project: **Affect Tracker Research**
- Desktop product: **Affect Research**
- Repository: <https://github.com/GeorgeFejer91/affect-tracker-research>
- Pages target: <https://GeorgeFejer91.github.io/affect-tracker-research/>
- Primary branch: `main`
- Active implementation branch: `research/video-protocol-v1`
- License: BSD-3-Clause
- Origin attribution: [`afourcade/AffectTracker`](https://github.com/afourcade/AffectTracker)
- Canonical Windows clone:
  `C:\Users\Georgeous\Documents\GitHub\affect-tracker-research`

The Git root is authoritative. Discover it with
`git rev-parse --show-toplevel`; do not put the machine-specific path into
application or build contracts.

## Feature-rich preservation

The immutable reproducibility checkpoint is exact commit
`34a137d9d6d0f33a8e5ebef6c04bf8bc0219fd86`, referenced in both Research and
Playground by:

- branch `checkpoint/feature-rich-2026-09-03`; and
- annotated tag `checkpoint-2026-09-03-feature-rich`.

The annotation records 471/471 local tests and CI runs `33746889634` and
`33746889623`; it explicitly is not a research-ready release or physical-device
qualification.

[`GeorgeFejer91/affect-tracker-playground`](https://github.com/GeorgeFejer91/affect-tracker-playground)
preserves the complete branch/tag graph and feature-rich source. Playground
`main` has exactly one checkpoint descendant, relocation-only commit
`5d1f5fa3d30f93b3f2797a74b02e1f336acb7bc3`. Later pre-split source remains on
`history/post-checkpoint-source-main` at
`5df1e5365aacd2e59cd36347d752b003f1af432d`. Research retains that ancestry in
Git even though the superseded working-tree files have been removed.

## Active product and support

The active product has exactly two user-visible modes:

1. **Setting Up the Experiment**; and
2. **Running the Experiment**.

The active-v1 qualification matrix is:

- Tauri v2 on Windows, with Rust-owned workspace, input, media, scheduler,
  records, recovery, and outbound LSL; and
- the static application in current desktop Chrome and Edge, with browser-owned
  workspace authorization, worker sampling, and IndexedDB recovery, but no
  native/global input or LSL claim.

Capability differences are explicit. macOS, Linux, Firefox, Safari, mobile,
WebXR, Quest, remote/collaborative surfaces, direct sensor acquisition, and
face/touch experiments are outside active v1.

## Product invariants

- Continuous rating is always enabled. Sampling defaults to 130 Hz and accepts
  only integer values from 1 through 240 Hz.
- One attempt freezes validated settings, deterministic `balanced-v1` plan,
  participant derivation, binding, exact stimulus identity, and overlay
  geometry.
- The sample clock is independent of rendering and records explicit gaps
  instead of backfill.
- Output and recovery use create-new/no-overwrite semantics under the selected
  Research workspace and `affect-research/v1` browser namespace.
- New Research data is never populated by automatic import from legacy
  application data.
- Windows qualified local/repository media targets a pinned bundled libVLC
  3.0.23 x64 runtime. Runtime verification is present; the actor remains
  unavailable until explicit `unsafe` approval, implementation, and audit land.
- Tauri keyboard, mouse-button/wheel, absolute pointer/trackpad, and XInput
  gamepad input is owned by one safe Rust service with focus/region fencing,
  one-use binding/device receipts, and a bounded fail-closed Run mailbox.
  Gamepad presets are advertised only when that backend starts; no preset may
  fall back to WebView-originated Run input.
- LSL is outbound, Windows-only, and shares the configured sampling rate; it
  does not imply clock synchronization with independent Polar software.
- Signing, installer publication, updater/store work, production credentials,
  and stable/research-ready claims require separate authorization and evidence.

## Active source map

- `site/index.html`, `site/research.css`, and `site/src/research/`: static UI,
  browser adapter, shared contracts, planner, renderer, and browser recovery.
- `site/src/math.js`: active procedural Flubber geometry baseline.
- `desktop/index.html` and `desktop/vite.config.js`: isolated Tauri WebView
  entrypoint and production frontend build.
- `src-tauri/src/research_*.rs`: Rust-owned Research contracts and services.
- `src-tauri/native-media/`: libVLC pin, deterministic staging/tree
  verification, and current safe integration boundary.
- `src-tauri/capabilities/research.json` and `src-tauri/tauri.conf.json`:
  narrow desktop exposure and package identity.
- `scripts/build-research-pages.js` and `scripts/verify-research-build.js`:
  allowlisted active artifact construction and legacy-surface exclusion.
- `test/math.test.js` and `test/research-*.test.js`: active JavaScript tests.
- `.github/workflows/`: Research validation, Pages deployment, and manual
  unsigned internal packaging.
- `for-ai/`: this active contract, status, qualification, workflow, and
  provenance set.

If these sources disagree, resolve the inconsistency against the Research
charter and report implementation status honestly in the roadmap.
