# Mirrored study architecture

## Status and precedence

This file is the normative target contract for the approved mirrored study
program. It deliberately distinguishes required end-state behavior from the
features implemented today.

- Requirements written as **must** or **must not** describe the target that a
  phase has to satisfy before it can be called complete.
- They are not evidence that `StudyDefinitionV1`, the shared Rust/WASM study
  authority, the designer, durable recording, or authenticated remote control
  already exists.
- [`40-ROADMAP.md`](./40-ROADMAP.md) records delivery status. A target remains
  unimplemented or unqualified until that file and the applicable evidence are
  updated after the gates in [`30-TESTING-AND-RELEASE.md`](./30-TESTING-AND-RELEASE.md)
  pass.
- Existing behavior in [`10-PRODUCT-REQUIREMENTS.md`](./10-PRODUCT-REQUIREMENTS.md)
  and [`20-ARCHITECTURE.md`](./20-ARCHITECTURE.md) is the migration baseline.
  Do not remove a working feature merely because this target will eventually
  replace its runner or authority boundary.

## Decision and surfaces

One portable study must have semantic correspondence across three primary
surfaces:

| Primary surface | Study role | Authority placement | Platform adapters |
| --- | --- | --- | --- |
| GitHub Pages 2D | Design, preview, run locally, and optionally control an explicitly enabled desktop target | `study-core` compiled to browser WASM | Browser file picker/object URLs, IndexedDB, optional YouTube, browser input |
| Tauri/Rust desktop | Design, preview, run locally, record durably, publish LSL, and act as the sole target of authenticated remote control | Native Rust `ExperimentAuthority` over the same `study-core` | App-owned files, media protocol, global input, LSL, Tauri lifecycle |
| WebXR in the hosted browser | Run the complete participant protocol in an immersive session | The same browser WASM authority used by Pages 2D | XR input, spatial media, immersive instruction/questionnaire/break/completion panels |

The native Meta Quest Spatial SDK APK is a specialized fourth delivery form.
It retains its existing native video, controller, Polar, and LSL contracts. A
later adapter may consume the shared contracts/core, but native Quest parity
does not gate the first three-surface release and must not be inferred from
WebXR qualification.

Semantic correspondence means:

1. **Contract parity** — the same study, action, state, event, questionnaire,
   ordering, and result schemas.
2. **Behavioral parity** — the same valid protocol, seed, and counterbalance
   condition produce the same block progression, realized order, accepted
   answers, affect semantics, and completion state.
3. **Evidence parity** — native Rust and browser WASM pass identical fixtures,
   followed by packaged desktop, real-browser, and physical WebXR evidence.

It does not mean identical hardware privileges. Desktop may retain global
input, click-through overlay, durable native files, and LSL. WebXR may retain
tracked controllers and immersive placement. A capability difference must be
declared and must fail during preflight when a study requires it; it must never
silently skip or reinterpret a block.

## Authority and module boundary

Create one pure Rust `study-core` library with no Tauri, DOM, WebXR, Android,
filesystem, networking, media-player, LSL, or UI types. Compile the same source
natively for desktop and to WASM for Pages/WebXR.

The core owns:

- strict versioned contract validation and canonical protocol hashing;
- immutable published study revisions;
- run preparation and capability preflight;
- one deterministic state reducer and action catalogue;
- block/trial/section progression;
- deterministic seeded shuffle and Williams order generation;
- authority generation, revision, event sequencing, and completion status;
- privacy-safe result-manifest construction.

The established JavaScript affect, Flubber, Face, palette, and interaction
renderers remain browser/desktop presentation code. Do not rewrite those
renderers in Rust merely to share the study reducer. They consume one bounded
authoritative snapshot and own no experiment transition or research clock.

Desktop Rust is the only authority for a desktop run. Local desktop UI and an
authenticated remote request enter the same reducer only after separate
origin-specific authorization. The bundled WebView may adapt transport bytes
and render state, but it may not own secrets, grants, revision policy, study
files, recording, LSL, or native side effects.

Pages 2D and WebXR each instantiate the browser WASM authority for standalone
runs. UI adapters collect input and project returned state; they do not create
a second lifecycle. Entering or leaving immersive mode must not create a new
study identity, random order, or answer store.

