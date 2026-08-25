# Remote Flubber qualification — 2026-08-25

## Decision

Commit `05ac5b7` is the current qualification candidate. It passes 168 automated tests and fresh attended desktop Chrome direct-path replay, more than two minutes of stability, explicit-close grace, held-coordinate stale, explicit source reselection, and final disconnected-source cleanup checks. It retains the no-buffer coordinate path from `ec5972b` and adds one bounded same-device recovery for a post-readiness silent ECG stream. Commit `dd43646` supplies the preceding direct-path, forced-TURN, high-change backpressure, teardown, and browser-H10 startup-recovery evidence; commit `5b60e3e` supplies the earlier two-minute direct and forced-TURN scheduler soaks; commits `ac10c62` and `b66aa1d` supply earlier foreground and transport-engine evidence. Historical results are not relabelled as exact-commit receipts.

The data-only transport is suitable for continued headset testing, but `05ac5b7` is **not yet fully physically qualified for research use**. One Quest was detected during this follow-up but ADB remained unauthorized, so no current-build immersive direct or forced-TURN run could be executed. The H10 had been removed, so the new browser recovery path was verified with deterministic/mock hardware contracts and synthetic ECG, not a worn sensor.

An earlier physical direct-path receipt on commit `8d8c813` remains useful evidence because the subsequent runtime changes added explicit forced-TURN qualification, foreground lifecycle/recovery, ideal-deadline sender scheduling, teardown and channel-close hardening, browser-ECG liveness recovery, and cache revisioning without changing the wire codec. It is not treated as a receipt for `05ac5b7` or for a Quest relay route.

## Test subjects

- Desktop: Google Chrome 151 on Windows.
- Headset receipt: Meta Quest 3S, Android 14, Meta Quest Browser `150.0.0.39.30.1038228660` with Chromium 150.0.7871.181.
- Input for the current session: the explicit deterministic 130 Hz ECG replay fixture. It used the normal local metric, mapping, final smoothing, and `currentX/currentY` broadcast path. No live Polar device was claimed or required.
- Transport: locally vendored VDO.Ninja SDK 1.5.5, data-only `flubberxyv1` channel, 12-byte coordinate packets, unordered with zero retransmits, WebSocket data fallback disabled.

## Automated gate

`node --test` passed 168 of 168 tests on `05ac5b7`. Coverage includes the codec, finite/clamp validation, unsigned sequence wraparound, ideal-deadline scheduling under slightly early animation frames, the long-run 60 Hz cap, 100 ms heartbeat, newest-state backpressure, discovery, disconnected-source cleanup after explicit switching, delayed-signaling teardown quiescence, two-second staleness grace, three-frame recovery, WebXR ownership, 130 Hz replay fixture, both bounded Polar startup recovery and post-readiness silent-stream recovery, local SDK loading, foreground-helper warning/recovery surfaces, and the forced-TURN option. The new live-ECG test proves one chooser, exactly one same-device restart after five seconds without a valid packet, fresh first-frame proof, watchdog rearming, and fail-closed behavior after the second silent interval. The vendored SDK/source/license hashes also passed.

The earlier 166-test `dd43646` gate, its successful Pages/desktop workflows, and the public `remote-11` activation receipt remain historical evidence for that exact build. Deployment evidence for `05ac5b7` and cache revision `remote-13` is recorded below after publication.

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

## Channel-close stabilization follow-up (`remote-12`)

A fresh attended desktop Chrome forced-TURN run used the deterministic 130 Hz replay and the normal mapped/smoothed X/Y path. The selected replacement source accumulated 7,759 accepted frames at the final grace capture, with a 20 ms rolling p95 gap, 220 ms retained maximum gap, independently reported TURN relay at 36 ms RTT in the preceding live capture, and zero loss warnings before the deliberate stop. This was approximately a two-minute foreground receiver interval; it remains same-PC transport evidence, not a Quest receipt.

The deliberate Stop exposed a contract mismatch in `remote-11`: the receiver's silent-packet path had a two-second grace, but an explicit data-channel close called stale immediately and the loss state was already visible at the 1.591-second operator capture. That edge could produce the reported live/lost flash during a brief WebRTC channel repair.

Revision `remote-12` records the disconnected edge but leaves visible state governed by the same last-valid-packet deadline. The real-Chrome repeat remained live with held coordinates and zero loss warnings at the 1.580-second capture, then showed exactly one loss warning at the 3.426-second capture. These checkpoints include tab switching and screenshot overhead, so they bound the observed presentation rather than estimating an exact transition instant. Accepted coordinates remain immediate; no coordinate queue or latency buffer was added. A new unit test additionally repairs the same selected source with a replacement channel one millisecond before the two-second deadline and proves no stale transition or HUD flash. The complete Node suite passes 167 of 167 tests.

Restarting the publisher generated a new anonymous source as required. The stale receiver exposed the large new source button, retained the old selected source, and moved only after the explicit tap. It then reported the new source live through TURN at 36–37 ms RTT with zero warnings.

Both GitHub workflows for documentation commit `a31702b` completed successfully: Pages run `32813930270` and the complete desktop companion run `32813930257`. At 2026-08-25T05:48:05Z, uncached requests to the public project-path deployment returned `./src/app.js?v=remote-12` and `./src/webxr-study.js?v=remote-12`, both exact opt-in labels, and local vendored SDK references. The deployed receiver module binds `useIncomingSignal` only to the explicit `webxr-remote-use` click action. This is a deployment/static-activation receipt; no VDO session was opened for the check.

Privacy-safe captures:

