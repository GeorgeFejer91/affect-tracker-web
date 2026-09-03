# Roadmap

## Mirrored study program — approved target, not yet release-qualified

The complete target and its staged-status rule are normative in
[`25-MIRRORED-STUDY-ARCHITECTURE.md`](./25-MIRRORED-STUDY-ARCHITECTURE.md).
Pages 2D, Tauri/Rust desktop, and WebXR are the three primary study surfaces;
the native Quest APK is a specialized fourth form and does not gate their first
release.

- **Phase 1 — delivered as automated core evidence:** `crates/study-core`
  implements strict `StudyDefinitionV1`, run/action/state/event and result-
  manifest contracts, canonical publication hashes, seeded shuffle, Williams
  rows with a manual condition, one constrained typed `runIf`, and one reducer
  compiled natively and into checked-in WASM. Rust/WASM fixtures exercise the
  same hashes, orders, branches, events, revisions, and manifest validation.
- **Phase 2 — partial desktop vertical slice:** the desktop Study Studio selects
  the native Rust authority; `study_runtime` owns one run and appends an
  app-owned partial CSV before digest-bound CSV/result-manifest finalization. A
  native content-addressed vault stages, hash/length-verifies, deduplicates, and
  atomically catalogs imported bytes without projecting paths. Run preparation
  freshly re-hashes and re-measures every required app-owned object, fails on a
  missing/mismatched asset, and freezes the path-free observed/expected evidence
  into the active run and final `ResultManifestV1`. Successful durable actions
  emit only a fixed study-lifecycle LSL marker allowlist; questionnaire answers,
  samples, health/stall detail, branches, and caller-authored reasons are
  excluded. The current Studio player still uses WebView `File`/object-URL
  bindings. A native picker/player, opaque-ID Range serving, trusted codec/
  duration/audio/projection/stereo probing (`SuppliedUnprobed` is still allowed),
  partial-record recovery UI, and packaged-platform qualification remain open.
- **Phase 3 — delivered browser vertical slice, not qualified parity:** the
  ordinary 2D Study Studio authors/autosaves/validates/publishes portable
  revisions. Pages runs multi-block studies through the WASM authority, all
  seven questionnaire types, current-browser content hashing/binding, seeded/
  Williams ordering, constrained typed forward branching, long-form CSV/result
  manifests, and IndexedDB journaling with retained partial/finalized evidence,
  explicit two-file downloads, corrupt-record isolation, per-run Web Locks,
  atomic discard checks, and a transactional 64 MiB event-evidence ceiling.
  Media/sample writes have a configurable non-cancelling deadline watchdog:
  overruns synchronously fence playback, sampling, and controls until explicit
  researcher recovery. A permanently rejected accepted outcome can be retained
  explicitly as partial evidence; its staged action remains the visible data-
  loss boundary, ownership is released only after the real transaction settles,
  and previously committed evidence remains recoverable.
  The compact form/list/table UI follows pinned Uncodixfy guidance and borrows
  only the minimum section/trial/branch interaction structure documented from
  OpenSesame and Qualtrics. YouTube stays visibly Pages 2D-only. Real-browser
  quota/crash/large-export and cross-surface result qualification remain open.
- **Phase 4 — delivered WebXR code slice, physically unqualified:** the
  separately selected Portable Study mode loads published JSON before XR,
  requires WASM/IndexedDB/controller/media capabilities, renders authority-
  driven instruction/questionnaire/break/completion panels, and plays hash-
  verified local `contentAsset` clips in flat/180°/360° mono/SBS/top-bottom
  layouts. Timeline and affect samples pass only through the authority while a
  decoded frame is playing; unsupported capability and YouTube fail preflight.
  The canonical vector Face + Flubber instruction uses one exact snapshot.
  Portable media/sample journaling uses the same non-cancelling watchdog
  semantics: deadline alarms fence the in-headset player without catch-up or
  automatic resume, and rejected staged evidence has an explicit partial-retain
  route rather than a fabricated result.
  Quest 2/3/3S playback, controller, lifecycle, storage, recovery, legibility,
  and performance receipts remain open.
- **Phase 5 — partial QR-only controller slice:** the desktop Studio and hosted
  companion expose explicit enable/stop/connect UI around a ten-minute,
  single-use 192-bit fragment invitation, the exact vendored BRSP/1 and
  VDO.Ninja adapters, returned state, typed observe/control commands, and one
  15-second controller lease. Only `study.observe` and `study.control` are
  granted. BRSP proof and scope enforcement are still WebView-owned before Rust
  revalidates each typed action; therefore this is not the final security
  boundary. OPAQUE password-file and passwordless modes, Rust-owned auth/
  grants/audit/dedupe/revocation, remaining scopes, record/export lanes,
  reconnect hardening, direct/TURN receipts, and adversarial qualification are
  open.
