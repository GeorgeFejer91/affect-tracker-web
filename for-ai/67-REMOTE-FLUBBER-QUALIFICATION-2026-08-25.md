# Remote Flubber qualification — 2026-08-25

## Decision

Commit `dd43646` is the current qualification candidate. It passes the complete automated suite and fresh attended desktop Chrome direct-path, forced-TURN, high-change backpressure, explicit source-reselection, foreground-loss, and 130 Hz synthetic-ECG checks. It also adds one bounded, same-gesture full Polar stream reset when the H10 acknowledges startup but sends no ECG packet, and makes Stop synchronously quiesce the publisher before signaling teardown completes. Commit `5b60e3e` supplies the preceding two-minute direct and forced-TURN scheduler soaks; commits `ac10c62` and `b66aa1d` supply earlier foreground and transport-engine evidence. Historical results are not relabelled as exact-commit receipts.

The data-only transport is suitable for continued headset testing, but `dd43646` is **not yet fully physically qualified for research use**. One Quest was detected during this follow-up but ADB remained unauthorized, so no current-build immersive direct or forced-TURN run could be executed. The H10 had been removed, so the new browser recovery path was verified with deterministic/mock hardware contracts and synthetic ECG, not a worn sensor.

An earlier physical direct-path receipt on commit `8d8c813` remains useful evidence because the subsequent runtime changes added explicit forced-TURN qualification, foreground lifecycle/recovery, ideal-deadline sender scheduling, teardown hardening, and cache revisioning without changing the wire codec. It is not treated as a receipt for `dd43646` or for a Quest relay route.

## Test subjects

- Desktop: Google Chrome 151 on Windows.
- Headset receipt: Meta Quest 3S, Android 14, Meta Quest Browser `150.0.0.39.30.1038228660` with Chromium 150.0.7871.181.
- Input for the current session: the explicit deterministic 130 Hz ECG replay fixture. It used the normal local metric, mapping, final smoothing, and `currentX/currentY` broadcast path. No live Polar device was claimed or required.
- Transport: locally vendored VDO.Ninja SDK 1.5.5, data-only `flubberxyv1` channel, 12-byte coordinate packets, unordered with zero retransmits, WebSocket data fallback disabled.

## Automated gate

`node --test` passed 166 of 166 tests on `dd43646`. Coverage includes the codec, finite/clamp validation, unsigned sequence wraparound, ideal-deadline scheduling under slightly early animation frames, the long-run 60 Hz cap, 100 ms heartbeat, newest-state backpressure, discovery, switching, delayed-signaling teardown quiescence, two-second staleness grace, three-frame recovery, WebXR ownership, 130 Hz replay fixture, the one-chooser/two-setup Polar recovery path, local SDK loading, foreground-helper warning/recovery surfaces, and the forced-TURN option. The vendored SDK/source/license hashes also passed. After the qualification record was published as `ad0fbad`, both the GitHub Pages deployment and complete desktop companion workflow succeeded. A fresh public Chrome load returned `./src/app.js?v=remote-11`, showed `Broadcast off` with the exact opt-in action, stayed disconnected on page load, and produced no console warning or error.

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

## Current-build reliability follow-up (`dd43646`)

This follow-up exercised the exact `remote-11` browser modules in attended Chrome 151 before publication. The deterministic 130 Hz ECG replay stayed on the normal metric/mapping/smoothing path; for the highest-change forced-TURN interval, visible 2D-grid movement deliberately kept both final coordinates changing so the measurement represented the 60 Hz wire ceiling rather than the intentional 100 ms unchanged-state heartbeat.

| Case | Stable interval/result | Route and RTT | Receiver timing and stability |
| --- | --- | --- | --- |
| Direct changing-state check | 45.082 s; 2,694 new frames | Independently reported Direct P2P; ending RTT 1 ms | 59.76 frames/s; rolling p95 18 ms; retained maximum 65 ms; 0 loss warnings |
| Forced TURN changing-state stress | 20.026 s; 1,175 new frames | Independently reported TURN relay; interval RTT 34 ms | 58.67 frames/s; rolling p95 19 ms; 0 loss warnings |
| Forced TURN second checkpoint | 1,810 cumulative frames | TURN relay; RTT 36 ms | Rolling p95 20 ms; retained maximum 324 ms; 0 loss warnings |
| Forced TURN steady mapped input | Final coordinates eventually unchanged | TURN relay; RTT 36–39 ms | Cadence intentionally fell toward the 100 ms heartbeat and rolling p95 approached 125 ms; this is protocol behavior, not measured relay latency |
| Latest-state backpressure | Sender reported 206 discarded offers while values continued changing | TURN relay readback retained | Receiver stayed live with no loss warning; no obsolete queue was replayed |