## Version-1 contracts

`StudyDefinitionV1` is separate from `portable-settings-v1`. It contains:

- stable study ID, revision, title, description, canonical protocol hash, and
  pinned acquisition/visual settings;
- content-addressed media descriptors and required platform capabilities;
- reusable questionnaire definitions;
- sections, trials, and ordered typed blocks;
- sampling, reset, feedback, and completion policies; and
- one order policy plus any counterbalance definition.

Portable block kinds are:

- `instruction`;
- `video`, with purpose `introduction`, `practice`, or `stimulus`;
- `questionnaire`;
- `break`; and
- `completion`.

Portable questionnaire items are acknowledgement, single choice, multiple
choice, Likert, VAS/slider, numeric, and 2D affect response. Universal v1 also
supports one deliberately constrained `runIf` condition on a trial group. The
condition may compare one typed value, or test one multiple-choice membership,
against a required answer already committed by a questionnaire block in an
earlier fixed, unconditional section. It is evaluated once when the authority
reaches the candidate trial; the observed answer, decision, and any skip are
immutable events. Universal v1 does not include free text, arbitrary HTML,
expression trees, boolean composition, scores, scripts, loops, or explicit
jump targets.

The synchronized **Face + Flubber** comparison is an optional presentation
mode of an `instruction` block. It is not a distinct phase, stimulus, trial, or
data source. When selected, Pages 2D, desktop, and the immersive WebXR
instruction panel must render the abstract face and canonical Flubber from the
exact same `currentX`, `currentY`, and animation `phase` in one frame. It is
presentation-only and non-diagnostic, adds no input/recognition authority, and
must retain the existing reduced-motion and accessibility semantics.

`RunConfigurationV1` contains the optional pseudonymous participant code,
128-bit run seed, manually selected counterbalance condition, and observed
platform capabilities. It must not contain a filesystem path, password,
pairing secret, or raw physiology.

`RunStateV1` contains at least the application-authority generation, monotonic
revision, run phase, protocol hash, current section/trial/block, realized
order, media timeline anchor, pause/stall state, and storage/input/LSL health.

`StudyActionV1` is a closed typed set covering prepare, arm, start, pause,
resume, advance, retry block, stop/finalize, abort, settings application, and
pre-run affect calibration/reset. Each adapter must preserve its origin; a
remote action never inherits local-only authority merely because both reach
the same reducer.

`RunEventV1` is immutable and contains an event sequence, run/block identity,
host monotonic time, wall time, and one typed event/sample/question-response
payload. `ResultManifestV1` binds protocol/settings hashes, platform/build
identity, verified assets, order inputs and realization, completion/partial
status, and the digest of the adjacent CSV.

All version-1 readers must reject unknown required variants, unexpected
fields, duplicate IDs, dangling references, non-finite numbers, excessive
depth/size/counts, unsupported algorithm versions, and incompatible platform
requirements. A backward-incompatible meaning requires a new contract
version, not permissive interpretation.

## Designer contract

The shared designer flow is:

1. study details;
2. desktop/browser asset library;
3. sequence and trial builder;
4. questionnaire editor;
5. randomization and counterbalance setup;
6. compatibility and validation report; and
7. preview, publish, and JSON export.

Drafts autosave locally. Publishing creates an immutable protocol revision and
canonical hash; editing a published protocol creates a new revision. A run
always records the exact published bytes/hash it used.

Pages 2D and desktop provide the authoring interface. The ordinary 2D headset
browser may load or choose a published JSON before XR entry, but there is no
immersive protocol designer in v1. The remote browser designer may inspect the
desktop asset catalogue and arrange existing opaque asset IDs, but it has no
upload or arbitrary-path route to the desktop.

Frontend implementation must retain Affect Tracker's established identity and
follow the pinned Uncodixfy guidance: conventional labelled forms and
navigation, compact lists/tables, accessible keyboard reordering, restrained
radius/shadow use, and no generic dashboard cards, decorative gradients,
glass effects, filler prose, or icon-only ambiguity.

The small flow editor borrows only interaction structure from the official
OpenSesame and Qualtrics documentation recorded in the provenance ledger:

- a section is the visible loop/randomizer boundary;
- a trial is a fixed-order group of typed blocks, so a stimulus and its
  questionnaire cannot be separated by section-level ordering;
- the researcher may move sections, trial groups, blocks, and questionnaire
  items using labelled, keyboard-operable controls;
- each section applies fixed, seeded-shuffle, or Williams order to complete
  trial groups; and
- a later trial may have at most one answer condition sourced from an earlier
  required questionnaire response.

There is no Qualtrics-style “evenly present” counter backed by a central
service. Across-participant balancing is the explicit, reproducible Williams
condition selected at run start. There is also no OpenSesame script/run-if
expression surface: the typed condition above is the complete portable v1
branch language.

## Media and asset boundary

A portable content descriptor contains an opaque asset ID, SHA-256, byte
length, MIME/container, duration, audio presence, flat/180°/360° projection,
mono/stereo layout, and optional clip bounds. Filenames and paths are not
portable identity.

- Desktop imports through a native picker into an app-owned content-addressed
  vault. Hashing/probing runs outside the authority loop; validated staged
  bytes commit atomically. Playback uses an opaque-ID custom protocol with
  Range support and never exposes an arbitrary native path to the WebView.
- Pages/WebXR asks the user to select local files, hashes and matches them to
  descriptors, and plays verified bytes through object URLs. Native paths are
  neither available nor persisted.
- Repository-hosted assets use the same digest identity.
- YouTube is an explicit Pages 2D-only capability. A study that uses it must be
  labelled nonportable and may not receive the universal three-surface parity
  badge. It remains subject to the existing third-party disclosure.

Remote control has no `asset.upload` scope. Bulk study-record export and media
import are separate lanes and authorities; an export must never become an
arbitrary file-read route.

## Ordering and counterbalancing

Each section selects exactly one policy:

- fixed order;
- deterministic seeded shuffle using stable SHA-256 ordering; or
- Williams balanced Latin square.

The run seed is 128 random bits unless an explicit reproducible seed is
provided. Williams conditions are selected manually at run start. Odd-sized
designs use the reversed companion rows. Every run records algorithm name and
version, seed, manual condition, generated matrix hash, and exact realized
order. Native and WASM must generate byte-identical fixtures.

## Runtime, recording, and recovery

One state machine drives all three primary runners.

- Introduction video does not collect affect unless the protocol explicitly
  enables it.
- Stimulus blocks sample at 20 Hz only while playback is active. Buffering and
  pause create explicit timing gaps; missed samples are never invented.
- Questionnaires commit completed responses, not keystrokes.
- Unsupported media, storage, input, projection, or questionnaire capability
  fails preflight with an actionable reason.
- The portable `faceFlubberComparison` presentation must use shared fixtures
  so Pages, desktop, and WebXR render the canonical vector face and Flubber
  from one exact current-X/current-Y/phase snapshot without creating another
  affect authority.
- The main GitHub Pages tracker may separately offer a session-only,
  browser-affect-owned 21×21/441-state traversal from Face options, with
  shortest diagonal-then-cardinal routes and a `0.5–20` states/second rate.
  It is not part of `StudyDefinitionV1`, WebXR, native Quest, portable settings,
  or LSL. The Tauri desktop retains its distinct Rust-owned 11×11/121-state
  traversal and `0.5–10` states/second contract.

Desktop recording is an append-only `.partial.csv`, flushed at least once per
second and at every block boundary, followed by a durable atomic finalize to
the completed filename. A crash or early stop must leave an explicitly partial
record that can be exported or discarded. LSL markers may carry run, block,
media, and lifecycle identity, but questionnaire answers must not be embedded
in marker strings.

Pages and WebXR journal bounded event batches to IndexedDB. After refresh or a
crash they offer **Export Partial** or **Discard and Restart**. Universal v1
does not resume inside a stimulus. All three surfaces export the same long-form
CSV schema and adjacent `ResultManifestV1`.

## Authenticated browser-to-desktop control exception

Authenticated remote experiment control is a new, separate, explicit network
exception. It does not weaken the existing public remote-Flubber, settings
beacon, Universe, or Party contracts, and those public modes do not grant this
authority.