- **Phase 6 — open support matrix:** packaged Windows WebView2, macOS WKWebView,
  Linux WebKitGTK or the explicit Chromium-helper fallback, and physical Quest
  WebXR must be gated separately. Adapt the native Quest APK only afterward.

Do not mark a phase delivered from schemas, mocks, a build, or architectural
similarity alone. Update this section only with exact implementation and
qualification evidence.

## V1 companion

- Two-window Tauri shell and tray lifecycle.
- Shared SVG renderer.
- Six selectable locally packaged main-tracker face modes—AFFEC empirical 3D, AFFEC-guided Photoatlas, build-time MediaPipe-atlas-derived 3D, continuous project-authored morph, 21×21 matrix anchors, and Direct-grid Photoatlas—with local photo/vector fallback, a GitHub Pages main-stage/phone pair and desktop settings pair, one current valence/arousal/phase snapshot, explicit provenance, and no runtime camera/recognition or diagnostic claim. Photoatlas offers one original and seven independently packaged fictional synthetic portrait presets through neutral phone, Face-options, and desktop selectors; only the selected 21×21 atlas is requested/decoded. The matrix-anchor profile caches only 441 compact coefficient records at exact `0.1` nodes and retains continuous evaluation off-grid.
- Rust affect engine and typed IPC.
- Transient desktop Continuous/11×11 matrix traversal with an exact neutral center, shortest 8-connected paths, bounded `0.5–10` states/second, and unchanged portable-settings/LSL schemas.
- Click-to-capture global key, mouse-button, and wheel bindings with arrow-key defaults.
- Optional advanced bindings for bounded animation speed, pulse amplitude, shape disorder, transparency, and overlay size adjustments.
- Configurable Circle, Heart, Triangle, and Square base envelopes shared by web, desktop, WebXR, and native Quest, with Circle as the legacy default and Polar-reactive Heart presentation.
- Four-color interactive valence-arousal feature space shared with the web app.
- Click-through overlay with explicit edit mode.
- Persisted settings.
- Always-on continuous affect and all-physical-input marker LSL outlets.
- Cross-platform CI checks and platform qualification checklist.

## Study integration follow-up

- In progress: native Quest Spatial SDK delivery under `vr/`, strict local video/session loading, transparent controller-movable Flubber, Media3 spatial playback, and same-LAN LSL. Host tests precede the required four-headset qualification matrix.

