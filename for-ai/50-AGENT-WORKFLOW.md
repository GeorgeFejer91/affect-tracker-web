# Mandatory agent workflow and skill routing

## First actions

Before inspecting source, planning, editing, testing, or publishing:

1. locate the Git root with `git rev-parse --show-toplevel`;
2. read the root `AGENTS.md`;
3. read every Markdown file in `for-ai/` completely and in lexical order, then
   read `for-ai/references.bib` when provenance is relevant;
4. inspect branch, remotes, recent relevant history, and `git status --short`;
5. preserve unrelated user/agent changes and identify contract mismatches;
6. inspect the relevant manifests, lockfiles, entrypoints, capabilities,
   workflows, and tests before choosing commands or dependencies; and
7. run a proportionate baseline so pre-existing failures are distinguishable
   from regressions.

Do not rely on chat history as the only authority. The charter describes the
target; the roadmap and exact test/qualification receipts describe reality.

## Active change discipline

- Preserve exactly two modes: **Setting Up the Experiment** and **Running the
  Experiment**. Setup follows the seven ordered charter sections; Run stays
  deliberately narrow.
- Qualify only Windows Tauri and desktop Chrome/Edge unless the user explicitly
  amends the charter.
- Treat strict schemas, settings/plan hashes, transient-name erasure,
  no-overwrite output, timing gaps, and safe-boundary recovery as cross-layer
  contracts rather than UI details.
- Tauri Rust owns native workspace, input, playback, scheduler, timestamps,
  persistence, and outbound LSL. Browser sampling lives in a dedicated worker
  with IndexedDB journaling. Rendering never owns the sample clock.
- Keep qualified Windows media behind the opaque, Rust-owned native-media
  boundary. Never pass arbitrary filesystem paths or native handles to/from the
  WebView; never discover a system VLC or download native runtime code in-app.
- Do not restore deleted Playground features into the active tree. Historical
  WebXR/Quest, remote, Party/Ground Control, direct Polar, face, touch,
  calibration, retro, phone, and legacy study work belongs in
  [`affect-tracker-playground`](https://github.com/GeorgeFejer91/affect-tracker-playground)
  and Git history unless a new charter explicitly reactivates a bounded slice.

## Required skills

Use the smallest applicable set and read each selected skill completely before
acting.

- Use **`tauri-rust-developer`** for Tauri/Rust, Cargo, IPC, capabilities, CSP,
  native windows, input, filesystem/persistence, libVLC/native libraries,
  packaging, or release work. Read its security, networking/FFI, persistence,
  latency, and verification references as the task requires.
- Use **`system-engineering`** for authority, contracts, lifecycle, media/data/
  control planes, recovery, observability, and qualification design.
- Use **`uncodixfy`** for any generated or changed HTML/CSS/frontend UI while
  preserving this product's accessibility and restrained instrument identity.
- Use the available browser-control skill for real browser visual/behavioral
  checks. Static inspection alone is not runtime evidence.
- Use the available multi-source web-search skill for current or uncertain
  APIs, standards, licenses, compatibility, or research claims, preferring
  official primary sources for technical decisions.

Skill names are stable; installation paths are not. Never put a machine-local
skill path into source or build configuration.

## Mandatory pause points

Stop and request explicit user direction before:

- adding `unsafe` Rust/FFI when a safe implementation is not already approved;
- enabling remote WebView content or broad filesystem, shell, process, network,
  or capability authority;
- changing Tauri major version, Rust edition, package manager, bundle identity,
  updater/release channel, or signing identity;
- destructive data/configuration migration or automatic legacy import; or
- signing, publishing installers/releases, store submission, or using
  production credentials.

The current libVLC design needs one small dynamic-library/libVLC/Win32 `unsafe`
adapter. Runtime pins, staging, validation, types, tests, and documentation may
progress safely; loading DLLs, binding symbols, registering callbacks, or
creating the child HWND must wait for explicit approval. After approval,
confine the adapter, document every invariant, test malformed/missing native
state, and never unwind a panic across FFI.

## Change workflow

1. State the user-visible outcome and affected browser, desktop, shared,
   settings, record, LSL, privacy, accessibility, packaging, and qualification
   surfaces.
2. Define one owner for each changed parameter and state transition. Keep UI
   handlers as typed adapters, not hidden business logic.
3. Specify request/response/event types, lifetimes, generations, cancellation,
   overload/error behavior, and observability before widening an IPC or native
   boundary.
4. Prefer the smallest coherent vertical slice. Avoid unrelated framework,
   dependency, permission, or formatting churn.
5. Add focused success, rejection, stale-generation, interruption, and cleanup
   tests, then run the broader applicable gates in
   [`30-TESTING-AND-RELEASE.md`](./30-TESTING-AND-RELEASE.md).
6. Verify user-visible behavior in a real browser or packaged desktop runtime
   when practical. Never infer physical/platform qualification from mocks or a
   build.
7. Update this durable brief whenever requirements, authority, contracts,
   privacy, data fields, media, LSL, platform support, or gates change.

## Provenance and dependency discipline

Record every adopted source-derived algorithm, API behavior, compatibility
decision, runtime dependency, and license boundary in
[`70-RESEARCH-PROVENANCE.md`](./70-RESEARCH-PROVENANCE.md). Put publications in
`references.bib`. State accurately whether code or binaries are copied,
vendored, dynamically linked, or independently implemented.

Pin native/runtime artifacts to exact versions and hashes, preserve notices and
source obligations, and distinguish supply-chain integrity from runtime
qualification. A successful transport call, capability response, build, or
staging step proves only that step.

## Git and handoff discipline

- Inspect status and diff before and after edits. Never discard, absorb,
  reformat, or stage unrelated work.
- Keep coherent concerns separable and stage explicit paths. Create tested
  checkpoints before risky migration or lengthy platform work when requested.
- Commit, push, merge, deploy, or publish only within the user's requested
  workflow and repository safeguards. Never rewrite shared history or bypass a
  failing check.
- After an authorized push, verify the exact remote commit and applicable CI.
  For a web-facing deployment, use a cache-bypassed check of the exact Pages
  project URL. A push or green build alone is not deployed behavior evidence.
- Before handoff, report exact checks, untested platforms, remaining blockers,
  publication/deployment identifiers, and whether the local/remote states are
  synchronized. Do not hide intentional dirt or ambiguous ownership.
