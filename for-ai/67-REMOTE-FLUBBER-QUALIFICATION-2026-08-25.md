# Remote Flubber qualification — 2026-08-25

## Decision

Commit `b66aa1d` is deployed and passes the complete automated suite plus attended desktop direct/relay, discovery, loss/recovery, foreground-scheduling, and backpressure preflights. The data-only transport is suitable for continued headset testing, but the current commit is **not yet fully physically qualified for research use**: the Quest USB/ADB transport went offline before a fresh immersive direct run and a forced-TURN run could be repeated on the headset.

An earlier physical direct-path receipt on commit `8d8c813` remains useful evidence because the subsequent runtime change only added explicit forced-TURN qualification plumbing and cache revisioning. It is not treated as a receipt for `b66aa1d` or for a Quest relay route.

## Test subjects

- Desktop: Google Chrome 151 on Windows.
- Headset receipt: Meta Quest 3S, Android 14, Meta Quest Browser `150.0.0.39.30.1038228660` with Chromium 150.0.7871.181.
- Input for the current session: the explicit deterministic 130 Hz ECG replay fixture. It used the normal local metric, mapping, final smoothing, and `currentX/currentY` broadcast path. No live Polar device was claimed or required.
- Transport: locally vendored VDO.Ninja SDK 1.5.5, data-only `flubberxyv1` channel, 12-byte coordinate packets, unordered with zero retransmits, WebSocket data fallback disabled.

## Automated gate

`node --test` passed 162 of 162 tests on `b66aa1d`. Coverage includes the codec, finite/clamp validation, unsigned sequence wraparound, 60 Hz cap, 100 ms heartbeat, newest-state backpressure, discovery, switching, teardown, two-second staleness grace, three-frame recovery, WebXR ownership, 130 Hz replay fixture, local SDK loading, and the forced-TURN option. The vendored SDK/source/license hashes also passed.

## Current deployed desktop preflight

These runs used separate visible sender and receiver windows in one isolated desktop Chrome profile. They verify the deployed application and network route but do not replace headset evidence.

| Case | Duration/result | Route evidence | Cadence and stability |
| --- | --- | --- | --- |
| Direct | More than two minutes; 4,540 received frames at the recorded checkpoint | Direct P2P; 0–1 ms same-host RTT | 33 ms p95 gap; 67 ms maximum gap; 0 loss warnings |
| Forced TURN | More than two minutes; 4,838 received frames at the recorded checkpoint | Both endpoints independently reported TURN relay; 34–36 ms RTT | 35 ms p95 gap; 151 ms maximum gap; 0 loss warnings |
| Two sources | Two public sources discovered | Two large tap-only source choices appeared; the selected source reported TURN relay | Listener ownership moved 1→0 and 0→1 during a pre-XR switch |
| Brief suppression | 500 ms injected send suppression | Same source and channel retained | No additional loss warning |
| Long suppression | Four effective interruptions longer than two seconds | Same source and channel retained | One hold warning per interruption; final coordinates held; recovery followed three consecutive frames without live/lost flapping |
| Backpressure | Nonzero `bufferedAmount` injected into the live sender | Same relayed channel retained | 14 updates discarded; receiver stayed live; clearing pressure sent current state without draining obsolete history |

The direct same-host RTT is not representative of a headset path. The relay RTT is a real VDO/TURN path measurement, but both endpoints remained on the same PC.

## Foreground and background scheduling

- With the sender-created Document Picture-in-Picture window and wake lock active, freezing the main sender page did not make the receiver stale. The foreground frame owner continued driving final smoothing and transmission.
- Opening a second publisher displaced the first publisher's single browser-owned Picture-in-Picture window. That backgrounded source fell to roughly one update per second, observed as approximately 1,056 ms p95 receiver gaps. The two-second grace kept it live rather than flipping between live and lost.
- Therefore the supported lowest-latency workflow remains one active publisher with its floating Flubber window left open, plus an immersive WebXR receiver. A normal Quest browser panel can still be deprioritized by Meta OS; the web application cannot override OS focus ownership.

## Earlier physical Quest direct receipt

The attended direct-path run on `8d8c813` used the same 130 Hz replay-to-final-coordinate path and produced:

- Direct P2P route evidence with 6–13 ms RTT.
- 130.15 Hz replay ingest.
- Approximately 37.6 sender/receiver frames per second in the final 20-second observation window.
- Receiver p95 gap 85 ms and maximum gap 187 ms.
- No stale/loss transition during the retained soak; a deliberate source stop produced one hold warning rather than repeated flapping.

This evidence supports the architecture but does not close the current commit's physical gate.

## Latency interpretation

The wire deliberately carries no timestamp, so one-way motion-to-photon latency cannot be measured from application packets without changing the privacy-minimal protocol. Recorded RTT is the defensible network-latency measurement. The sender adds at most one 60 Hz scheduling interval when it is foregrounded, and the receiver applies an accepted coordinate pair on its next XR frame without a second smoothing or jitter buffer. Those scheduling bounds are design properties, not a substitute for a synchronized optical one-way measurement.

## Remaining physical gate

Repeat on deployed `b66aa1d` after the Quest reconnects:

1. Start deterministic replay and one desktop publisher.
2. Connect Meta Quest Browser, enter immersive WebXR, and retain at least two minutes of direct-path streaming.
3. Record route, RTT, frame/gap diagnostics, stale transitions, backpressure drops, and XR visibility.
4. Repeat with `?remote-force-turn=1` on both endpoints and require independent `TURN relay` readback.
5. Repeat source loss/recovery while immersed and confirm the in-world hold warning and automatic recovery.

## Cleanup

All public receiver and broadcaster sessions used for the current preflight were stopped. The isolated run-owned Chrome process was terminated after an injected lifecycle state left one sender UI unresponsive; its debug port closed, and the user's normal Chrome process remained running. No device was present in `adb devices`, no ADB forward remained visible, raw screenshots were not committed, and the repository was clean before this report was added.