No remote-control client, listener, beacon, VDO SDK instance, or reconnect loop
starts until the local desktop researcher explicitly enables **Remote
Control**. The desktop remains fully usable offline when it is disabled.

### Planes and trust boundary

- A public rendezvous beacon may advertise only a nonsecret station label/ID,
  compatible protocol/profile version, availability, and supported
  authentication methods.
- It must not advertise a secret, grant, participant value, study state,
  protocol contents, asset name, or research record.
- A fresh private VDO.Ninja data-only route is established for an approved
  requester. VDO is the transport/rendezvous adapter, not identity or
  application authority.
- The packaged Tauri WebView owns only VDO signaling and bounded data-channel
  bytes. Rust owns authentication, accepted scopes, grants, BRSP validation,
  revisions, duplicate outcomes, the study reducer, public data projection,
  revocation, and audit state.
- The external browser never obtains a Tauri capability, native command name,
  arbitrary URL/path, shell/global-input operation, credential, or direct IPC
  route.

Use BRSP/1 from the exact pinned source recorded below. Reliable commands,
replaceable state, and bounded bulk record chunks are separate lanes so export
cannot delay Start, Stop, or an acknowledgement. Application state is never
released merely because WebRTC is connected; authentication, accepted scopes,
Rust grant creation, and initial state synchronization must all complete first.

BRSP/1's application proof consumes a high-entropy session key. A human
password must never be supplied directly to its HMAC proof. When OPAQUE is
used, an explicit product pre-authentication profile derives fresh,
domain-separated BRSP proof and private-transport keys from the confirmed PAKE
session. That profile must be versioned and backed by shared Rust/browser
interoperability fixtures before a conformance or hostile-network-resistance
claim is made.

### Access modes

1. **QR quick pair**
   - The desktop creates a one-time invitation locator and at least 192 random
     secret bits.
   - The secret is carried in the HTTPS companion URL fragment, expires after
     ten minutes, is consumed by the first successful controller, and is
     revoked by **Stop Remote Control**.
   - The companion validates the origin, removes the fragment from visible
     history immediately, retains it only in memory, and still requires an
     explicit Connect action.

