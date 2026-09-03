# Remote study browser foundation

This directory contains the browser-safe foundations and the bounded QR
quick-pair BRSP/1 slice for the desktop-study controller described in
`for-ai/25-MIRRORED-STUDY-ARCHITECTURE.md`. It is intentionally not the final
remote-control security architecture.

## Implemented boundary

- `contracts.js` defines the strict minimal public beacon, the eight exact
  scopes, the exact shared-core phase vocabulary, positive safe-integer
  authority generations, a closed typed study-command profile, and a redacted
  grant projection. Stop and finalize remain distinct core transitions.
- `invitation.js` creates and parses HTTPS QR invitations with a 192-bit
  fragment secret, with HTTP allowed only for the pinned loopback
  `study-remote.html` development page. It removes the fragment through
  `history.replaceState` and provides an in-memory ten-minute/single-use store
  that expires on either its wall-clock or monotonic deadline.
- `password-policy.js` implements the exact password-file text normalization,
  an embedded common-password screen, and independent bounded beacon/proof
  attempt limiters.
- `opaque-adapter.js` defines the adapter seam for RFC 9807 login and
  domain-separated BRSP/private-transport keys. It performs no password HMAC
  and implements no PAKE or cryptographic primitive.
- `controller-lease.js` models one controller with a target-owned 15-second
  semantic lease. Either its wall-clock or monotonic deadline expires it, so a
  wall-clock rollback cannot extend authority and a sleep/forward jump still
  fails closed. Transport Ping/Pong cannot renew it.
- `command-dedupe.js` namespaces stable command IDs by authority generation and
  authenticated principal, fingerprints the logical body, coalesces concurrent
  identical retries, and rejects the same ID with another body.
- `lane-buffers.js` keeps reliable control, replaceable state, committed-record,
  and bulk export queues separately bounded so saturated export cannot occupy
  the control queue.
- `transport-guards.js` leaves the pinned BRSP/VDO sources unchanged while
  bounding target ingress before their asynchronous queues. At most 16 raw
  control frames/128 KiB may await BRSP receive processing and at most eight
  uncached semantic commands/64 KiB may await serialized application. Cached
  same-body retries use the raw bound and release without repeating native
  effects. Discovery listings are capped at 64 items, the source map at 16,
  and pre-authentication peer records at four, with strict UTF-8 byte limits.
  VDO route-quality reads are single-flight and a 1.5-second SDK timeout
  disables further quality polling for that session.
- `quick-pair.js` is the public-controller module. It derives independently
  labelled BRSP-proof and private-VDO keys from the 192-bit QR secret with
  HKDF-SHA-256, requests only observe/control, accepts only projected returned
  run state, and sends typed reliable study commands.
- `desktop-quick-pair-target.js` is desktop-only. It requires an active native
  study run before constructing a transport, projects an allowlisted state,
  maps the QR slice's exact study controls to the native typed-action bridge,
  enforces generation/revision/phase/block preconditions, and owns the
  single-controller lease. Each invitation is immutably bound to its native
  authority generation, run ID, and protocol hash; the first state remains
  withheld until a fresh native read matches that binding, the invitation is
  consumed, and the lease is accepted.
- `controller-app.js` and `desktop-quick-pair-ui.js` provide the explicit
  Connect/Enable surfaces. Importing or constructing their underlying classes
  remains network-inert; only those user actions call `start()`.

The underlying modules are inert. Importing or constructing them starts no SDK,
signaling, WebRTC route, reconnect loop, storage, or native operation. The
controller route removes the invitation fragment before enabling Connect.
The lazily loaded VDO.Ninja SDK executes in the same browser realm as the
controller; clearing browser history limits accidental bearer retention but is
not an isolation boundary from that pinned transport dependency.

`contracts.js` is an Affect Tracker application profile, not a replacement for
the BRSP wire envelope. Integration must carry its validated command semantics
inside BRSP/1 `command`/`applied` exchange, retain BRSP sender epoch and per-lane
sequence checks, and bind the authenticated BRSP principal to `principalId`.
Callers must not send this profile directly as an ad-hoc wire protocol.

## Current QR-slice boundary

The clean BRSP/1 source and VDO.Ninja data-only adapter are vendored at exact
commit `e6a5eef86d4b3c7422ace08706df5deb82338808`. This slice has no public beacon:
the invitation locator directly names a fresh private session, and the bearer
secret is consumed by the first mutually proved controller. It grants only
`study.observe` and `study.control`; no asset upload or generic native bridge is
exposed. The public controller import graph contains no Tauri command names or
native paths.

BRSP proof and scope enforcement currently execute in the bundled WebView.
Rust still revalidates the mapped typed action through the native study
authority. This is useful vertical-slice evidence, not the final boundary where
Rust owns authentication, grants, BRSP validation, dedupe, and revocation.

## Required integration work

The password-file path must be wired to Rust `opaque-ke` 4.0.1 and browser
`@serenity-kit/opaque` 1.1.0 with RFC 9807 and cross-library fixtures. The
adapter seam here is not a cryptographic implementation and must not be used to
claim OPAQUE interoperability or hostile-network resistance. Authentication
failures exposed to the peer must remain uniform.

Desktop Rust remains the authority for authentication records, accepted
scopes, grants, revisions, reducers, dedupe outcomes, revocation, audit state,
record access, and export digests. The external browser never receives a Tauri
command name, native path, shell/global-input operation, asset upload route, or
arbitrary native call.

OPAQUE password-file login, passwordless local approval, public beacon
discovery, reconnection grants, record access/export, and a Rust-owned BRSP
adapter are not implemented in this QR slice. VDO.Ninja still depends on
Internet signaling/STUN and may use TURN; this is not an offline-LAN controller.

Real completion additionally requires packaged WebView2/WKWebView/WebKitGTK,
physical browser, direct and independently observed TURN, background/reconnect,
acknowledgement-loss, and saturated-export qualification. These pure modules
are deterministic foundation evidence only.
