# Project metadata and global goals

## Canonical identity

- Project: **Affect Tracker**
- Canonical repository: <https://github.com/GeorgeFejer91/affect-tracker-web>
- Public web application: <https://GeorgeFejer91.github.io/affect-tracker-web/>
- Primary branch: `main`
- License: BSD-3-Clause
- Origin attribution: [`afourcade/AffectTracker`](https://github.com/afourcade/AffectTracker)
- Canonical Windows working clone: `C:\Users\Georgeous\Documents\GitHub\affect-tracker-web`

The Git repository root is the central project folder. Do not create a second independent "master" copy. On another machine or after a workspace move, discover the canonical local root with `git rev-parse --show-toplevel`; the absolute Windows path above is informational, not a portable configuration value.

## Project goal

Maintain one research-quality valence/arousal tracker with three primary semantically corresponding study surfaces and one specialized native form:

1. a static, self-contained GitHub Pages 2D application for designing and running portable studies, local acquisition/export, explicitly authenticated control of an enabled desktop target, and a session-only browser-owned smooth/21×21 main-tracker affect traversal;
2. a cross-platform Tauri v2 desktop companion with a Rust study authority, durable local records, synchronized face/Flubber presentation, transient continuous/11×11 traversal, transparent always-on-top Flubber overlay, global physical-input capture, and always-on local LSL streams;
3. a hosted WebXR runner for the complete portable participant flow in an immersive browser session; and
4. a specialized native Meta Quest Spatial SDK APK with local spatial video, compositor passthrough, Touch or explicit Polar H10 affect input, and same-LAN LSL.

Pages 2D, desktop, and WebXR must execute the same versioned study semantics after the staged migration in `25-MIRRORED-STUDY-ARCHITECTURE.md`. Shared affect semantics, rendering mathematics, portable settings, terminology, accessibility, and privacy rules remain aligned unless this directory records an explicit capability exception. Native Quest remains a separately qualified fourth form until its later adapter phase.

## Global constraints

- Research data stays participant-local unless a reviewed mode explicitly asks the participant or researcher for a destination. The experimental WebXR study may send its completed CSV only to an HTTPS webhook typed for that run; the URL is not persisted, and download remains available if delivery is absent or fails. The authenticated desktop controller defined in `25-MIRRORED-STUDY-ARCHITECTURE.md` may observe or export only app-owned records under an explicit Rust grant; it is not cloud collection and has no arbitrary-file or raw-external-ECG authority. The separate explicit remote-Flubber mode may publish only the anonymous final X/Y pair plus normalized Flubber viewport placement through the public VDO.Ninja room defined in `66-EXPERIMENTAL-REMOTE-FLUBBER.md`; it never publishes raw pointer trajectories and is never an experiment-record upload. The independent settings beacon may publish only one immutable copy of the complete portable settings JSON under `68-EXPERIMENTAL-SETTINGS-BEACON.md`; it sends no research records or live coordinates and requires preview plus explicit Apply at the receiver.
- Never record composed text, clipboard content, application contents, unrelated window titles, or other unnecessary personal data. Pointer movement is permitted only under the explicit, visible web-only Experimental Touch/Trackpad source described in `60-EXPERIMENTAL-TOUCH-TRACE.md`; raw points are logged only during active experiment playback. Polar H10 physiology is permitted only after the user-triggered browser chooser or native launcher Connect/permission flow described in `65-EXPERIMENTAL-POLAR-STREAM.md`; raw ECG remains bounded in memory and is never persisted.
- Keep the browser app static and GitHub Pages-compatible. Do not add a backend, telemetry, CDN, runtime package dependency, or remote asset silently.
- Keep native affect/settings/input/LSL and desktop-study authority in Rust behind narrow typed Tauri commands/events/channels. Treat WebView input and imported settings as untrusted. The explicit desktop Party adapter may transport a bounded projection of Rust snapshots and render returned Party scenes, but Party data must never mutate native affect state, settings, history, markers, or LSL authority. The only planned remote-mutation exception is the authenticated, scoped experiment controller in `25-MIRRORED-STUDY-ARCHITECTURE.md`; it enters the same Rust reducer through a separately authorized remote origin and may never reuse the presentation-only Party path.
- Preserve product-module correspondence across UI, frontend code, and backend/native code. Every top-level product surface or accordion has one explicit project folder and protocol boundary with its own assets, state, responsibilities, privacy/data contract, and tests. When a frontend module requires privileged or native behavior, the backend must expose a matching narrow named domain adapter/service instead of placing that behavior in a generic privileged command layer. Shared shells coordinate visibility and documented precedence but do not absorb module-specific acquisition or business rules. Browser-only modules may have no backend counterpart, but their browser module folder remains the authority.
- Preserve least-privilege capabilities, restrictive CSP, local packaged content, and clean native-resource shutdown.
- Do not claim browser features can provide the same transparent, click-through, OS-global overlay or global input capture as Tauri.
- Preserve Windows, macOS, and Linux packaging. State Linux Wayland global-input limitations accurately.
- Preserve BSD-3-Clause licensing, upstream attribution, release notices, lockfiles, and reproducible CI.
- Do not publish signed/notarized/store releases or handle signing credentials without explicit user authorization.

## Source-of-truth map

- `for-ai/`: durable project intent, constraints, architecture, testing, roadmap, and agent workflow.
- `for-ai/25-MIRRORED-STUDY-ARCHITECTURE.md`: normative target, trust boundary, staged status discipline, contracts, remote-control profile, exclusions, pins, and qualification requirements for Pages 2D, desktop, and WebXR semantic correspondence.
- `crates/study-core/`: strict `StudyDefinitionV1`/run/action/event/result contracts, canonical publication hashing, deterministic ordering and constrained trial conditions, and the one native/WASM lifecycle reducer. Its fixtures are automated semantic evidence, not physical-platform qualification.
- `site/src/study/` and `site/study.html`: ordinary 2D Study Studio, Pages participant adapter, current-browser content-digest binding, questionnaires, WASM authority adapter, IndexedDB journal, and partial-record recovery.
- `site/src/study-xr/` and the Portable Study mode in `site/webxr.html`: bounded immersive panels, controller interaction, capability preflight, and hash-verified `contentAsset` media adapters downstream of the shared WASM authority. The legacy selectable-stimulus runner remains separate, and physical Quest support is still unqualified.
- `src-tauri/src/study_runtime.rs`, `src-tauri/src/asset_vault.rs`, and the study projection in `src-tauri/src/runtime.rs`: native Rust study authority; durably appended partial/final CSV and digest-bound result-manifest persistence; staged content-addressed imports; prepare-time fresh hash/length verification frozen into the final manifest; and the fixed privacy-bounded LSL lifecycle-marker allowlist emitted only after durable action success. Native picker/player integration, opaque-ID Range serving, trusted codec/duration/audio/projection/stereo probing, partial-record recovery UI, and packaged-platform qualification remain open.
- `site/src/remote-study/` and `site/vendor/brsp/1/e6a5eef86d4b3c7422ace08706df5deb82338808/`: the current QR-only BRSP/1 observe/control slice and its exact vendored MIT source. It is not evidence that OPAQUE/passwordless, all scopes, Rust-owned grants, record export, or hostile-network qualification has landed.
- `site/src/math.js`: canonical SVG affect renderer for both delivery forms.
- `site/src/portable-settings.js` and `site/settings.json`: canonical browser-side portable settings contract/defaults.
- `src-tauri/`: authoritative Rust state, validation, persistence, input monitoring, lifecycle, and LSL implementation.
- `site/`: static online application and online-only experiment module; optional VDO.Ninja transport is checked in locally and requires no CDN, package install, or project backend.
- `site/src/touch-trace.js`: browser-only trajectory filtering, equal-distance geometry, direct continuous and gated live move-and-hold feedback, adaptive calibration, and trace fitting.
- `site/src/polar-stream.js`: browser-only Web Bluetooth capability boundary, Polar H10 PMD/heart-rate decoding, bounded ECG/RR metrics, and GATT lifecycle.
- `site/src/flubber-remote.js`: browser-neutral VDO.Ninja discovery, data-channel lifecycle, the shared-channel 12-byte affect and typed 16-byte normalized-viewport-position protocols, sequencing, scheduling, staleness, diagnostics, relative-placement math, and test injection boundary.
- `site/vendor/vdoninja/1.5.5/`: locally loaded unmodified official VDO.Ninja SDK distribution/source, MPL-2.0 license, provenance notice, and verified hashes.
- `vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/PolarH10Manager.kt`: application-scoped native Quest H10 discovery, official-SDK streaming, readiness, lifecycle, and privacy boundary.
- `vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/PolarMetrics.kt`: native bounded mirror of the browser's ten metric definitions, per-axis mappings, and readiness gate.
- `site/src/mobile.js`: browser-only narrow touch-capable viewport detection, pure forward/inverse face-and-Flubber pane layout, grab-existing-marker coordinate helpers for the one-time smartphone controller discovery, and pure local Party camera projection/inversion helpers; responsive presentation remains in `site/styles.css`. The direct phone grid retains grab-existing-marker behavior in smooth mode and targets any nearest exact cell while the browser's 21×21 transition is selected.
- `site/screen-calibration/`: self-contained browser-only Screen Calibration product module, including its controller, coin/currency authority, geometry/record contract, and local visual assets.
- `site/src/theme-bootstrap.js`, `site/src/retro-theme.js`, and `site/assets/retro-ui/`: browser-local pre-paint Windows 95 skin restoration, selective low-volume system-event cue routing, and pinned local Kenney CC0 audio. Routine interaction remains silent; the theme never enters portable settings or forks product behavior.
- `site/src/affect-matrix.js`: pure browser state-machine helper for the session-only 21×21/441-state main-tracker traversal, exact `0.1` coordinate/index conversion, shortest diagonal-then-cardinal paths, and bounded `0.5–20` states/second advancement. `app.js` remains the browser affect authority, owns arbitration, and passes each exact current node into the existing shared render snapshot. This does not extend portable settings, LSL, WebXR, native Quest, or the Rust desktop traversal.
- `site/src/face-engines.js`, `site/src/face-model.js`, `site/src/face-affec.js`, `site/src/face-mediapipe-calibration.js`, and `site/src/face-photo.js`: the five selectable main-tracker face modes: AFFEC empirical, build-time MediaPipe-atlas-derived, continuous project-authored morph, 21×21 matrix anchors, and an 11×11 project-owned photo atlas. The photo cells are generated offline by `scripts/build-dense-photo-atlas.py` from nine owned anchors; the matrix-anchor profile separately caches only 441 compact coefficient records at exact nodes and evaluates its anchor surface continuously off-grid. Every face mode consumes one current-X/current-Y/phase snapshot and owns no input, study clock, recognition, or diagnostic authority.
- `site/src/face.js`: canonical project-authored vector face mapping and local fallback. The mirrored study's `faceFlubberComparison` instruction deliberately uses this vector face rather than making the five main-tracker engines part of `StudyDefinitionV1`.
- `site/assets/affect-face/NOTICE.md` and `site/vendor/three/0.184.0/LICENSE`: provenance/licensing for the local CC0-derived Vitruvian GLB/textures, project-created synthetic atlas, and vendored MIT Three.js runtime. No face model or camera pipeline is fetched at runtime.
- `site/src/accordion-protocols.js`: canonical registry for the seven top-level web modules, including Synchronized Face + Flubber, their distinct responsibilities, mutually exclusive open state, and cross-module Touch/Trackpad activation rule.
- `site/src/ground-control.js`: browser-neutral Ground Control authority for named portable-settings snapshots, validated public discovery, and the static-settings VDO.Ninja channel. Live X/Y remains delegated to `flubber-remote.js`.
- `site/src/flubber-collaboration.js`: browser-neutral Ground Control role gate, isolated reciprocal Universe session, symmetric full-scale saturated coordinate combination, bounded explicit multi-receiver FLUBBER party orchestration, and the validated reciprocal aggregate Party-scene envelope.
- `desktop/src/party.js` and `desktop/src/party-core.js`: Tauri settings-WebView Party host/broadcaster presentation, explicit lifecycle, Rust-snapshot projection, deterministic guest placement, and returned-scene acceptance. They reuse the browser-neutral transport/protocol modules and cannot command native affect state.
- `site/webxr.html`, `site/src/webxr-study.js`, `site/src/webxr-study-core.js`, and `site/src/webxr-stimuli.js`: experimental headset-browser entrypoint containing both the legacy selectable repository-hosted stimulus runner and the separately selected shared-authority Portable Study runner. The latter loads a published definition before XR, fails unsupported capabilities closed, renders portable panels and verified local flat/180°/360° media, and journals the shared result contract; neither path is physical-device qualification evidence.
- `for-ai/70-RESEARCH-PROVENANCE.md` and `for-ai/references.bib`: source-decision ledger and citation-ready bibliography.
- `for-ai/65-EXPERIMENTAL-POLAR-STREAM.md`: normative Polar Stream support, privacy, metric, mapping, precedence, and qualification contract.
- `for-ai/66-EXPERIMENTAL-REMOTE-FLUBBER.md`: normative public discovery, wire protocol, input ownership, privacy, observability, and hardware qualification contract for browser-to-browser Flubber coordinates.
- `for-ai/68-EXPERIMENTAL-SETTINGS-BEACON.md`: normative Ground Control public discovery, named static snapshot, validation, preview/apply, and privacy contract for browser-to-browser portable settings.
- `for-ai/69-EXPERIMENTAL-FLUBBER-COLLABORATION.md`: normative ordinary-role exclusion, reciprocal Universe co-control, bounded party invitation, rendering, privacy, and lifecycle contract.
- `desktop/`: Tauri WebView presentation and typed native adapter.
- `.github/workflows/`: deployment, verification, and native packaging automation.

If these sources disagree, stop and resolve the inconsistency deliberately. Do not silently choose whichever implementation is easiest.
