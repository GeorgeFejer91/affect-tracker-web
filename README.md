# Affect Tracker: Pages + Desktop + WebXR + Native Quest

The repository currently contains four Affect Tracker delivery surfaces inspired by [AffectTracker](https://github.com/afourcade/AffectTracker):

- A static, self-contained GitHub Pages 2D application for browser studies, including five selectable locally packaged Face + Flubber main-stage presentations with a canonical SVG fallback, with no CDN or project backend.
- An offline Tauri v2/Rust desktop companion with the same selectable local face/Flubber preview and fallback, click-to-capture global key/mouse/wheel bindings, a click-through always-on-top overlay, and always-on local Lab Streaming Layer output.
- An experimental hosted WebXR participant runner for Meta Quest Browser.
- A specialized native Meta Quest Spatial SDK player under [`vr/`](./vr/) that loads a local video/session manifest, renders a transparent movable Flubber, accepts Touch-controller input, and publishes same-LAN LSL.

All surfaces use the same valence/arousal mappings. Web and desktop share the JavaScript Flubber and face-engine adapters directly; native Quest uses an allocation-bounded Flubber port checked against JavaScript golden vectors.

Live site: <https://GeorgeFejer91.github.io/affect-tracker-web/>

Experimental Meta Quest WebXR study: <https://GeorgeFejer91.github.io/affect-tracker-web/webxr.html>

Desktop source: [`desktop/`](./desktop/) and [`src-tauri/`](./src-tauri/)

## Approved mirrored-study target

Pages 2D, Tauri/Rust desktop, and WebXR are now the three primary study surfaces. The approved target is semantic—not pixel or hardware—correspondence: the same versioned study definition, Rust/WASM reducer, block progression, questionnaires, randomization, affect meaning, and result contract, with explicit platform adapters. The native Quest APK remains a specialized fourth surface and will be adapted later without blocking the first three-way release.

An implementation-first vertical slice now exists, but it is not a three-surface release or qualification claim. The pure Rust `study-core` owns strict `StudyDefinitionV1` validation and publishing, canonical hashing, seeded/Williams ordering, constrained typed trial conditions, lifecycle reduction, events, and result contracts; the same core is checked in as browser WASM. The ordinary 2D Study Studio authors and publishes revisions through a compact Uncodixfy-led form interface. Its deliberately small OpenSesame/Qualtrics-inspired flow surface moves complete trial groups, offers fixed/seeded-shuffle/Williams section order, and permits one typed forward condition from an earlier required answer—without scripts, nested logic, backward jumps, scoring, or a central balancing service. The Pages participant runner uses the WASM authority, local content-digest bindings, portable questionnaires, and a bounded IndexedDB journal with retained partial/final evidence, isolated corrupt-record warnings, and explicit downloads. Tauri exposes the native Rust authority, an app-owned content-addressed asset vault, durable partial/final long-form CSV recording, strict result-manifest finalization, and a privacy-bounded LSL lifecycle projection. Preparing a native run freshly hashes and measures every required vault object and freezes that path-free verification snapshot for the final manifest. WebXR's separately selected **Portable Study** mode runs authority-driven instruction, questionnaire, break, completion, and hash-verified `contentAsset` video blocks, including flat/180°/360° and supported stereo layouts; the legacy single-stimulus mode remains available separately.

The browser-to-desktop controller is presently a deliberately narrow QR quick-pair slice: one-time 192-bit fragment invitations, the pinned BRSP/1 and VDO.Ninja adapters, `study.observe`/`study.control`, returned native state, typed commands, and a 15-second lease. Its BRSP proof and scope gate still run in the bundled desktop WebView before Rust revalidates each typed action, so it is not the final security architecture. OPAQUE password-file and passwordless modes, Rust-owned authentication/grants/audit/dedupe, the remaining scopes and record export, a native picker/player and opaque-ID Range-serving path, trusted codec/duration/audio/projection/stereo probing, native partial-record recovery UI, packaged-platform qualification, and physical Quest WebXR qualification remain open. The vault currently accepts only allowlisted caller-supplied MIME/container declarations and records them honestly as `SuppliedUnprobed`; content verification is not media-capability verification. See the normative [mirrored-study architecture](./for-ai/25-MIRRORED-STUDY-ARCHITECTURE.md) and the evidence-based [roadmap](./for-ai/40-ROADMAP.md).

The synchronized Face + Flubber comparison may be selected as presentation inside an instruction block across all three primary surfaces, including the immersive WebXR instruction panel. It remains presentation-only, consumes one exact current X/Y/phase frame, and is neither a separate study phase nor a stimulus or diagnostic model.

## Mandatory project brief for AI agents

Every AI agent must read [`AGENTS.md`](./AGENTS.md) and every file in [`for-ai/`](./for-ai/) before doing anything else in this repository. That directory records the product requirements, cross-delivery parity contract, architecture, test gates, and roadmap.

## Controls

| Input | Effect |
| --- | --- |
| Left/Right arrows (default) | Decrease/increase valence |
| Up/Down arrows (default) | Increase/decrease arousal |
| Mouse wheel or trackpad | Change arousal |
| Shift + wheel | Change valence |
| Space | Pause or resume shape motion |
| R | Return the affect target to neutral |
| Drag the shape | Move the widget without changing affect |

Continuous mode moves while a direction is held. Step mode changes the target by `0.1` per press. The on-screen direction pad follows the selected mode.

### Synchronized Face + Flubber

The GitHub Pages app keeps an affect face on the main stage to the left of the canonical Flubber. The top-level **Synchronized Face + Flubber** accordion enables, disables, centers, and selects that presentation; closing the accordion does not remove the face. The phone controller uses the same selected browser mode, and the desktop settings window provides the same five choices from its Rust-authoritative snapshot. Every mode receives the exact same displayed valence, arousal, and animation-phase snapshot as its Flubber and owns no input or research clock.

The selectable main-tracker modes are **AFFEC empirical 3D**, which uses aggregate perceived-rating locations from 5,807 valid AFFEC trials to blend project-authored expression prototypes on a locally packaged Vitruvian morph head; **MediaPipe-rigged atlas 3D**, which uses compact blendshape signals extracted once at build time from nine project-owned atlas cells; **Continuous FACS-style 3D**, a project-authored continuous morph mapping; **11 × 11 morph matrix 3D**, which interpolates project-authored anchors; and **Photoreal atlas blend**, a local project-created synthetic atlas. The detailed modes use locally vendored Three.js and checked-in GLB/textures, then degrade locally through the photo atlas to the canonical SVG face if detailed rendering is unavailable. The application downloads no face model at runtime, requests no camera, performs no face recognition, and makes no diagnostic or one-expression-per-state claim. Asset and data provenance are recorded in the [local face notice](./site/assets/affect-face/NOTICE.md) and [research ledger](./for-ai/70-RESEARCH-PROVENANCE.md).

Those selectable main-tracker engines are not the portable-study presentation contract. A `faceFlubberComparison` instruction uses the canonical vector face and canonical Flubber across Pages, desktop, and immersive WebXR from one exact current-X/current-Y/phase snapshot. It remains presentation-only, non-diagnostic, and neither a study phase nor a stimulus.

The separate always-on-top desktop overlay intentionally remains Flubber-only.

### Experimental Touch/Trackpad control

Open the visibly marked **Touch/Trackpad Playground — Experimental** accordion and switch on **Enable touch/trackpad tracking** to map an unrestricted two-dimensional pointer trajectory into the display:

- Repeated coherent circular or elliptical thumb loops move valence right. Uncontrolled multi-direction movement with dominant V/W-like turns moves it left, even when the thumb naturally bows the legs between turns.
- Faster movement raises arousal; slower movement lowers it. Stopping is inactivity and is never classified as slow movement.
- Touchscreens and pens use browser Pointer Events. A laptop touchpad appears to the page as an OS-accelerated mouse cursor trajectory; browsers do not expose its raw finger contacts.

Cold-start speed calibration uses viewport-normalized movement: `0.15` viewport diagonals/second (D/s) represents a deliberate slow command, the log-space midpoint is about `0.44 D/s`, and `0.80 D/s` represents a quick command. These anchors are grounded in published front-screen drag/swipe measurements, then progressively replaced by the participant's p10/p90 range. Affect studies support faster movement as a useful arousal-related feature, but do not establish portable diagnostic thresholds across people, tasks, devices, or OS-accelerated touchpads. The labels therefore describe lower/hold/higher-arousal **control commands**, not detected emotional states.

The default **Gated move-and-hold** behavior lets the participant keep drawing until the Flubber reaches the intended state. While fresh movement is arriving, confidence-weighted speed and shape evidence outside a `0.12` dead zone continuously moves the target at up to `0.4` normalized units per second: fast/slow raises/lowers arousal and circular/angular moves valence right/left. Stopping closes the movement window after 400 ms and freezes the exact reached position without a release-time jump or neutral decay. Each completed window contributes only one representative sample to participant-specific calibration, preventing a long gesture from outweighing many short gestures. Calibration blends from safe priors over the first 20 qualified windows.

**Continuous live response** remains available for comparison. It follows movement in real time, holds the last result for 1.8 seconds, and then returns gradually toward neutral. In both behaviors, the playground shows detected pointer type, shape, speed, confidence, the last four seconds of movement, and a live valence–arousal color map with a moving dot. Mouse and OS-accelerated touchpad cursor movement is tracked continuously anywhere in the active browser page, including over the playground controls; clicks retain their ordinary behavior and are not movement-stroke boundaries. Two measured movement segments are enough for full speed confidence. Rapid touch/pen strokes beginning within 900 ms share recent speed evidence and compare their own on-surface directions, allowing an up/down/up sequence to become angular evidence during the active swipe. Separate strokes are never geometrically joined and the lifted-finger jump is never counted. **Hide mouse cursor while tracking** removes the pointer over movement/stimulus areas while deliberately leaving it visible over settings so the option is reversible. Enable **Show movement trace beneath Flubber** to mirror the trace in a floating normalized overview below the Flubber. Both canvases uniformly fit the page-wide path with preserved aspect ratio and unsmoothed butt/miter segments, so they act as miniature viewports rather than drawing boundaries. Flubber dragging and directional manual changes are disabled while this source is selected, although Reset remains available and physical inputs remain logged during experiments.

This is an experimental movement-feedback prototype, not validated emotion recognition or diagnosis. Its algorithm, limitations, calibration rationale, and research provenance are documented in [`for-ai/60-EXPERIMENTAL-TOUCH-TRACE.md`](./for-ai/60-EXPERIMENTAL-TOUCH-TRACE.md) and [`for-ai/70-RESEARCH-PROVENANCE.md`](./for-ai/70-RESEARCH-PROVENANCE.md).

### Experimental Polar Stream

Open the fourth **Polar Stream — Experimental** accordion in a secure desktop Chrome, Edge, or compatible Chromium browser, then press **Connect** in its compact H10 connection module and select the strap in the browser-owned Bluetooth chooser. For the most reliable start, wear and moisten the electrodes, keep the sensor close to the PC, and disconnect it from Polar Beat/Flow, watches, gym equipment, and other browser tabs before opening the chooser. The same checklist is visible beside Connect. The page streams the H10's 130 Hz PMD ECG locally and exposes small signal modules for the provisional Excite-O-Meter score, the 65/35 activation composite, uncorrected rolling RMSSD/lnRMSSD/SDNN, five-second local ECG power, heart rate, RR, RMS, and peak-to-peak amplitude. Every module has direct **X · Valence** and **Y · Arousal** buttons; the fine-tuning section exposes low/high bounds and reversal. Each axis stays manual until it is explicitly assigned. While the Touch/Trackpad protocol is active—its accordion is open or an experiment is running—it pauses Polar control without disconnecting the H10.

Web Bluetooth requires HTTPS or localhost and a compatible browser. The main-page accordion remains disabled in stock Meta Quest Browser; the separate WebXR study now exposes its own capability-tested Polar experiment described below. A sideloaded Chromium build is not a qualified study path. One explicit Connect gesture includes four bounded transient GATT attempts and, if ECG startup is acknowledged but no first packet arrives, one complete teardown-and-setup retry against the same browser-selected H10. After readiness, five seconds without a valid ECG packet pauses Polar axis ownership and performs one bounded teardown/restart of that same selected device without reopening the chooser; a second silence fails closed and requires Connect again. It does not auto-connect on load or after actual Bluetooth range loss. Raw ECG stays in a bounded in-memory window and is not written to CSV or local storage. Low-rate CSV rows retain connection, mapping, current metric, and normalized-axis context. The feature is experimental, uncorrected for ECG/RR artifacts, and is neither an emotion detector nor a medical tool. See [`for-ai/65-EXPERIMENTAL-POLAR-STREAM.md`](./for-ai/65-EXPERIMENTAL-POLAR-STREAM.md) and the [Polar Stream notice](./site/assets/POLAR-STREAM-NOTICE.md).

For repeatable transport qualification without a worn strap, open the main page with `?mock-polar=1`, press **Start synthetic replay**, assign its deterministic 130 Hz fixture to X/Y, and press **Broadcast this to VR / remote interface**. This explicit page-load-only fixture follows the same bounded metric, mapping, smoothing, and WebRTC path as the browser H10 adapter, but contains no real physiology and cannot replace physical H10 acceptance.

The native Quest launcher now has its own **Polar Stream · H10** module using Polar BLE SDK 8.1.0. An explicit Connect action requests nearby-device permission, auto-discovers the H10, shows the bounded ECG waveform and all ten web-compatible metrics, and exposes independent X/Y low/high/reverse mappings. Assigned runs require stable real 130 Hz ECG; during playback or Flubber-only passthrough each finite mapped metric owns only its axis and Touch remains the fallback. Raw ECG/RR series are never written or placed in LSL. Physical worn-H10/headset qualification is still required before research use; see the [native VR guide](./vr/README.md).

### Real-time Flubber broadcast

The desktop browser can press **Broadcast this to VR / remote interface** to publish only the final smoothed Flubber X/Y coordinates. That one action opens a small browser-owned floating Flubber window and requests a renewable screen wake lock so Chrome continues supplying the animation frame that owns smoothing and transmission when its main window is covered; stopping the broadcast closes only a helper window opened by that action. On `webxr.html`, Meta Quest Browser can press **Use incoming signal**; one source is selected automatically, while several sources appear as large tap/controller-ray buttons. No code, microphone, audio signal, QR scanner, clipboard, native app, or custom bridge server is involved. Quest applies every accepted pair directly to both axes on the next XR frame. The lowest-latency receiver mode is active immersive WebXR, backed by its own renewable screen wake lock; the page reports when an XR system overlay blurs or hides the session, and Meta may still deprioritize an ordinary browser panel. A two-second loss grace tolerates the roughly one-second delivery batching measured in that deprioritized state, and three consecutive returning frames are required before the status reports recovery, while their coordinates are still applied immediately. The headset page shows receiver-local frame count and gap timing without adding timestamps to the wire.

This is an explicit session-only public-network exception. The locally vendored VDO.Ninja 1.5.5 SDK uses third-party signaling/STUN/TURN; an internet signaling connection is required, remote peers may learn IP addresses, relay routes may add latency, and the hosted service is not guaranteed. The wire carries only anonymous affect X/Y and normalized viewport-placement pairs—never ECG, RR, heart rate, metric choices, timestamps, participant identity, visual settings, or CSV rows. Nothing reconnects after reload. For an attended relay qualification only, load both endpoints with `?remote-force-turn=1`; the UI labels the request and the route must still report **TURN relay** before the run is accepted. The flag is not persisted and does not start a connection. See [`for-ai/66-EXPERIMENTAL-REMOTE-FLUBBER.md`](./for-ai/66-EXPERIMENTAL-REMOTE-FLUBBER.md) and the [vendored SDK notice](./site/vendor/vdoninja/1.5.5/NOTICE.md).

Brief WebRTC channel repair uses the same two-second loss grace, so it does not flash the Quest HUD stale when valid coordinates resume inside that window; accepted coordinates themselves are never delayed or buffered.

### Public settings JSON beacon

The main page's fifth **Ground Control** accordion provides named JSON download/load, a static **Broadcast JSON** / **Scan JSON** settings beacon, and a separate continuous **Broadcast Live FLUBBER** / **Scan Live FLUBBER** path. The static beacon captures one complete normalized portable settings object—including LSL metadata—and never sends live coordinates; the continuous stream sends final X/Y plus optional normalized Flubber viewport placement and never sends raw pointer trails, settings, or physiology. A receiver anchors the first placement locally, so later phone or desktop Flubber drags move in the same relative direction across differently sized viewports without an initial jump. Both paths are inert until their explicit actions, use the operator-entered public name, and require stop/restart to change the advertised identity or frozen snapshot.

Another browser presses **Find settings beacons**. One live source is selected automatically after a short discovery interval; several sources appear as large buttons. The receiver validates the protocol, source, size, schema version, and every portable field, then displays the complete formatted JSON. Nothing changes locally until **Apply received settings** is pressed. This path is independent from the low-latency `flubberxyv1` transport: it uses VDO.Ninja's default reliable ordered data channel, has no heartbeat or continuous loop, and does not use WebSocket fallback.

The room is public and source labels are anonymous, not authenticated. Anybody who knows the site/room can imitate a source, so preview-before-apply is mandatory. The entire portable JSON is visible to connected listeners, including custom LSL names/source ID; do not place identities, credentials, secrets, or sensitive study data in settings before broadcasting. The beacon exists only while the source page remains open and is not a database. VDO.Ninja supplies third-party signaling/STUN/TURN and peers may learn IP addresses. See [`for-ai/68-EXPERIMENTAL-SETTINGS-BEACON.md`](./for-ai/68-EXPERIMENTAL-SETTINGS-BEACON.md).

### Smartphone web viewer

The GitHub Pages application has a touch-first phone layout; no native smartphone app is required. On the first visit from a narrow touch-capable device, **Touch Lab** opens automatically but tracking remains off until the participant explicitly enables it. The phone viewer provides compact protocol tabs, safe-area/notch support, dynamic viewport height, a live Flubber preview beside the 2D valence–arousal map, and a large non-scrolling swipe pad. Secondary response, calibration, privacy, and display controls remain available in a collapsed options section. Portrait phones up to 600 CSS px wide and coarse-pointer phone landscape viewports up to 500 CSS px tall receive the compact layout.

Direct finger input uses primary W3C Pointer Events and pointer capture. The active swipe pad has `touch-action: none`, while surrounding settings remain vertically scrollable. Coalesced points are used when the browser supplies them and ordinary dispatched points remain the Safari-compatible fallback. Additional simultaneous touches are ignored. Phone layout changes presentation and discovery only; it uses the same `touch-trace-v10` signal algorithm, privacy boundary, adaptive calibration, and experiment CSV schema as larger browsers. The movement canvas uniformly fits the page-wide path without changing its aspect ratio or smoothing its segments. V10 measures turn coherence over 0.02-diagonal chords, reserves adjacent vectors for explicit reversals, requires partial path closure before winding becomes strong, and uses ≥60° dominant corners; this prevents ordinary mouse micro-jitter from saturating the angular/random command while retaining V/W, backtracking, and ellipse fixtures.

## Visual mapping

The animation preserves the default AffectTracker mapping while using deterministic seeded irregularity and frame-rate-independent input smoothing:

```text
frequency = 1.5 + arousal             (0.5–2.5 Hz)
amplitude = 0.3 + 0.1 × arousal       (0.2–0.4)
shape mix = (valence + 1) / 2          (pointy→rounded)
disorder  = 0.4 × (1 - valence)        (irregular→regular)
```

The renderer has 192 perimeter samples and 16 projections. In **2D grid & colors**, use the four illustrated buttons to choose a **Circle**, **Heart**, **Triangle**, or **Square** base envelope alongside the live affect preview and palette; Circle remains the backward-compatible default. The envelope changes only Flubber's silhouette, so the Heart retains the same arousal-driven 0.5–2.5 Hz pulse and amplitude response whether it is driven manually or by Polar Stream—useful for an excitable-heart presentation without changing the underlying affect mapping. Both apps expose a four-anchor Up/Down/Left/Right palette and an exact interactive 2D color-space picker; the neutral center blends outward toward the configured axis colors. In the web Settings panel, the picker contains a miniature copy of the live animated Flubber and numeric coordinates. Click, drag, or use the arrow keys to move it while judging palette choices.

## Logging and privacy

The normal tracker session keeps a fixed-size ring buffer of at most 10,000 records:

- Semantic input events such as key/button presses, wheel changes, resets, mode changes, drag completion, export, and buffer clearing.
- Affect samples at 20 Hz while the page is visible.

By default, everything stays inside the current browser tab. There are no analytics. Network activity occurs only through reviewed explicit actions: optional YouTube playback, an entered WebXR HTTPS webhook, or Ground Control's static/live VDO.Ninja buttons. Live FLUBBER sends only final X/Y coordinates plus optional normalized screen placement, never raw pointer trails; the settings beacon sends only one captured portable settings object. Neither sends physiology or records. Closing or refreshing the page discards records that have not been downloaded. Use **Download CSV** to export the current session in chronological order.

### Remote study demonstration

Choose **Start experiment** to run a 3–2–1 countdown, force affect to neutral, begin an isolated 20 Hz recording session, and show a protected 16:9 stimulus centered at the largest size that leaves the Flubber unobstructed. The player has no controls, cannot receive pointer or keyboard interaction, and automatically exports the experiment CSV when the selected segment ends. Every experiment row includes monotonic elapsed time, ISO wall time, stimulus identity/time, current and target valence/arousal, and widget position. During acquisition, physical key press/release, mouse-button press/release, and wheel events are also recorded; typed characters are never recorded. Pointer movement is captured and written only when the visibly enabled Experimental Touch/Trackpad source is active and the stimulus is actually playing. It cannot capture other tabs, browser chrome, background pages, or other applications.

The Experiment panel also offers optional physical screen calibration through one **Calibrate screen** button. The fullscreen wizard first offers the BIS 2025 top-ten currency shortcuts (USD/EUR/JPY/GBP/CNY/CHF/AUD/CAD/HKD/SGD) or a searchable SVG flag-labelled country list, then replaces that directory with the selected currency's coin inventory. Shared currencies use a compact country selector instead of keeping country tabs on screen. The static catalog currently contains 217 officially sized circulating coins across 37 currencies and 61 countries. Circular coins use official diameter; polygonal, scalloped, and Spanish-flower pieces use the official maximum outer span or closest issuing-authority approximation and are fitted at their furthest outer edges. Place the real coin anywhere on the display, drag a perfect square around it with mouse, trackpad, pen, or one finger, and fine-tune with axis-moving edges or opposite-corner resizing before confirming. Coin diagrams are relative, not physically scaled. A confirmed v2 result is stored only in this browser and adds protocol, country, reference coin, scale, and calibrated fullscreen viewport dimensions to experiment CSV; it becomes stale after a screen-size, pixel-ratio, or orientation change. Older two-match records remain readable until replaced. This physical reference is necessary because browser CSS units alone do not reliably reveal a display's manufactured size.

The bottom-right **Windows 95** toggle applies an optional browser-local retro skin without changing tracker state, settings JSON, experiments, CSV, or input behavior. It restyles the complete main application—including panels, forms, calibration, and input dialogs—as a square-edged Windows 95/Netscape/SPSS-style interface and adds temporary classic status windows. Four locally packaged Kenney UI Audio cues under CC0 are reserved for classic system-style events such as enabling/disabling the skin, opening an important prompt, completing an operation, or reporting an error; ordinary buttons, field edits, movement, and countdowns stay silent. The app includes no Microsoft fonts, sounds, or binary assets and makes no runtime asset request outside the repository. Switching back restores the modern skin immediately, and the choice persists only in that browser.

The top-left interface uses seven mutually exclusive accordion toggles: **Affect Tracker Settings**, **Synchronized Face + Flubber**, **Experiment**, **Screen Calibration**, **Touch/Trackpad Playground**, **Polar Stream**, and **Ground Control**. Experiment sessions use an append-only chunked CSV writer so raw pointer points and 20 Hz samples never roll over with the normal 10,000-record buffer. Buffering pauses active-time sampling, partial trials are marked with a stop reason, and a failed export can be retried from the Experiment panel.

Touch experiments distinguish `pointer_raw`, `touch_metric`, `sample`, and `event` rows. Extended columns retain observed pointer coordinates, filtered speed, cross-stroke speed-continuity state, circle/angular scores, winding, radial variation, heading entropy, dominant-corner count, direction-reversal evidence, cursor visibility, feedback behavior, gate identity/duration/commit, live rates and accumulated live deltas, per-gate calibration counts, adaptive bounds, confidence, normalized touch targets, displayed affect state, wall time, active playback time, and player time so researchers can reconstruct or replace the online normalization. Trials configured over 30 minutes show a local file-size warning without blocking playback.

The default stimulus is [`site/assets/dictator-3-study.mp4`](./site/assets/dictator-3-study.mp4), a 1920×1080 H.264/AAC copy of `Dictator 3.m4v` trimmed so its first frame corresponds to the original 90-second point. It is preloaded from GitHub Pages and does not contact a third party. Researchers can instead select **YouTube URL**, paste any supported watch/share/embed URL, and provide explicit start and finish seconds. That optional mode connects to YouTube and is subject to YouTube embedding permissions and playback policy; the affect CSV still remains local.

The widget appearance, position, bindings, input behavior, panel state, and browser-only Polar axis assignments are saved in `localStorage`. Affect values, ECG, and history are not persisted.

### Experimental Meta Quest WebXR study

Open [`site/webxr.html`](./site/webxr.html) in Meta Quest Browser and choose either the bundled flat-screen Great Dictator clip or one of eight full-sphere CEAP-360VR stimuli. The CEAP choices are exact one-minute excerpts from the dataset's validated frame ranges and are silent because the distributed source files contain no audio. The right controller thumbstick continuously steers valence and arousal, left **X** resets to neutral, and left **Y** pauses or resumes playback. Presentation can use a virtual background, headset passthrough behind the flat video, or passthrough with Flubber alone and no video. An optional pre-entry controller-follow mode rigs Flubber just above the selected left or right grip pose, with an independent 0.5–2× size control; fixed placement remains the default, and a brief tracking loss holds the last valid pose. The pre-entry **Polar Stream — Experimental** menu is enabled only if that exact browser exposes Web Bluetooth: connect and wait for live ECG before entering immersive mode, then assign any derived metric to X, Y, both, or neither. Alternatively, **Use incoming signal** discovers an explicit desktop broadcast before immersive entry, disconnects direct Quest Polar, and gives both axes to the final received X/Y pair without local smoothing; loss holds the last pair and warns rather than falling back silently. A finite assigned direct-Polar metric otherwise replaces only its selected axis; the right thumbstick retains every unassigned or not-yet-ready axis, and the in-world Flubber HUD reports the live input route in both virtual and passthrough presentation. Quest Browser/H10 and remote-WebRTC acquisition remain unqualified until physical headset passes confirm sustained streaming. The page samples at 20 Hz and prepares a stimulus-labelled CSV download when the video finishes or the immersive session exits. Every row includes stimulus provenance, presentation mode, Flubber configuration, low-rate Polar mapping context, and additive remote enabled/source/state/sequence/local-age provenance without raw ECG/RR series or per-packet logging. A researcher may enter a per-run HTTPS webhook before entering VR; if delivery fails or no webhook is configured, the CSV remains available for headset download. The webhook address is not persisted.

The WebXR pre-entry panel also chooses Circle, Heart, Triangle, or Square for that run, and every CSV row records the selected `flubber_base_shape`. Circle remains the default. Shape does not change controller, Polar, or remote-coordinate ownership; it changes only the shared Flubber envelope.

This path is intentionally isolated from the general browser tracker. It does not publish LSL, load arbitrary local/YouTube stimuli, import saved tracker settings, use the experimental touch trace, or bridge its browser Bluetooth connection into the native APK. Its Polar menu reuses only the bounded browser adapter and keeps assignments per page load; the APK's official-SDK Polar module is an independent native transport. The APK launcher button opens the hosted URL through Android's browsable-link intent. Physical controller mapping, media playback, Bluetooth retention, file download, and webhook delivery still require acceptance testing in Meta Quest Browser before study use. CEAP media are not covered by the repository's BSD-3-Clause software license; see [`site/assets/ceap/NOTICE.md`](./site/assets/ceap/NOTICE.md) for the dataset reference and excerpt details.

## Shared customization JSON

The online and desktop apps expose the same input behavior, physical bindings, four-axis colors, Circle/Heart/Triangle/Square base envelope, flubber size, visibility, position, and 0–100% transparency control. Their advanced menus also expose animation speed, pulse amplitude, shape disorder, and optional input assignments for increasing or decreasing those features, transparency, and size. Choose **Export settings JSON** in either app and import that file in the other. A desktop-exported file therefore produces the same flubber palette, geometry, transparency, controls, and placement in the browser, subject only to viewport constraints and the desktop overlay versus browser black-stage difference.

The portable schema stores transparency as `overlay.opacity` (`1` is opaque, `0` is fully transparent) and the envelope as `visual.baseShape`. Additive version-1 `visual` and `advancedBindings` fields preserve backward compatibility with older version-1 files; an omitted `baseShape` resolves to Circle. The schema also carries the LSL stream metadata: GitHub Pages preserves those values for round-tripping, although a browser cannot publish LSL.

Repository maintainers can replace [`site/settings.json`](./site/settings.json) with an exported version-1 file to change the hosted defaults. Returning browsers retain their own `localStorage` preferences; clear site data or import the JSON to apply new defaults immediately. Ground Control file download/load stays local; only its explicit Broadcast JSON action transmits a frozen copy under the disclosure and preview-before-apply contract above.

### Float over other applications from the browser

In browsers that support Document Picture-in-Picture, enable **Float Flubber over other apps** under Customization. The live SVG then moves into a browser-owned always-on-top window and returns to the page when that window closes. The originating page must remain open, the browser controls the floating window position, and configured controls only work while either Affect Tracker window is focused. Unsupported browsers show a disabled checkbox and can use the desktop companion instead. The page-controlled Picture-in-Picture surface is transparent, borderless, edge-to-edge, and requests the minimum available browser chrome.

This is intentionally transient and is not stored in the portable settings JSON. Chromium may still draw an opaque compositor surface and always retains security-critical window controls; a website cannot remove those. Unlike the Tauri overlay, the browser window is not click-through, cannot guarantee OS-level transparency, cannot monitor global input, and cannot publish LSL.

## Desktop companion

**Affect Tracker Desktop** uses the bundle identifier `io.github.georgefejer91.affecttracker`. It contains two local windows:

- A normal settings window with the selected local face engine left and canonical Flubber right (with local photo-atlas/vector fallback), live coordinates, physical-input mappings, an interactive color-space picker, overlay appearance, and LSL configuration.
- A transparent overlay that floats above other applications. It is click-through while locked and draggable only in explicit edit mode.

Rust owns authoritative affect coordinates, smoothing, timestamps, settings, global raw-input monitoring, tray lifecycle, and LSL publication. The desktop WebViews contain presentation only and communicate through narrow typed commands. One immutable snapshot supplies `currentX`, `currentY`, and `phase` to both settings-window renderers, keeping facial deformation and Flubber pulse/rate synchronized without making rendering the research clock. Closing the settings window quits the process and removes the overlay; the tray menu also provides an explicit Quit action.

The settings window offers a transient **Continuous** traversal and an **11×11 matrix** traversal. The matrix spans both axes from `-1` to `+1` in `0.2` increments, including exact neutral at center cell `(5,5)`. Selecting any of its 121 cells follows the shortest 8-connected route, taking diagonal steps while both axes differ and cardinal steps afterward, at a configurable `0.5–10` states per second. Stop holds the current node; Reset returns to exact neutral. The traversal mode, target cell, path, and rate are session state rather than portable settings. LSL continues publishing the same eight current/target channels, so matrix motion changes values but not the stream schema.

The four default affect bindings are the plain arrow keys. Click any binding field and then press a key, click a mouse button, or scroll to assign that physical control. Bindings remain active while another application is focused; duplicate or invalid assignments are rejected. macOS requires Accessibility permission for global input monitoring. The Linux package currently supports global capture under X11; Wayland compositors may block it.

### Desktop LSL schema

The regular float stream defaults to `AffectTracker` at 50 Hz with these channels:

```text
current_valence, current_arousal, target_valence, target_arousal,
radius, angle_degrees, animation_active, input_active
```

The separate `AffectTrackerMarkers` stream carries irregular markers for every physical key press/release, mouse-button press/release, wheel event, and permitted semantic app action. Native study actions add only a fixed lifecycle allowlist after the reducer outcome and its record batch have been durably accepted (and, for terminal actions, after finalization succeeds). The projection includes bounded run/block identity and media position where applicable, but never questionnaire answers, affect samples, health/stall text, abort reasons, or other caller-authored payload strings. Physical input markers record identifiers such as `ArrowUp` or `Left`, never composed characters or typed text. Both streams start automatically whenever the app runs and remain local to LSL; saved stream names, rate, and source ID are reused on later launches. The application does not upload study data to a web service.

### Build the desktop companion

Install Node.js 22, pnpm 11, rustup, the current Tauri v2 prerequisites for your OS, CMake, and a native C/C++ compiler. The checked-in `rust-toolchain.toml` pins Rust 1.96.0, including the WASM target used for browser authority builds. CI regenerates that package, verifies its ABI and behavioral fixtures, and deploys the validated artifact; cross-host WebAssembly binaries are not assumed to be byte-identical. Then run:

```sh
pnpm install --frozen-lockfile
pnpm desktop:build
cargo test --manifest-path src-tauri/Cargo.toml
cargo tauri dev
```

See [`desktop/README.md`](./desktop/README.md) for the LSL feature fallback and qualification requirements. Unsigned development builds are not a substitute for signed/notarized public installers.

### Desktop downloads

Cross-platform packages are published on the [GitHub Releases page](https://github.com/GeorgeFejer91/affect-tracker-web/releases). Each desktop release includes:

- Windows x64 NSIS installer (`.exe`).
- Linux x64 AppImage and Debian package (`.AppImage` and `.deb`).
- Universal macOS disk image for Apple Silicon and Intel (`.dmg`).

The initial packages are unsigned. Windows SmartScreen, macOS Gatekeeper, or Linux desktop security tooling may therefore ask the user to confirm that they trust the download.

## Accessibility

- All controls use semantic HTML and visible keyboard focus states.
- The widget exposes its current coordinates to assistive technology.
- Status changes use a polite live region.
- When `prefers-reduced-motion` is enabled, whole-body pulsing is disabled and projection motion is reduced without disabling input or logging.

## Run locally

No build is required. Serve the `site` directory through any static server:

```sh
python -m http.server 8000 --directory site
```

Then open <http://localhost:8000/>. Opening `index.html` directly is not recommended because browser security rules can block ES module imports from `file:` URLs.

## Test the web application

The unit suite uses Node.js 22's built-in test runner and has no package dependencies:

```sh
pnpm test
pnpm stress:flubber-shapes
```

The suite covers the affect mappings, all four normalized base envelopes, deterministic offsets, path generation, smoothing, keyboard/wheel movement, widget and experiment-video/trace constraints, stimulus configuration parsing, ring-buffer rollover, append-only experiment logging, session reset, experiment context fields, CSV escaping, Polar PMD/heart-rate decoding and metric mappings, remote-Flubber wire/lifecycle/discovery/rate/stale/ownership behavior and vendor hashes, 1€ conformance values, theoretical, mouse-jitter, and thumb-like angular/circular path metrics, sampling-rate invariance, continuous inactivity decay, gated live move-and-hold integration, release-without-overshoot, per-window adaptive calibration, and aspect-preserving page-wide trace fitting. The stress command simulates 30 minutes at 60 Hz while cycling every envelope and the full affect/amplitude/disorder ranges; it also runs in the Pages workflow.

## Deployment

Pushes to `main` run the tests and deploy only the contents of `site/` through the existing GitHub Actions workflow to GitHub Pages. GitHub Pages is the sole web host; no secondary hosting workflow is part of this project. In the repository settings, Pages must use **GitHub Actions** as its source.

The separate desktop workflow builds the WebViews and runs Rust formatting, checks, tests, and clippy on Windows, macOS, and Linux. Release tags package the unsigned installers on their matching operating systems.

## Attribution and license

The affect mapping, circular projection model, and visual concept derive from:

> Fourcade A, Malandrone F, Roellecke L, Ciston A, Mooij JD, Villringer A, Carletto S and Gaebler M (2025). AffectTracker: real-time continuous rating of affective experience in immersive virtual reality. Frontiers in Virtual Reality 6:1567854. <https://doi.org/10.3389/frvir.2025.1567854>

The original AffectTracker project is Copyright © 2024 Antonin Fourcade and is distributed under the BSD 3-Clause License. This web implementation retains that license and attribution; see [LICENSE](./LICENSE).