- Delivered: preloaded GitHub Pages video experiment with optional YouTube URL/start/finish configuration, countdown, protected playback, precise local CSV, and automatic export.
- Delivered as a local main-tracker presentation slice: the **Synchronized Face + Flubber** module selects AFFEC empirical 3D, AFFEC-guided Photoatlas, MediaPipe-atlas-derived 3D, continuous project-authored, 21×21 matrix-anchor, or Direct-grid Photoatlas modes on Pages and desktop. The detailed modes use pinned local Three.js plus checked-in CC0-derived Vitruvian GLB/textures and fall back through the default local photo atlas to the canonical vector face. A friendly-soft material grade suppresses strong red/yellow eye casts, selectively softens excess skin red, fixes the model iris to muted gray-green, and reduces glassy reflections without changing texture files, affect weights, geometry, SVG fallback, or photo-atlas pixels. Photoatlas provides the original plus seven fictional synthetic portrait packs spanning feminine-coded, masculine-coded, and androgynous styling and broad creator-prompt appearance inspirations. Public preset names are neutral; regional inspirations and unvalidated skin-tone descriptors remain provenance/audit data rather than identity labels. Every pack uses 441 offline landmark-warped nodes in a 21×21 grid generated from nine project-owned anchors; runtime continuously interpolates the selected atlas and ships no landmark model. The AFFEC-guided mode separates exact-archive-derived aggregate evidence from its project-authored portrait binding and leaves tracker X/Y unchanged; it is empirically guided, not portrait validation. Hash-bound per-pack QA and the fail-closed catalog gate establish deterministic rendering integrity only—not perceived affect, demographic identity, cultural authenticity, or representational adequacy. Every mode receives the same immutable displayed-coordinate/phase snapshot as its Flubber; browser/desktop selection remains local presentation state, the desktop overlay remains Flubber-only, and the UI discloses the no-camera/no-recognition/no-demographic-inference/no-diagnosis boundary. Automated tests do not establish empirical-expression validity or physical-platform qualification. The mirrored portable study deliberately uses only the canonical vector Face + Flubber comparison as an optional instruction presentation.
- Open performance and representation gates: profile every selected 3360×3360 atlas on the supported physical-phone matrix. Each decoded RGBA atlas is about 45.2 MB, but the browser requests and decodes only the selected pack and retains a vector fallback. Replace monolithic atlases with twenty-one 3360×160 row strips plus bounded two-row decode and one-row prefetch if Photoatlas readiness exceeds 2 seconds on ordinary Wi-Fi/strong 4G, a decode/render interaction-blocking task exceeds 50 ms, a target phone shows memory pressure/crashes, or the product later requires a ≤2-second cold load on slow cellular. Separately collect blinded perceived valence/arousal ratings for exact atlas anchors, intermediate cells, and transition paths, then publish a hash-bound calibration receipt with uncertainty and held-out metrics before calling any portrait mapping perceptually validated. Conduct participatory representational review and validated skin-tone auditing before describing the starter presets as adequate or exhaustive coverage. Row-strip complexity and further identities remain measured follow-ups rather than unqualified assumptions.
- Delivered as a GitHub Pages main-tracker control: Face options selects either the existing smooth continuous affect response or a session-only browser-owned 21×21/441-state traversal. Direct phone-grid input targets any cell; routes take shortest diagonal steps then cardinal steps at `0.5–20` states/second; Stop holds and Go to neutral targets exact zero. Face and Flubber consume the same frozen current-X/current-Y/phase at every node. This does not change portable settings, LSL, WebXR, native Quest, or the separate Rust-owned desktop 11×11/121-state traversal at `0.5–10` states/second.
- Delivered: an independent sixth Screen Calibration accordion in `site/screen-calibration/`, with optional fullscreen physical calibration v2, one compact launcher, and module-local assets; ten BIS shortcuts plus a searchable SVG flag-labelled country/currency hierarchy that disappears after selection; compact shared-currency country selection; a 217-entry static multi-denomination coin catalog across 37 currencies and 61 countries with official diameter/outer-span provenance and round/polygonal/scalloped shape guidance; mouse/trackpad/pen/touch square drawing and constrained SVG adjustment; display-change invalidation; v1 read compatibility; browser-local persistence; and validated read-only protocol/version/country context consumed by Experiment CSV.
- Delivered: a reversible bottom-right Windows 95 skin for the main browser app, retaining one functional DOM while restyling panels, forms, calibration, dialogs, and status feedback with a Netscape/SPSS-era presentation; browser-local persistence; pre-paint restoration; and four pinned local Kenney CC0 system-event cues used selectively, with routine interaction silent and no Microsoft asset or runtime dependency.
- Delivered as an experimental browser-headset slice: a Meta Quest WebXR selectable library with the flat Great Dictator study and eight exact-frame CEAP-360VR one-minute full-sphere excerpts, canonical Flubber rendering, stimulus-aware CSV, right-stick affect control, X reset, Y whole-session pause, local download, an explicit per-run HTTPS webhook, and a native-launcher link to the hosted page. Physical Quest sphere/orientation/controller/download/webhook qualification remains required before research use.
- Delivered as an experimental web prototype: adaptive touch/pen plus continuous active-page mouse/cursor input; speed→arousal; closure-aware coherent winding and mouse-jitter-tolerant ellipse evidence versus ≥60° dominant-corner/directional/reversal evidence→valence; 2.56-diagonal geometry; short-stroke speed/direction continuity without lifted-gap measurement; default gated live move-until-satisfied/hold feedback plus optional direct continuous response; theoretical movement guides; aspect-preserving page-wide miniature traces; live 2D mapping feedback; and append-only raw/derived/display CSV records.
- Delivered: literature-grounded `0.15/0.44/0.80 D/s` cold-start speed anchors, participant-adaptive replacement, live normalized speed display, and explicit command-not-diagnosis language with source provenance.
- Delivered: touch-first GitHub Pages smartphone viewer with one-time Affect-controller discovery, compact safe-area-aware navigation, and one shared live controller reparented into either Affect or Face. Both expose an equal split between the canonical live face-left/Flubber-right preview and a large direct 2D valence/arousal field. Face opens to that preview with a compact ≥44 px header selector that switches all six face engines through the same browser-local mode and existing renderer pair; Face options/Back retains the advanced controls without becoming a second authority. The ordered pair moves proportionally across its full legal pane span, solo Flubber reaches every edge, and exact inverse mapping preserves normalized cross-viewport placement. The viewer retains grab-existing-marker-only coordinate drag semantics, portrait/landscape phone layouts, and a Party-only local pinch/range zoom plus empty-space swipe pan for seeing more of the shared scene. The experimental movement-analysis Touch Lab remains separately available. This remains a browser experience, not a native smartphone app.
- Delivered as an experimental browser slice: user-selected Polar H10 Web Bluetooth ECG/heart-rate acquisition, bounded live waveform/metrics, explicit independent axis mapping, and reconstructable low-rate CSV context on the main desktop-browser page. The separate WebXR entrypoint now has a pre-immersive Polar connection/mapping menu, partial-axis thumbstick arbitration, and live in-world routing feedback for virtual or passthrough presentation. Current desktop Chromium/H10 acceptance has been observed for connection and live ECG, but the full soak/reconnect matrix remains required. Quest Browser support is capability-based and explicitly unqualified until a physical headset/H10 pass records chooser availability and sustained immersive streaming.
- Delivered as an experimental browser-to-browser slice: an explicit VDO.Ninja data-only broadcast of final Flubber X/Y plus typed normalized viewport-placement packets on the same live channel, relative browser-to-browser drag synchronization with locally reanchorable offsets, a broadcast-created Document Picture-in-Picture frame owner plus renewable sender wake lock, public no-code one/many-source discovery on the Meta Quest WebXR page, direct two-axis next-frame ownership, immersive-WebXR foreground scheduling with a renewable receiver wake lock and XR visibility readback, two-second stale grace with three-frame recovery hysteresis, receiver-local frame-gap plus route/RTT status, additive receiver provenance, and a locally vendored/hash-verified SDK. WebXR ignores 2D placement. Current Quest Browser direct/relay soak and congestion receipts remain required before research use.
- Delivered as the browser Ground Control module, superseding the earlier standalone anonymous settings-beacon UI: named portable-settings JSON download/load, explicit reliable public settings-snapshot broadcast/discovery/preview/apply, and named continuous FLUBBER X/Y broadcast/discovery through the existing qualified coordinate transport. Static snapshots and continuous connections remain visibly distinct, explicitly opt-in, locally validated, and backend-free.
- Delivered as experimental Ground Control collaboration: an enforced ordinary sender-or-receiver gate; an isolated named two-browser **Synch with Universe** handshake that symmetrically co-controls one Flubber; and an explicit bounded **Invite a FLUBBER** party that renders up to eight independently received public live signals beside the locally controlled host Flubber, then relays the complete bounded aggregate scene back through every existing guest channel so all connected browsers reconstruct the same participants, layout, styling, and animated geometry. A successful invitation closes radar and introduces the guest through a pure-math SVG cellular cycle whose sinusoidal daughter lobe grows from the parent field, pinches from one contour into two, then continuously resamples and morphs both loops into the live canonical parent and stream-driven guest boundaries before handoff, with an immediate reduced-motion fallback. Each separated guest remains a distinct canonical Flubber with its own incoming X/Y animation and a host-arranged, independently draggable, keyboard-movable session position. All modes remain session-only, backend-free, and subject to the existing browser foreground-scheduling limits.
- Delivered as an experimental Tauri/browser Party compatibility slice: the desktop settings WebView can host and explicitly invite a smartphone browser's ordinary live FLUBBER, or advertise the Rust-authoritative desktop Flubber for a smartphone Party host to invite. Both roles reuse the pinned data-only VDO.Ninja transport and the same bounded reciprocal aggregate, show one shared logical scene, remain inert until an exact button press, and never let remote data control Rust or LSL. Physical bidirectional phone plus Windows/macOS/Linux Tauri qualification remains required.
- Delivered as a host-built native Quest slice: official Polar BLE SDK 8.1.0 auto-discovery/reconnection, Study 6-style 130 Hz sample/stability readiness, bounded ECG waveform and the same ten web metrics, independent X/Y low/high/reverse mapping, assigned-run blocking, per-axis Touch fallback, run-only mappings, and low-rate LSL marker context without raw physiology. The application-scoped Kotlin adapter preserves the Rust LSL boundary and works with dark, video-passthrough, and Flubber-only runs. Physical worn-H10 validation on the supported Quest matrix, sustained streaming, reconnect, every metric/axis route, and stream termination remain mandatory before research use.
- Validate the touch-trace feature experimentally before describing it as an affect estimator; tune priors/thresholds only from documented study evidence and retain reconstructable raw features.
- Document iframe/module integration for researchers embedding the online tracker beside video stimuli.
- Add a stable browser integration API only after its event and privacy contract is specified.
- The mirrored-study program supersedes the former standalone follow-ups for participant-local video selection and optional desktop CSV alignment; those requirements now land only through the shared asset, event, CSV, and result-manifest contracts above.

## Later, only with explicit approval

- A separately permissioned Wayland/evdev global-input backend.
- Gamepad/HID mapping.
- Autostart.
- Signed auto-updates.
- Remote collection, accounts, or telemetry.
