# Experimental remote Flubber coordinates

This is the normative contract for the explicit browser-to-browser Flubber transport. It is a narrow network exception to the browser's local-first default, not a physiology transport, remote-recording service, native Quest feature, or general integration API.

## Product and privacy boundary

- The desktop browser exposes **Broadcast this to VR / remote interface** and the Meta Quest WebXR page exposes **Use incoming signal**. Loading either page constructs no VDO.Ninja client and makes no connection; every page load requires a fresh button press.
- The sender offers only the final smoothed `currentX/currentY` pair immediately before desktop rendering. It never transmits ECG, RR, heart rate, a metric name or value, timestamps, participant identity, visual settings, animation phase, CSV rows, or any other study data.
- Sources are anonymous random session IDs with prefix `aft_flubber_`, shown as labels such as `Source AB12 CD34`. IDs, selections, coordinates, and remote state are not persisted. The shared discovery room `affect_tracker_flubber_v1` is intentionally public; any room listener may receive the arbitrary coordinate pair.
- VDO.Ninja provides third-party signaling/STUN/TURN infrastructure. A connection requires internet signaling even when WebRTC negotiates a local peer-to-peer path. Peers may learn each other's IP addresses; TURN relay paths may increase latency; the hosted service has no project availability guarantee.
- The official SDK v1.5.5 distribution, corresponding readable source, MPL-2.0 license, provenance, and fixed hashes are checked into `site/vendor/vdoninja/1.5.5/`. Pages load the local minified file and use no SDK CDN.

## Transport and wire contract

- `site/src/flubber-remote.js` is the browser-neutral authority for discovery, lifecycle, packet codec, unsigned sequencing, rate control, heartbeat, staleness, route diagnostics, backpressure, and injectable SDK/timer adapters.
- Use VDO.Ninja data-only publisher/viewer connections. Do not request a microphone, audio track, camera, media permission, popup, clipboard, keyboard, code entry, QR scanner, custom bridge server, or WebSocket data fallback.
- Join public room `affect_tracker_flubber_v1`. Each listener gets custom channel `flubberxyv1` with `ordered: false` and `maxRetransmits: 0`.
- Every frame is exactly 12 bytes, little-endian: `uint32 sequence`, `float32 currentX`, then `float32 currentY`. Coordinates must be finite and are clamped to `[-1,1]`. Receivers reject any other length, non-finite value, duplicate sequence, or value that is not newer under unsigned half-range ordering, including across wraparound.
- Changed values send at no more than 60 Hz. Unchanged state sends a heartbeat every 100 ms. A new listener receives the latest available pair immediately. If a channel has any queued bytes, that update is discarded for the channel; only the newest pair is eligible once its queue clears.

## Receiver ownership

- Quest discovery waits approximately 300 ms. One source is selected automatically; multiple sources produce large tap/controller-ray buttons. The selected source never changes automatically during immersive WebXR.
- Incoming mode and direct Quest Polar acquisition are mutually exclusive. Enabling incoming mode disconnects an active H10 while retaining its page-memory mappings. Remote mode owns both axes, ignores thumbstick movement and reset, and bypasses local smoothing by writing every accepted pair to both `targetX/Y` and `currentX/Y` for the next XR frame. Pause remains the study's whole-session control.
- Immersive entry is blocked while incoming mode is enabled without a valid live packet. Leaving incoming mode is explicit and releases both axes to the existing Quest controller/direct-Polar path.
- At 500 ms without a valid packet, retain the last coordinates and show `REMOTE • SIGNAL LOST — HOLDING` in the in-world HUD. A newer valid packet from the same selected source resumes automatically. Source loss never falls through to controller or Polar input.
- Desktop and Quest expose idle, discovery/selection, connecting, live, stale, direct/relay, and error information with accessible status announcements. Quest source controls require no typing and must remain usable with controller rays before immersive entry.

## Observability and qualification

- WebXR CSV adds `remote_enabled`, `remote_source`, `remote_signal_state`, `remote_sequence`, and locally measured `remote_packet_age_ms` without removing existing current/target or Polar fields. Event rows cover selection, live, stale, recovered, switched, and disconnected transitions. Per-packet logging is forbidden.
- Coordinate synchronization does not promise identical Flubber animation phase, random outline offsets, palette, size, or other visual customization.
- Unit and mock tests cover the codec, clamping/finite validation, unsigned wraparound, rate/heartbeat/backpressure policy, lifecycle, discovery/selection/switch/teardown, stale recovery, and XR input ownership. Static tests retain local-only SDK loading, exact button labels, no automatic page-load connection, no microphone/audio request, HUD warning, and additive CSV fields.
- Research qualification additionally requires current desktop Chromium plus Meta Quest Browser hardware tests: one and two sources, manual and Polar-derived desktop movement, source loss/recovery, direct and TURN routes, congestion without obsolete backlog, a two-minute direct-Wi-Fi soak, and route/RTT/stale/backpressure reporting. Software receipt latency is one receiver XR frame plus no more than one 60 Hz sender scheduling interval, excluding network latency. Missing physical results keep the feature experimental.
