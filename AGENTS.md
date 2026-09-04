# Affect Tracker Research agent entrypoint

Before inspecting, planning, editing, testing, or publishing this repository,
every AI agent MUST read all Markdown files in [`for-ai/`](./for-ai/) in lexical
order.

[`for-ai/15-RESEARCH-V1-CHARTER.md`](./for-ai/15-RESEARCH-V1-CHARTER.md) is the
sole active product and architecture authority. The active product has exactly
two user-visible modes, **Setting Up the Experiment** and **Running the
Experiment**, and is qualified only for Tauri on Windows and the static web
application in current desktop Google Chrome and Microsoft Edge.

The other documents in `for-ai/` refine that charter or preserve historical
implementation and evidence. Documents marked **Frozen Playground/history**
are not active requirements, release gates, or permission to widen the product.
In particular, [`for-ai/25-MIRRORED-STUDY-ARCHITECTURE.md`](./for-ai/25-MIRRORED-STUDY-ARCHITECTURE.md)
is a superseded historical target. Use [`for-ai/40-ROADMAP.md`](./for-ai/40-ROADMAP.md)
to distinguish the approved target from implementation that has actually
landed.

If implementation and the active charter disagree, stop, identify the mismatch,
and either implement the charter deliberately or propose an explicit charter
change. Do not silently broaden supported platforms, reactivate frozen features,
change research sampling or record semantics, weaken privacy/accessibility, or
change outbound LSL semantics.

After reading `for-ai/`, follow any more-specific `AGENTS.md` in the subtree
being changed.
