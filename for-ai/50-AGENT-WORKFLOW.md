# Mandatory agent workflow and skill routing

## First actions for every future agent

Before inspecting source, planning changes, editing, testing, or publishing:

1. locate the Git root with `git rev-parse --show-toplevel`;
2. read the root `AGENTS.md`;
3. read **every** Markdown file in `for-ai/` completely, in lexical filename order, then inspect `for-ai/references.bib` when research provenance is relevant;
4. inspect `git status --short`, the active branch, remotes, and recent relevant history;
5. preserve unrelated user or agent changes and identify any contract/implementation mismatch before proceeding;
6. inspect the relevant manifests, lockfiles, entry points, configuration, capabilities, tests, and workflows before choosing commands or dependencies; and
7. run a proportionate baseline check when feasible so pre-existing failures are distinguishable from regressions.

Do not rely on chat history as the only source of truth. This directory is the durable handoff between people and future agents.

## Required skill routing

Use the smallest applicable skill set and read each selected skill's complete instructions before acting.

- For any Tauri, Rust, `src-tauri`, Cargo, IPC, capability, permission, CSP, native window, tray, overlay, global-input, sidecar, persistence, packaging, or desktop-release task, use **`tauri-rust-developer`**. The mirrored-study architecture is pinned to the MIT-licensed skill source at [`3accda94db2fe6becd851a0f81498a69b0a8c591`](https://github.com/GeorgeFejer91/tauri-rust-developer-skill/tree/3accda94db2fe6becd851a0f81498a69b0a8c591); update the pin only through an explicit source/provenance and behavior review.
- For authority, contract, module/adapter, data/control/media-plane, observability, or validation design, use **`system-engineering`** and keep concise entrypoint routing synchronized with the detailed normative file.
- For authenticated browser/phone-to-desktop study observation or control, BRSP envelopes, VDO.Ninja data-only transport, scopes, revisions, duplicate outcomes, leases, reconnects, or remote qualification, use **`browser-remote-sync-protocol`**. Implement against the MIT-licensed exact source [`e6a5eef86d4b3c7422ace08706df5deb82338808`](https://github.com/GeorgeFejer91/browser-remote-sync-protocol/tree/e6a5eef86d4b3c7422ace08706df5deb82338808); architecture similarity is not conformance.
- For any new or changed HTML/CSS/frontend study, designer, controller, or questionnaire UI, use **`uncodixfy`** while preserving Affect Tracker's established accessible identity. The guidance source is MIT-licensed and pinned at [`e0e028058b5259debdd94b78147c6d6c77bf7da2`](https://github.com/cyxzdev/uncodixfy/tree/e0e028058b5259debdd94b78147c6d6c77bf7da2); it is design guidance, not an application runtime dependency.
- For real browser interaction or visual/behavioral verification of the GitHub Pages app, use the available browser-control skill and test the actual page rather than only static code.
- For GitHub inspection, commits, branches, Actions, releases, or publishing, use the available GitHub skill and follow its branch/status/diff safeguards.
- For current or uncertain external facts, APIs, standards, compatibility, or research evidence, use the available multi-source web-search skill and prefer official primary sources for technical decisions.
- Use specialized document/media skills only when the requested artifact requires them; do not add tools or dependencies merely because they are available.

The local skill name is stable; its installation path is not. Never hard-code a machine-specific Codex skill path into application code or build configuration.

## How to approach changes

1. Restate the requested user-visible outcome and determine whether it affects web, desktop, shared behavior, settings, logging/LSL, privacy, accessibility, packaging, or release semantics.
2. Check the parity contract. Implement every affected delivery form when behavior is shared, or record a deliberate platform-specific exception.
3. Define cross-layer ownership before coding: Rust owns native authority and durable validation; frontends own presentation and transient UI; research sampling must not depend on rendering cadence.
4. Preserve UI-to-code module correspondence and keep each top-level product surface in an owning project folder with its code and assets. Frontend and backend modularity must correspond: identify each surface's named protocol/controller, owned state and data, privacy boundary, and matching narrow named backend/native adapter when privileged authority is required. Keep the common shell limited to navigation, shared rendering, and documented precedence; do not place unrelated module protocols in one catch-all handler or expose generic native authority. Do not invent a backend counterpart for a browser-only module.
5. Prefer the smallest coherent vertical change. Avoid unrelated framework migrations, dependency updates, broad permissions, or refactors.
6. Add or update focused tests, then run the broader applicable gates from `30-TESTING-AND-RELEASE.md`.
7. Verify user-visible web or desktop behavior in a real runtime when practical. Never claim a platform or package was tested when it was not.
8. Update documentation, this durable brief, and release notes when behavior or constraints change.

## Maintain this directory continuously

Update `for-ai/` in the same change whenever:

- the user adds, removes, or clarifies a project requirement;
- an architectural or privacy/security decision changes;
- cross-delivery parity gains an exception;
- a portable settings, CSV, marker, LSL, or IPC schema changes;
- supported platforms, release gates, or known limitations change; or
- testing/debugging reveals a reusable lesson that would prevent future mistakes.

Record durable lessons, not temporary narration. Avoid dates, transient branch names, machine-specific output paths, one-off command logs, or speculative ideas unless they are genuinely relevant project metadata or an approved roadmap item. Consolidate duplicate or stale guidance instead of appending contradictions forever.

Before merging any source-derived algorithm, API behavior, or compatibility decision, add its citation and exact adopted idea to `70-RESEARCH-PROVENANCE.md`; add publications to `references.bib`. Record license and code-reuse status. Reviewing an example is not code reuse, and independent implementation must be stated accurately.

## Git hygiene and regular checkpoints

- Inspect status and diff before and after edits. Never discard, overwrite, stage, or reformat unrelated work.
- Keep one coherent concern per commit where practical. Stage explicit paths; do not blindly stage the entire worktree.
- Create a tested checkpoint after each meaningful, coherent milestone and before risky migrations or lengthy platform work.
- Completing any validated in-scope change—not only a new feature—carries standing project authorization to create a tested coherent commit and push it to the canonical GitHub repository as soon as practical, so the public remote never lags behind finished local work. This includes source, assets, configuration, tests, and `for-ai/` documentation. Do not stop at a local commit or ask again for routine push permission. Skip publication only when the user explicitly requests local-only or no-push work, validation fails, credentials or CI are unavailable, or ownership/scope is too ambiguous to stage safely; report the exact blocker instead of silently leaving completed work local.
- After every push, wait for the standard GitHub Pages workflow for that exact commit and verify the relevant Actions result. For every web-facing change, open the public project-path URL with cache bypass and verify the deployed behavior or asset. For repository-only changes, verify that the commit is public and Pages remains healthy without claiming that non-site files are web-served. Do not call work complete merely because the push succeeded.
- Follow the repository's normal branch/PR policy and verify relevant GitHub Actions after pushing. Do not bypass failing checks or rewrite shared history.
- Before handoff, consolidate the working tree: commit and push completed in-scope work; leave unrelated work untouched; clearly report any intentional uncommitted files, failing checks, or unpushed commits.
- A clean working tree is a goal, not permission to absorb someone else's changes. If ownership or intent is ambiguous, stop and ask rather than hiding the dirt in an unrelated commit.
- Do not push merely because a read-only review or diagnosis was requested. The standing publication rule applies to completed implementation work, not inspection-only tasks or unrelated local changes.

## Completion report

Every implementation handoff should state:

- the outcome and affected web/desktop/shared layers;
- important design or security decisions;
- exact verification performed and its result;
- untested platforms or remaining limitations;
- commit/release/deployment identifiers when publication was authorized; and
- whether the local and remote working states are synchronized and clean.
