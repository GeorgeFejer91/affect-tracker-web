# Affect Tracker VR agent instructions

Read the repository root `AGENTS.md` and every Markdown file in `for-ai/` before changing this subtree.

- This subtree owns only `io.github.georgefejer91.affecttracker.vr`; do not modify Rusty Quest or QuestIonAble File Manager to make it build.
- Keep video bytes in the SAF media plane and the versioned JSON in the low-rate control plane.
- Keep the app's Spatial SDK frame loop singular. Do not add a competing OpenXR session.
- Preserve JavaScript/Kotlin Flubber golden-vector parity and desktop LSL channel order.
- Keep Polar H10 BLE, permission, reconnection, readiness, bounded metrics, and UI in the application-scoped Kotlin adapter. Rust remains the in-process LSL boundary. Never persist raw physiology or add it to the regular LSL state schema.
- Run source/unit/static gates before a headset. Real Touch input and presentation require attended physical-device evidence; ADB synthetic input does not qualify.
- Never add all-files storage, cloud/telemetry, cleartext HTTP, direct camera-frame access, hand tracking, DRM, or projection heuristics without a deliberate product-contract change. Preserve the existing compositor-owned passthrough contract.
