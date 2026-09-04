# Affect Research agent entrypoint

Before inspecting, planning, editing, testing, or publishing this repository,
every AI agent MUST read every Markdown file in [`for-ai/`](./for-ai/) completely
and in lexical filename order.

[`for-ai/15-RESEARCH-V1-CHARTER.md`](./for-ai/15-RESEARCH-V1-CHARTER.md) is the
sole active product and architecture authority. The product has exactly two
user-visible modes, **Setting Up the Experiment** and **Running the Experiment**.
Only Tauri on Windows and the static application in current desktop Chrome and
Edge are active-v1 qualification targets.

The feature-rich WebXR/Quest, remote, Party/Ground Control, direct Polar,
Face/Photoatlas, Touch, and presentation experiments are not active source or
requirements. Their complete Git history is preserved in
[`GeorgeFejer91/affect-tracker-playground`](https://github.com/GeorgeFejer91/affect-tracker-playground)
and in this repository's immutable checkpoint/history refs. Do not restore or
reactivate them without an explicit charter change.

Windows qualified local/repository playback targets the repository-pinned,
bundled libVLC runtime. Consult [`for-ai/40-ROADMAP.md`](./for-ai/40-ROADMAP.md)
before making any implementation claim: runtime verification and a fail-closed
capability are not evidence that the native player actor or playback
qualification exists. Introducing the contained dynamic-library/libVLC/Win32
`unsafe` boundary requires explicit user approval and an audited invariant.

If implementation and the active charter disagree, stop and identify the
mismatch. Do not silently broaden the platform matrix, research data surface,
sampling or recovery semantics, native authority, accessibility obligations,
or outbound LSL contract. After reading `for-ai/`, follow any more-specific
`AGENTS.md` in the subtree being changed.
