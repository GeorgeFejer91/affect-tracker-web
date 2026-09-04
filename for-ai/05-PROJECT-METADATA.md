# Project metadata and global goals

## Canonical identity

- Project: **Affect Tracker Research**
- Desktop product name: **Affect Research**
- Canonical repository: <https://github.com/GeorgeFejer91/affect-tracker-research>
- Public static application, when Pages is enabled and verified:
  <https://GeorgeFejer91.github.io/affect-tracker-research/>
- Primary development branch: `main`
- License: BSD-3-Clause
- Origin attribution: [`afourcade/AffectTracker`](https://github.com/afourcade/AffectTracker)
- Canonical Windows working clone:
  `C:\Users\Georgeous\Documents\GitHub\affect-tracker-research`

The Git repository root is the project authority. Do not create a second
independent master copy. Discover it with `git rev-parse --show-toplevel`; the
absolute path above is informative, not a portable configuration value.

## Feature-rich checkpoint

The frozen historical reference is the remote branch
`checkpoint/feature-rich-2026-09-03` and annotated tag
`checkpoint-2026-09-03-feature-rich`, both created from commit
`34a137d9d6d0f33a8e5ebef6c04bf8bc0219fd86`. The tag explicitly records a
reproducibility checkpoint rather than a release or research-ready/platform
qualification claim. Later Git history remains available normally; this
reference must not be moved or rewritten to make a newer state appear to have
been the original checkpoint.

Research `main` retains the complete repository history through migration
baseline commit `5df1e5365aacd2e59cd36347d752b003f1af432d`. Its presence on
`main` preserves the feature-rich source for deliberate reduction; it is not
evidence that the new Research contract has been implemented or qualified.
The same post-checkpoint feature-rich source is preserved in the separate
[`GeorgeFejer91/affect-tracker-playground`](https://github.com/GeorgeFejer91/affect-tracker-playground)
repository on branch `history/post-checkpoint-source-main`, pinned there at
`5df1e5365aacd2e59cd36347d752b003f1af432d`. That external history branch does
not move or replace either exact `34a137d` checkpoint reference in this
Research repository.

## Active Research v1 goal

Build one focused continuous valence/arousal research instrument with exactly
two user-visible modes:

1. **Setting Up the Experiment**; and
2. **Running the Experiment**.

The active support matrix is deliberately narrow:

- Tauri v2 on Windows, including the in-application normalized feedback
  overlay, local input authority,
  durable records, and outbound LSL; and
- the static web adapter in current desktop Google Chrome and Microsoft Edge,
  with local browser records and no claim of native overlay, global input, or
  LSL capability.

The two adapters share the normalized Research settings contract, affect
coordinates and derived values, automatic `balanced-v1` condition allocation,
continuous sampling semantics, and CSV/TSV row meaning. Capability differences
must be explicit and must never be simulated or silently skipped.

## Global constraints

- Continuous rating is always active in a run. There is no single-summary or
  summary-only rating mode.
- Research sampling defaults to 130 Hz and is configurable from 1 through
  240 Hz. One authority owns the configured rate across sampling, recording,
  and the Windows regular LSL state stream.
- A run freezes one validated `settings.json` snapshot and one automatic
  `balanced-v1` allocation before collection begins.
- New workspace, allocation, output, and recovery data use the Research
  namespace. Existing application data is not imported automatically.
- Research data, settings, allocation state, CSV/TSV, recovery state, and LSL
  stay local. No active-v1 path uploads them or sends them to a remote peer.
- Rust owns native state, settings validation, run lifecycle, durable file
  operations, allocation reservation, global input, overlay state, and LSL
  behind narrow typed commands. The browser owns its local adapter and storage
  without native privilege.
- The canonical sample clock is independent of drawing. A delayed tick records
  a timing gap and resumes at the next real deadline; it does not fabricate
  missed rows.
- Preserve restrictive CSP/capabilities, local packaged/static assets, clean
  native-resource shutdown, accessibility, reduced motion, and explicit data
  status.
- Only Windows Tauri and current desktop Chrome/Edge may receive an active-v1
  support or release claim. macOS, Linux, Firefox, Safari, mobile, WebXR, and
  native Quest remain outside the matrix.
- Signing, installer publication, public releases, store submission, and
  production credentials still require explicit authorization.

## Active source-of-truth map

- `for-ai/15-RESEARCH-V1-CHARTER.md`: sole active product, authority, schema,
  support, privacy, and frozen-scope decision.
- `for-ai/10-PRODUCT-REQUIREMENTS.md`: active user-visible requirements.
- `for-ai/20-ARCHITECTURE.md`: active ownership, adapters, records, and LSL
  boundaries.
- `for-ai/30-TESTING-AND-RELEASE.md`: active qualification and release gates.
- `for-ai/40-ROADMAP.md`: implementation status; the charter itself is not
  evidence that code has landed.
- `site/settings.json` and `site/src/portable-settings.js`: legacy settings
  implementation inputs until replaced or migrated to the Research settings
  contract; they are not the new schema merely because they exist.
- `src-tauri/`: current native implementation and the intended owner of Windows
  Research authority after the migration.
- `site/`: current static implementation and the intended desktop Chrome/Edge
  adapter after the migration.
- `site/src/math.js`: current procedural Flubber geometry baseline. Active
  Research mapping becomes configurable only through the normalized settings
  and remains independent of drawing cadence.
- `for-ai/70-RESEARCH-PROVENANCE.md` and `for-ai/references.bib`: permanent
  source-decision ledger and bibliography. A provenance entry is not feature
  activation.
- `.github/workflows/`: automation that must eventually match the narrowed
  Windows plus desktop-browser release matrix before an active-v1 claim.

## Frozen Playground/history map

The following are retained as historical implementation, evidence, or design
and have no active-v1 product or release authority:

- `for-ai/25-MIRRORED-STUDY-ARCHITECTURE.md`, `crates/study-core/`,
  `site/src/study-xr/`, `site/webxr.html`, and the former three-surface portable
  study/BRSP program, except for code explicitly adopted later behind the
  Research charter;
- `vr/` and every native Meta Quest, WebXR, immersive-media, passthrough,
  controller-follow, and Quest LSL/Polar path;
- `site/src/remote-study/`, `site/src/flubber-remote.js`,
  `site/src/ground-control.js`, `site/src/flubber-collaboration.js`,
  `desktop/src/party.js`, VDO.Ninja, settings beacons, Remote Flubber,
  authenticated remote control, Universe, and Party;
- `site/src/face*.js`, detailed Face/Photoatlas assets and tools, all face
  engines, and `faceFlubberComparison`;
- browser and Quest direct Polar H10/Web Bluetooth/BLE adapters and metrics;
- the Touch/Trackpad classifier/playground, screen calibration, Windows 95
  skin/audio, phone-first shell, Picture-in-Picture, the legacy embedded video
  experiment (not the active Experimental YouTube source), and browser/desktop
  matrix-traversal experiments; and
- the historical qualification records and source ledger associated with those
  features.

Frozen source may remain while the active shell is being reduced. It must not
appear in active navigation, be exercised by default, create a client or
permission request, or contribute an active release gate. If it remains
reachable, its existing privacy, security, attribution, and licensing
constraints still apply.

If these sources disagree, stop and resolve the inconsistency against the
Research charter rather than choosing the easiest implementation.
