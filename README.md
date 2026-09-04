# Affect Research

Affect Research is a local-first instrument for continuous valence–arousal ratings during complete video stimuli. The active product deliberately has two modes: **Setting Up the Experiment** and **Running the Experiment**.

This repository is the focused Research lineage. The complete feature-rich application and its full Git history are preserved in [`GeorgeFejer91/affect-tracker-playground`](https://github.com/GeorgeFejer91/affect-tracker-playground), with the frozen application deployed at <https://GeorgeFejer91.github.io/affect-tracker-playground/>.

## Reproducibility checkpoint

The immutable feature-rich checkpoint is commit [`34a137d9d6d0f33a8e5ebef6c04bf8bc0219fd86`](https://github.com/GeorgeFejer91/affect-tracker-playground/commit/34a137d9d6d0f33a8e5ebef6c04bf8bc0219fd86), referenced in both repositories by:

- branch [`checkpoint/feature-rich-2026-09-03`](https://github.com/GeorgeFejer91/affect-tracker-playground/tree/checkpoint/feature-rich-2026-09-03)
- annotated tag [`checkpoint-2026-09-03-feature-rich`](https://github.com/GeorgeFejer91/affect-tracker-playground/tree/checkpoint-2026-09-03-feature-rich)

It records 471 passing tests and the exact [Pages CI run](https://github.com/GeorgeFejer91/affect-tracker-research/actions/runs/33746889634) and [Desktop CI run](https://github.com/GeorgeFejer91/affect-tracker-research/actions/runs/33746889623). It is a reproducibility checkpoint, not a research-ready release or a physical-device qualification claim.

Playground `main` has exactly one checkpoint descendant: repository-relocation commit [`5d1f5fa3d30f93b3f2797a74b02e1f336acb7bc3`](https://github.com/GeorgeFejer91/affect-tracker-playground/commit/5d1f5fa3d30f93b3f2797a74b02e1f336acb7bc3). The complete later source lineage remains at [`history/post-checkpoint-source-main`](https://github.com/GeorgeFejer91/affect-tracker-playground/tree/history/post-checkpoint-source-main), exact commit [`5df1e5365aacd2e59cd36347d752b003f1af432d`](https://github.com/GeorgeFejer91/affect-tracker-playground/commit/5df1e5365aacd2e59cd36347d752b003f1af432d). Neither descendant changes the checkpoint branch or tag.

## Research v1

The approved target is an ordered, keyboard-accessible Setup instrument with a persistent live preview:

1. Workspace & Libraries
2. Experiment
3. Stimuli & Counterbalancer
4. Controller / Input Device
5. Visual Feedback
6. Advanced
7. Review & Start

One condition column containing every video is the supported **one-hat** workflow. Multiple columns form stratified pools. The target assignment uses deterministic `balanced-v1` allocation with Williams counterbalancing by default and cyclic rotation as the alternative.

The target Run mode freezes settings, participant code, assignment, bindings, and overlay geometry. Sampling is independent of rendering, never invents catch-up rows, and records explicit timing gaps. Outputs are create-new attempts containing a frozen settings snapshot, resolved assignment plan, semantic events, manifest, and selected CSV and/or TSV rating tables. Interrupted runs retain authoritative recovery evidence and restart a partially viewed video from the beginning.

The supported qualification targets for v1 are Windows Tauri and visible desktop Chrome/Edge. LSL is a Tauri-only capability. Experimental YouTube sources remain explicitly unverified and outside research qualification.

The durable product contract is [`for-ai/15-RESEARCH-V1-CHARTER.md`](./for-ai/15-RESEARCH-V1-CHARTER.md). Historical architecture documents are retained as history but are not active Research requirements.

### Current implementation status

Branch `research/video-protocol-v1` contains the implementation candidate: isolated Research-only Pages and desktop build boundaries, strict browser/Rust contracts and canonical hashes, deterministic assignment logic, the two-mode UI, browser worker sampling and recovery persistence, and narrow Tauri workspace/run modules. Automated tests and builds are implementation evidence only. They do not establish scheduler performance, crash durability, LSL interoperability, accessibility, media compatibility, or physical workflow qualification.

The candidate remains under development. The exact open software and qualification gates are tracked in [`for-ai/40-ROADMAP.md`](./for-ai/40-ROADMAP.md) and [`for-ai/30-TESTING-AND-RELEASE.md`](./for-ai/30-TESTING-AND-RELEASE.md). The Pages deployment target is <https://GeorgeFejer91.github.io/affect-tracker-research/>.

## Local development

Requirements: Node.js 22.12 or newer, pnpm 11, and the Rust toolchain for desktop work.

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm serve
```

Open <http://localhost:8000/> for the Chromium surface.

Build and verify the isolated Pages artifact with:

```powershell
pnpm build:pages
```

For the Windows desktop surface:

```powershell
pnpm desktop:dev
```

Build the unsigned internal alpha installer with:

```powershell
pnpm desktop:bundle
```

The displayed product version is `0.4.0-alpha.1`; it must not be described as stable or research-ready until the automated, timing, recovery, LSL, accessibility, and physical workflow gates in the charter pass.

## CI, deployment, and internal packaging

- Pull requests and pushes to `research/video-protocol-v1` validate the isolated Pages artifact and Windows Tauri candidate. They do not deploy a public site.
- A passing push to `main` deploys only the verified Research Pages artifact to the Research project URL.
- Windows CI runs the Research tests/build plus Rust format, check, test, and clippy gates before creating an unsigned internal installer artifact.
- The packaging workflow is manual-only. It repeats those gates and uploads an unsigned `0.4.0-alpha.1` workflow artifact; it has no tag trigger and creates no GitHub Release.

Signing, auto-updates, store submission, stable installers, and any research-ready claim remain out of scope until separately authorized and qualified.

## Privacy and storage

Names are transient and are reduced before persistence to a two-grapheme participant code: the last grapheme of the first name followed by the first grapheme of the last name. The selected workspace contains curated `stimuli/`, `settings/`, `outputs/`, and `recovery/` directories. Browser state uses the isolated `affect-research/v1` namespace. The desktop retains bundle ID `io.github.georgefejer91.affecttracker` for upgrade continuity while keeping new Research data under its dedicated namespace; legacy application data is never imported automatically.

## License

[BSD 3-Clause](./LICENSE)
