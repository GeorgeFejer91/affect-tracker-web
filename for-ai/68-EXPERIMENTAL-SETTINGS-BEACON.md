# Experimental Ground Control settings beacon

This is the normative contract for Ground Control's browser-to-browser portable-settings snapshot. It is the static half of the fifth Ground Control module, not the continuous FLUBBER X/Y transport, a database, persistent storage, physiology channel, or general messaging API.

## Product boundary

- Ground Control exposes **Broadcast JSON** and **Scan JSON** beside named local JSON download/load and the separate live FLUBBER actions. Loading the page constructs no VDO.Ninja client and makes no connection. Each role begins only after its explicit button is pressed and stops on explicit stop, page close, or refresh.
- JSON broadcast participates in the ordinary Ground Control sender role; JSON scan/preview participates in the ordinary receiver role. They may coexist with an ordinary mode in the same direction but never with the opposite direction, Universe, or Party. Local JSON download/load never enters a network role.
- A non-empty operator-entered Ground Control name determines the safe local filename and the public beacon name. The name is browser-local, must not identify a participant, and is encoded as a bounded public discovery token plus a fresh random per-session suffix because VDO.Ninja room listings do not expose custom labels before peer connection.
- Starting a broadcast captures exactly one normalized portable version-1 object from the same `settingsFromState()` authority used by local JSON download. The running snapshot is immutable; later UI changes require stop and restart.
- The snapshot contains the complete portable settings object, including LSL metadata. It never includes current/target X/Y, physiology, CSV rows, experiment data, touch trajectories, screen calibration, Windows 95 theme state, Polar mappings, or other browser-local preferences.
- Receiving is discovery, validation, and preview—not automatic application. The radar displays one or many named sources and validates the received envelope and portable schema. Successful validation closes the radar automatically, then the persistent Ground Control panel shows the snapshot name/shape/time and applies it only after **Apply received settings** is pressed.

## Discovery and transport

- `site/src/ground-control.js` owns the browser-neutral static VDO lifecycle, public-name normalization, filename generation, source discovery, immutable bounded snapshot envelope, reliable custom channel, validation, and injectable SDK boundary. `site/src/app.js` owns rendering and the separate Apply gesture.
- Use the locally vendored official VDO.Ninja SDK v1.5.5. Join public room `affect_tracker_settings_v1`; source IDs use prefix `aft_settings_`, a bounded sanitized name token, and a fresh 12-hex-character suffix. Use custom channel `affectsettingsv1` with `ordered:true`; do not use the live `flubberxyv1` channel or its zero-retry policy.
- The snapshot protocol is `affect-tracker-portable-settings`, version 1. The envelope contains the normalized public name, an ISO creation time, and the complete normalized portable settings object. It is limited to 65,536 UTF-8 bytes and accepted only after exact protocol/version, finite timestamp, and portable-schema validation.
- A publisher sends the same frozen payload when a selected listener's reliable channel opens. There is no heartbeat, continuous update, coordinate frame, foreground helper, or automatic reconnection.

## Privacy and trust

- The fixed discovery room is intentionally public while roles overlap. Anyone who knows the room may observe or imitate a source; schema validation does not authenticate authorship. Preview plus explicit Apply is mandatory.
- The public name and complete portable settings JSON are visible to connected listeners. Users must not place participant identities, secrets, credentials, or sensitive study data in the name or portable settings; this warning must explicitly mention LSL metadata.
- VDO.Ninja supplies signaling and STUN/TURN. Internet signaling is required, peers may learn IP addresses, relay infrastructure may carry encrypted WebRTC traffic, and the hosted service has no project availability guarantee.
- The beacon is session-only and never persisted, resumed, or started after reload. It adds no analytics, telemetry, project backend, or server-side storage.

## Validation

- Unit tests cover name/filename normalization, named random source IDs, the exact bounded versioned envelope, portable-settings validation, immutable start-time capture, reliable channel options, one/many-source discovery, explicit selection, and teardown.
- Static tests require the complete Ground Control hierarchy, local SDK loading, zero automatic connection, separate static/live semantics, animated but reduced-motion-safe SVG states, named radar controls, success dismissal with persistent preview-before-apply, and public privacy disclosure.
- Browser qualification uses two fresh page instances against the real VDO.Ninja path: publish a named snapshot, discover that name before connection, select it, validate the exact received settings, and keep Apply separate. Reload must return both roles to idle.