The ordinary-background receiver diagnostic found an important limit. When the receiving tab was background-controlled and the source stopped, visible stale/closed presentation was delayed by approximately 9.8–11.2 seconds, and already dispatched data-channel tasks continued appearing at about 10 frames/s. A screen wake lock does not exempt an ordinary hidden tab from browser scheduling. Because the 12-byte protocol intentionally has no timestamp, the receiver cannot distinguish an old browser-queued packet from a newly delivered packet. Adding a coordinate delay buffer would increase latency without fixing that scheduler ownership problem.

The supported foreground check left the receiver visible. After Stop, `REMOTE • SIGNAL LOST — HOLDING` was visible by the 3.127-second observation checkpoint; that duration includes a fixed 2.5-second wait, approximately 0.2 seconds of tab switching, and screen-capture overhead, so it is a bound on the observed checkpoint rather than an exact stale-transition measurement. The final coordinates remained held and did not fall through to controller or Polar input. The new teardown regression independently proves that Stop enters `stopping`, cancels heartbeat/change scheduling, closes the coordinate channel, clears public state, and emits no further packet while a deliberately delayed SDK disconnect remains pending.

Restarting the broadcaster deliberately produced a new anonymous source ID. The stale receiver did not auto-switch; it exposed the new large tap target, and an explicit selection returned it to live TURN relay at 33 ms RTT without typing. This validates the no-surprise source-ownership rule, but it is not the same as same-source channel recovery; that path remains covered by unit/injected tests and still requires a current physical immersive receipt.

The browser-side H10 recovery change was also checked without claiming physical ECG. A synthetic session displayed live 130 Hz ECG and advancing samples without console errors. Mocked Web Bluetooth then proved one chooser invocation, two GATT/PMD setups, complete teardown between attempts, and successful live state when the first acknowledged setup produced no packet. Automatic page-load or range-loss reconnection remains prohibited. A worn-H10 repeat is still mandatory.

Captured receipts:

- [Synthetic 130 Hz ECG replay](./evidence/remote-flubber-2026-08-25/synthetic-replay-live.png)
- [Direct P2P route and 18 ms rolling p95](./evidence/remote-flubber-2026-08-25/direct-route.png)
- [Forced-TURN changing-state stress](./evidence/remote-flubber-2026-08-25/turn-live-stress.png)
- [Sender TURN route and latest-state backpressure](./evidence/remote-flubber-2026-08-25/sender-backpressure-route.png)
- [Foreground loss holding the final coordinates](./evidence/remote-flubber-2026-08-25/foreground-loss-hold.png)
- [Explicit source reselection and recovery](./evidence/remote-flubber-2026-08-25/explicit-source-reselection.png)

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

Repeat on deployed `dd43646` after the Quest reconnects and USB debugging is authorized:

1. Start deterministic replay and one desktop publisher.
2. Connect Meta Quest Browser, enter immersive WebXR, and retain at least two minutes of direct-path streaming.
3. Record route, RTT, frame/gap diagnostics, stale transitions, backpressure drops, and XR visibility.
4. Repeat with `?remote-force-turn=1` on both endpoints and require independent `TURN relay` readback.
5. Repeat same-source loss/recovery while immersed and confirm the in-world hold warning, held coordinates, and automatic three-frame recovery without flapping.
6. With a worn H10 and no competing Polar application or tab, repeat connect, the acknowledged-but-silent setup recovery case where reproducible, at least two minutes of live ECG, explicit disconnect, and reconnect.

## Cleanup

All public receivers and broadcasters used for the direct, TURN, foreground-loss, and reselection checks were explicitly stopped; synthetic replay was disconnected; controlled test tabs were closed; and the user's normal Chrome process remained running. The exact local Python server process was verified before stopping, and port 4173 was verified closed. The temporary Python GUI-control dependency directory was removed. The headset appeared only as unauthorized, so no headset command or browser launch was sent and no ADB forward was created. Six privacy-safe diagnostic screenshots were committed under `for-ai/evidence/remote-flubber-2026-08-25/`; no physiology or Bluetooth identifier appears in them.