- [`remote-12` explicit replacement-source recovery](./evidence/remote-flubber-2026-08-25/remote12-explicit-recovery.png)
- [`remote-12` explicit-close grace capture](./evidence/remote-flubber-2026-08-25/remote12-channel-close-grace.png)
- [`remote-12` one stable held-coordinate warning](./evidence/remote-flubber-2026-08-25/remote12-channel-close-stale.png)

The preferred typed Quest File Manager provider is installed and hash-pinned, but its public routes cover exact-device status, files, APKs, and kiosk control rather than arbitrary Meta Quest Browser URL navigation. Its sanitized device listing currently reports the attached headset as USB `unauthorized`. No serial-scoped ADB, browser launch, capture, performance setting, or other headset mutation was attempted. Current-build immersive direct/TURN receipts and the worn-H10 matrix therefore remain open.

## Current `remote-13` reliability follow-up (`05ac5b7`)

The attended Chrome 151 run used the deterministic 130 Hz replay with Heart rate assigned to X and Local ECG power assigned to Y, normal desktop smoothing, one foreground publisher, and one visible same-PC WebXR receiver. No coordinate buffer or additional receiver smoothing was introduced.

- During the more-than-two-minute Direct P2P interval, the receiver reached 7,631 accepted frames at the recorded soak checkpoint, with an 18 ms rolling p95 gap, 27 ms maximum gap, 0–1 ms RTT, and zero loss warnings. Before the later deliberate stop it reached 18,700 cumulative frames, retained the 18 ms p95, reported a 34 ms maximum, and still had no unintended loss warning.
- Approximately 1.35 seconds after the deliberate publisher stop, the receiver still displayed the final coordinates as live/held within the two-second grace. The later observation showed exactly one stable held-coordinate loss warning rather than repeated live/lost presentation. Operator switching and capture overhead prevent treating these screenshots as an exact transition-time measurement.
- Restarting created a new anonymous source, as required. The receiver did not switch automatically; after the explicit large-button selection, the new source accumulated 2,302 frames with an 18 ms p95, 100 ms retained maximum, 0–1 ms RTT, and zero warnings in its new-source diagnostics.

That longer run exposed a discovery-only issue: VDO signaling could leave the disconnected old source label visible after the user had explicitly moved to the restarted publisher. The final `05ac5b7` receiver now preserves the old source throughout its full same-source repair grace, then removes that known-dead label only after an explicit different-source selection. A hard reload of the exact final worktree repeated stop, held-state grace, replacement discovery, and explicit selection. The old label disappeared, while the selected replacement reached 277 frames at the capture with an 18 ms p95 gap, 30 ms maximum, 1 ms Direct P2P RTT, and zero loss warnings. Unit coverage also proves that healthy prior sources are not removed during an ordinary switch and that late events from the old source cannot affect the new one.

The browser H10 adapter now covers the separate failure mode in which GATT remains nominal after readiness but valid ECG notifications stop. Every valid packet rearms a five-second watchdog. One silent interval releases Polar axis ownership, clears bounded metric/window state, tears down listeners, notifications, GATT, and PMD, and restarts the same browser-selected device once without reopening the chooser. Recovered ownership requires a new valid first frame. A second silent interval in the same explicit connection session fails closed with `PMD_LIVE_ECG_STALLED`; actual range loss still never reconnects automatically. This adds no packet, coordinate, or smoothing delay. The behavior is automated-contract and synthetic-replay evidence only until repeated with a worn H10.

The two-minute transport interval preceded only the selection-list cleanup described above; the final-code hard-reload check and unit tests cover that narrow change. These results are same-PC Chrome route, cadence, lifecycle, and stability evidence—not an immersive Quest or physical-H10 receipt.

Both exact-runtime workflows completed successfully: desktop companion run `32817876132` and GitHub Pages run `32817876146`. At 2026-08-25T06:49:19Z, uncached public requests returned `./src/app.js?v=remote-13` and `./src/webxr-study.js?v=remote-13`, both exact opt-in labels, and only the locally vendored VDO SDK references. Static inspection confirmed that publisher and receiver startup remain bound to their respective click handlers and that the incoming function has no page-load call site.

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

Repeat on deployed `05ac5b7` after the Quest reconnects and USB debugging is authorized:

1. Start deterministic replay and one desktop publisher.
2. Connect Meta Quest Browser, enter immersive WebXR, and retain at least two minutes of direct-path streaming.
3. Record route, RTT, frame/gap diagnostics, stale transitions, backpressure drops, and XR visibility.
4. Repeat with `?remote-force-turn=1` on both endpoints and require independent `TURN relay` readback.
5. Repeat same-source loss/recovery while immersed and confirm the in-world hold warning, held coordinates, and automatic three-frame recovery without flapping.
6. With a worn H10 and no competing Polar application or tab, repeat connect, the acknowledged-but-silent setup recovery case where reproducible, at least two minutes of live ECG, explicit disconnect, and reconnect.

## Cleanup

All public receivers and broadcasters used for the direct, TURN, foreground-loss, and reselection checks were explicitly stopped; the final synthetic replay page was reloaded after broadcast teardown to release the mock source; and the user's normal Chrome process remained running. The exact local Python server was stopped, ports 8000, 4173, and 9222 were verified closed, and the temporary attended-control screenshots were removed. The headset still appeared only as unauthorized, so no headset command or browser launch was sent and zero ADB forwards existed at cleanup. Nine privacy-safe diagnostic screenshots remain committed under `for-ai/evidence/remote-flubber-2026-08-25/`; no physiology, Bluetooth identifier, or Quest serial appears in them.