2. **User-owned password text file**
   - The user independently selects the same UTF-8 `.txt` file on desktop and
     controller. The application never creates, copies, remembers, uploads, or
     logs that file or its password.
   - Strip only an optional UTF-8 BOM and one terminal newline, preserve all
     other content, normalize Unicode to NFC, and require 15–128 code points.
   - Use OPAQUE under [RFC 9807](https://www.rfc-editor.org/rfc/rfc9807.html),
     not password-derived HMAC. Registration occurs locally on the desktop. Pin
     Rust `opaque-ke` 4.0.1 and browser
     `@serenity-kit/opaque` 1.1.0; shared RFC and cross-library fixtures are a
     release gate.
   - Apply an embedded common-password blocklist, uniform errors, independent
     public-beacon/proof rate limits, and current
     [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)
     password guidance without composition rules.
   - The plaintext file remains an operational secret outside the protocol's
     network protection; documentation and UI must state that risk.

3. **Passwordless lab mode**
   - It is disabled by default and labelled lower assurance.
   - Every requester requires a fresh local desktop **Accept** before any grant
     or state is released.
   - The acceptance binds the exact requester, channel, nonce, authority
     generation, requested scopes, and short-lived randomly generated BRSP
     session key.
   - It creates no remembered-browser or automatic reconnect grant. This mode
     trusts the operator's requester selection plus the VDO/signaling path and
     must not be represented as hostile-network authentication.

QR and password-file login are alternative methods; neither is a prerequisite
for the other. After any successful method, derive separately labelled keys
for the BRSP application proof and private VDO transport. Secrets, OPAQUE
records, export keys, and grants stay in Rust or bounded process memory and
never enter study files, logs, URLs, local storage, or LSL.

### Grants, commands, and lease

Exactly one controller may hold a mutable grant. The local desktop can always
stop or revoke it.

The only v1 scopes are:

- `study.observe`;
- `study.control`;
- `study.design`;
- `asset.catalog.read`;
- `settings.read`;
- `settings.write`;
- `data.read`; and
- `data.export`.

There is no `asset.upload`, arbitrary file, shell, native input, or generic
administrator scope. Initial snapshots, state heartbeats, result chunks, and
acknowledgement-attached projections each require their corresponding read
scope; mutation permission alone does not imply observation permission.

Every command carries the application-authority generation, authenticated
principal, stable command ID, expected revision, run ID where applicable,
phase/block precondition, exact scope/action, and strictly typed payload. Rust
namespaces duplicate detection by `(authority generation, principal, command
ID)` and fingerprints the logical body. An identical retry returns the cached
logical outcome with current state projected separately; reuse of an ID with a
different body is rejected.

The controller lease expires after 15 seconds without a fresh valid
application control/renewal frame. Transport Ping/Pong does not renew it. Lease
loss revokes remote mutation and is visible on both endpoints, but does not
abort or pause an already running experiment. The desktop continues locally
and retains an immediately available Stop. Reconnection requires a fresh
transport epoch, authentication, grant, and snapshot; late callbacks from an
old epoch are inert.

### Data boundary

Under `data.read`, the controller may observe the full study data that the app
itself owns. Under `data.export`, it may request digest-verified partial or
final CSV/result-manifest chunks through the bounded bulk lane. The desktop or
standalone browser record remains authoritative.

This grant does not include raw external ECG or any physiological stream the
application does not record as part of its approved study record. It never
creates arbitrary filesystem visibility. Password material, native paths,
private transport identifiers, and unrelated local application state are
excluded from every projection.

## Deployment and platform boundary

The VDO.Ninja adapter uses external signaling, STUN, and possibly TURN. It
requires an Internet path even when ICE selects a direct same-Wi-Fi data route.
It is not true offline-LAN control. The UI must disclose peer-address exposure,
relay processing/latency, service availability, and the fact that requested
TURN is not route evidence without readback.

The profile is data-only and requests no camera, microphone, audio, or browser
media capture. Serve companion assets from GitHub Pages, vendor reviewed SDK
bytes locally, and keep Tauri production CSP/capabilities restricted to the
exact signaling/TURN origins, bundled window label, and typed bridge.

Release support is gated independently for Windows WebView2, macOS WKWebView,
and Linux WebKitGTK. Probe the exact packaged WebRTC runtime. If a supported
Linux WebKitGTK build cannot provide the required data channels, package a
narrowly scoped, pinned Chromium transport helper with its own lifecycle,
protocol, CSP/permissions, artifact, and qualification record; do not weaken
authentication or silently claim WebKitGTK support.

## Observability

Both endpoints expose, without secrets or participant identifiers:

- remote feature enabled/disabled and connection state;
- authentication method and outcome class;
- accepted scopes, controller identity label, grant expiry, and revocation;
- authority generation, current revision, run/phase/block, and last applied
  command outcome;
- state freshness, direct/relay/unknown route, RTT, queue pressure, reconnect,
  and transport epoch;
- storage, input, media, and LSL health; and
- export progress, byte counts, digest result, and partial/final status.

Do not log passwords, OPAQUE messages or derived keys, QR fragments, grants,
full route IDs, SDP/ICE data, native paths, questionnaire contents, raw high-rate
state, or arbitrary invalid payloads. Audit records use allowlisted action,
scope, result code, correlation ID, revision, and duration fields.

## Validation and release claim

No universal or remote-control claim is valid until all applicable evidence
passes:

- Native and WASM produce byte-identical protocol hashes, shuffled orders,
  Williams matrices, action outcomes, revisions, and event fixtures.
- The same study/seed/condition produces a reconstructable equivalent run on
  desktop, Pages 2D, and physical WebXR, including optional Face + Flubber
  instruction presentation.
- Media hashes, codec/projection capability, malformed definitions, duplicate
  IDs, invalid references, storage quota/interruption, and crash/partial
  recovery are exercised.
- QR expiry/consumption, wrong password files, OPAQUE RFC/cross-library
  interoperability, reflection/replay, proof throttling, passwordless reject,
  stale generations, denied scopes, revoked controllers, and absence of
  pre-authentication data are tested.
- Applied-but-acknowledgement-lost retries reuse the same command ID without
  duplicating Start, Stop, advance, answer, or export effects.
- Saturated record export does not delay reliable control; queue limits and
  digest failures fail closed.
- Direct and independently observed forced-TURN routes, phone/browser
  backgrounding, network changes, sleep/wake, WebView destruction, reconnect,
  and remote loss during an active stimulus are exercised.
- Packaged Windows, macOS, and Linux targets and physical Quest 2/3/3S WebXR
  are separate evidence rows; browser emulation and same-machine tests do not
  substitute for them.
- Record connection-to-control-ready and command-gesture-to-applied p50, p95,
  p99, worst, sample count, route, and build/runtime identity. Initial
  regression ceilings are 15 seconds to ready and 2 seconds to acknowledgement;
  these ceilings are not latency guarantees.

## Explicit v1 exclusions

Universal v1 excludes a project account/backend, cloud identity system,
remote media upload, true offline-LAN controller, multiple simultaneous
controllers, arbitrary native paths/commands, raw physiological transfer,
arbitrary or nested questionnaire branching, scoring, free text, scripted
conditions, backward jumps, mid-stimulus resume, and an immersive XR protocol
designer.

The existing native Quest APK remains outside the first release gate. Existing
public Flubber/settings/Universe/Party modes remain experimental independent
protocols and do not become authenticated study controllers through this work.

## Reference pins and transfer boundary

| Reference | Exact pin | License | Adopted lesson | Rejected overreach |
| --- | --- | --- | --- | --- |
| [Browser Remote Sync Protocol](https://github.com/GeorgeFejer91/browser-remote-sync-protocol) | `e6a5eef86d4b3c7422ace08706df5deb82338808` | MIT | BRSP/1 typed application actions, one target authority, reliable control versus replaceable state, explicit activation, scopes, revisions, dedupe, leases, VDO adapter, and evidence tiers | Generic remote desktop/input injection, room labels as identity, or similarity as conformance |
| [Tauri Rust Developer Skill](https://github.com/GeorgeFejer91/tauri-rust-developer-skill) | `3accda94db2fe6becd851a0f81498a69b0a8c591` | MIT | Pure Rust core plus thin adapters, Rust-side validation, least-privilege WebViews, staged vertical slices, durable-file and packaged-platform gates | Generic IPC, broad capabilities, remote privileged content, or architecture as runtime evidence |
| [Uncodixfy](https://github.com/cyxzdev/uncodixfy) | `e0e028058b5259debdd94b78147c6d6c77bf7da2` | MIT | Human-designed, conventional, restrained, accessible UI composition | Copying a visual brand, decorative redesign, or adding a runtime dependency |
| [ZuRadio](https://github.com/GeorgeFejer91/zuradio) | `770106ed5b1f8e6e87ad4a984ae0e50fb5487e78` | MIT | Static companion distribution, one Rust authority, private routes, scoped grants, state/timeline reconciliation, integrity staging, and installed-browser qualification | Password-derived discovery/HMAC, whole-file browser uploads, browser-owned authoritative media clock, or its custom wire schema |

These references supply architecture and validation guidance. This contract
change copies no application implementation. Any future source reuse must be
recorded with exact files, notices, and license handling in
[`70-RESEARCH-PROVENANCE.md`](./70-RESEARCH-PROVENANCE.md). The vendored
VDO.Ninja SDK remains separately governed by MPL-2.0 and its existing notice.

## Staged next slices

Implement in this order and update status only after evidence lands:

1. preserve the validated Face/matrix baseline and synchronize this contract;
2. add `study-core`, schemas, hashing, reducer, ordering, and native/WASM
   fixtures;
3. deliver the desktop asset/designer/runner/recorder vertical slice;
4. migrate Pages 2D to the same WASM authority and IndexedDB record contract;
5. migrate WebXR to the same full participant lifecycle;
6. add the authenticated read-only desktop observer, then scoped mutation and
   bounded record export; and
7. qualify each packaged operating system and physical headset/browser matrix.

Do not begin by widening Tauri permissions or networking. The first executable
remote slice is authenticated `study.observe` with a sanitized snapshot; add
mutation only after that path proves the Rust ownership boundary.
