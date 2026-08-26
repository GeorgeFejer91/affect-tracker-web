# Experimental public settings beacon

This is the normative contract for the browser-to-browser portable-settings beacon. It is an independent, static data path for recreating the exported Flubber configuration in another copy of the same site. It is not the realtime Flubber X/Y transport, a database, persistent storage, a physiology channel, or a general messaging API.

## Product boundary

- The main browser page exposes **Broadcast settings JSON** and **Find settings beacons** under **Data & settings files**. Loading the page constructs no VDO.Ninja client and makes no connection. Each role starts only after its explicit button is pressed and stops on explicit stop, page close, or refresh.
- Starting a broadcast captures exactly one normalized version-1 object from the same `settingsFromState()` → `normalizePortableSettings()` authority used by **Export settings JSON**. The snapshot contains the full portable file: input mode and rates, smoothing response, primary and advanced bindings, animation speed, pulse amplitude, disorder, base shape, four-color palette, Flubber position/size/opacity/visibility, and LSL metadata.
- A running beacon is immutable. Later UI changes do not alter its advertised snapshot; stop and start a new broadcast to advertise updated settings.
- The beacon never sends current/target X/Y, ECG, RR, heart rate, derived physiology, CSV rows, experiment data, touch trajectories, screen calibration, browser panel state, Polar mappings, Windows 95 skin state, or other browser-local preferences that are not part of the portable settings JSON.
- Receiving is discovery plus transfer, not application. The receiver validates the complete envelope and portable schema, displays the formatted JSON and source label, and applies it only after **Apply received settings** is pressed. Receipt never mutates local settings automatically.
- Applying a received snapshot has exactly the same effect and viewport constraints as importing that portable JSON file in the browser. The desktop companion remains file-import/export compatible but does not participate in this browser-only network discovery path.

## Discovery and transport

- `site/src/settings-beacon.js` owns the browser-neutral VDO lifecycle, discovery, immutable snapshot envelope, size/schema/source validation, and injectable SDK/timer adapters. `site/src/app.js` owns DOM rendering and the explicit apply gesture.
- Use the locally vendored official VDO.Ninja SDK v1.5.5 and its default data-only control channel, which is reliable and ordered. Do not use the remote-Flubber `flubberxyv1` channel, `ordered:false`, `maxRetransmits:0`, a microphone, camera, audio track, CDN, custom bridge server, project backend, or WebSocket data fallback.
- Join the public room `affect_tracker_settings_v1`. Sources use random per-session IDs with prefix `aft_settings_`, displayed as labels such as `Settings Source AB12 CD34`. Discovery waits approximately 300 ms; one source auto-selects and several sources produce large semantic buttons without typing.
- The snapshot envelope protocol is `affect-tracker-settings-beacon/v1` and has exactly these fields: `type`, `protocol`, `sourceId`, `revision`, `schemaVersion`, and `settings`. `type` is `settings-snapshot`, `revision` begins at 1, `schemaVersion` is 1, and `settings` is the complete normalized portable object. No timestamp is transmitted.
- A receiver may send an exact `settings-request` envelope containing `type`, `protocol`, and a random request ID. The publisher sends the same captured snapshot immediately when a listener's reliable channel opens and again in response to a valid request. There is no interval, heartbeat, continuous update loop, or latency/foreground mode.
- Every received snapshot must be no more than 65,536 UTF-8 JSON bytes, have the exact envelope fields and current protocol/schema, contain a valid `aft_settings_` source matching the explicitly selected beacon, and pass `normalizePortableSettings()`. Unknown, malformed, oversized, mismatched, or unsupported payloads are rejected without changing settings.

## Privacy and trust

- The discovery room is intentionally public and room-scoped. It is not a globally searchable catalog: a browser must run this site, know the fixed room, and overlap in time with an active source. Beacons disappear when their publisher leaves; VDO.Ninja provides no storage or history.
- Anybody able to enter the public room can observe or imitate a source. Validation protects the application schema, not authorship. Source labels are anonymous convenience labels, not authenticated identities; preview plus explicit application is mandatory.
- The entire portable settings JSON is public to connected listeners, including user-entered LSL stream names and source ID. The UI must warn users not to put participant identities, secrets, credentials, or sensitive study data in portable settings before broadcasting.
- VDO.Ninja supplies third-party signaling/STUN/TURN. Internet signaling is required, peers may learn IP addresses, relay infrastructure may carry the encrypted WebRTC traffic, and the hosted service has no project availability guarantee.
- The beacon is session-only and never persisted, resumed, or reconnected after reload. It adds no analytics, telemetry, project database, or server-side storage.

## Validation

- Unit tests cover complete portable-settings round-trip, exact envelopes, size/version/schema/source rejection, immutable start-time capture, request replay, one/many-source discovery, spoof rejection, teardown, and inert construction.
- Static tests require the three exact buttons, local SDK loading, no automatic start call, no `currentX/currentY` or `flubberxyv1` reference in the module, no WebSocket fallback, visible public/privacy copy, and preview-before-apply.
- Browser qualification uses two fresh tabs or devices on the public Pages build: publish customized settings, discover/select, compare the received preview byte-for-semantic-field with **Export settings JSON**, apply explicitly, verify all portable controls and Flubber appearance/placement, test source loss and restart, and confirm reload returns both roles to idle.
