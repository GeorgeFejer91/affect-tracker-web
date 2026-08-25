# Remote Flubber qualification — 2026-08-25

## Decision

Commit `5b60e3e` is deployed and passes the complete automated suite plus attended desktop direct-path and forced-TURN scheduler soaks. Commit `ac10c62` supplies the preceding foreground-loss/recovery run, and commit `b66aa1d` supplies the preceding transport-engine discovery, loss/recovery, foreground-scheduling, and backpressure preflights; those results remain useful architectural evidence but are not relabelled as exact-commit receipts for `5b60e3e`. The data-only transport is suitable for continued headset testing, but the current commit is **not yet fully physically qualified for research use**: Quest USB transport authorization was unavailable before a fresh immersive direct run and a forced-TURN run could be repeated on the headset.

An earlier physical direct-path receipt on commit `8d8c813` remains useful evidence because the subsequent runtime changes added explicit forced-TURN qualification, foreground lifecycle/recovery, ideal-deadline sender scheduling, and cache revisioning without changing the wire codec. It is not treated as a receipt for `5b60e3e` or for a Quest relay route.

## Test subjects

- Desktop: Google Chrome 151 on Windows.
- Headset receipt: Meta Quest 3S, Android 14, Meta Quest Browser `150.0.0.39.30.1038228660` with Chromium 150.0.7871.181.
- Input for the current session: the explicit deterministic 130 Hz ECG replay fixture. It used the normal local metric, mapping, final smoothing, and `currentX/currentY` broadcast path. No live Polar device was claimed or required.
- Transport: locally vendored VDO.Ninja SDK 1.5.5, data-only `flubberxyv1` channel, 12-byte coordinate packets, unordered with zero retransmits, WebSocket data fallback disabled.

## Automated gate

`node --test` passed 164 of 164 tests on `5b60e3e`. Coverage includes the codec, finite/clamp validation, unsigned sequence wraparound, ideal-deadline scheduling under slightly early animation frames, the long-run 60 Hz cap, 100 ms heartbeat, newest-state backpressure, discovery, switching, teardown, two-second staleness grace, three-frame recovery, WebXR ownership, 130 Hz replay fixture, local SDK loading, foreground-helper warning/recovery surfaces, and the forced-TURN option. The vendored SDK/source/license hashes also passed. Both the Pages test/deploy workflow and the complete web/desktop plus three-platform Rust matrix finished successfully for the exact commit.

## Preceding deployed desktop transport preflight (`b66aa1d`)

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

## Foreground recovery follow-up

Commit `ac10c62` adds a user-gesture-owned recovery path for the measured Chrome failure mode where the broadcast-created floating Flubber is closed or displaced. The original **Broadcast this to VR / remote interface** action remains one-click; a separate **Restore low-latency foreground mode** action appears only while a live broadcast has lost its foreground helper or wake lock.

An attended Chrome 151 run used the deterministic 130 Hz replay, one publisher, and one same-PC direct receiver through the normal VDO data channel:

- Before helper loss: 1,304 received frames, 34 ms rolling p95 gap, 47 ms maximum gap, 1 ms RTT, and zero loss warnings.
- Closing the helper immediately produced `LOW-LATENCY FOREGROUND MODE CLOSED`, exposed the restore action, retained the same public source, and kept the receiver live. During the degraded interval the rolling p95 rose to 112 ms and the maximum to 117 ms, with zero stale/loss warnings.
- Restoring foreground mode did not restart or rename the source. The receiver advanced to 1,905 frames, returned to a 36 ms rolling p95 gap, reported a 141 ms retained maximum gap and 0–1 ms RTT, and still had zero loss warnings. Sender readback again showed the foreground Flubber window and wake lock.
- The public Pages build was then verified in Chrome with cache revision `remote-7`, the new restore control present, and `Broadcast off` on a fresh load.

These are same-PC transport and lifecycle receipts, not physical Quest latency evidence.

## Sender scheduler latency follow-up (`5b60e3e`)

The prior changed-value limiter measured every animation frame only against the previous send. A browser presenting frames slightly earlier than the nominal 16.67 ms interval could therefore reject one frame and wait until the next, reducing a nominal 60 Hz source toward 30 Hz. Commit `5b60e3e` instead advances an ideal 60 Hz deadline, permits at most 5 ms of bounded early tolerance, enforces at least 11.67 ms between changed-value sends, and preserves the long-run 60 Hz cap. Heartbeats and latest-state backpressure semantics are unchanged.

Fresh attended Chrome 151 runs used the deterministic 130 Hz ECG replay with both axes actively changing through `heart_rate` and `ecg_local_power`, normal final smoothing, and independent VDO diagnostics at both endpoints:

| Case | Stable interval | Effective receive cadence | Route and RTT | Receiver gaps and loss |
| --- | --- | --- | --- | --- |
| Direct | 136.160 s; 8,131 received frames | 59.72 frames/s | Direct P2P; 0–1 ms same-host RTT | 18 ms rolling p95; 0 loss warnings |
| Forced TURN | 137.268 s; 8,027 received frames | 58.48 frames/s | Both endpoints independently reported TURN relay; 35–38 ms RTT, ending at 37 ms | 20 ms rolling p95; 69 ms maximum; 0 loss warnings |

The direct run's retained maximum-gap field included an earlier deliberate foreground experiment, so it is intentionally omitted instead of being presented as soak-local evidence. Both endpoint consoles were clean. These are same-PC route, cadence, and stability measurements; they demonstrate that the sender no longer halves slightly-early 60 Hz animation frames, but they are not a physical Quest latency receipt.

The GitHub Pages workflow deployed the exact commit successfully. A fresh public Chrome load returned cache revision `remote-8`, loaded the VDO SDK and app script locally, exposed the broadcast control, remained at `Broadcast off`, and made no connection on page load.

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

Repeat on deployed `5b60e3e` after the Quest reconnects and USB debugging is authorized:

1. Start deterministic replay and one desktop publisher.
2. Connect Meta Quest Browser, enter immersive WebXR, and retain at least two minutes of direct-path streaming.
3. Record route, RTT, frame/gap diagnostics, stale transitions, backpressure drops, and XR visibility.
4. Repeat with `?remote-force-turn=1` on both endpoints and require independent `TURN relay` readback.
5. Repeat source loss/recovery while immersed and confirm the in-world hold warning and automatic recovery.

## Cleanup

All public receiver and broadcaster sessions used for the current preflight, foreground-recovery follow-up, and scheduler soaks were stopped, and the deterministic replay was disconnected. The isolated run-owned Chrome process from the earlier preflight was terminated after an injected lifecycle state left one sender UI unresponsive; its debug port closed, the temporary local server was stopped, and the user's normal Chrome process remained running. The headset appeared only as unauthorized, so no headset command was sent and no ADB forward was created. Raw screenshots were not committed.
