# Quest controller-input investigation and handoff

## Executive summary

The controller failure was a controller-ownership and lifecycle problem, not a Flubber-math problem and not a conflict between two Android applications. Video, Flubber, controller polling, grabbing, and LSL all run inside one `AffectTrackerVrActivity` and one Spatial SDK/OpenXR session.

The investigation exposed two successive failures:

1. Once Touch input began reaching the app, Meta Spatial SDK's default `LocomotionSystem` also consumed the same thumbstick. The stick changed Flubber, but it simultaneously displayed the teleport ray and moved or rotated the world.
2. Removing `LocomotionSystem` stopped locomotion, but also disrupted the Interaction SDK controller-input handoff. The next physical run showed no Flubber response and no useful controller feedback.

The current correction keeps the SDK-created `LocomotionSystem` registered because `VRFeature` passes that exact object to Interaction SDK as its `ExternalControllerInputHandler`. The app calls `enableLocomotion(false)`, verifies `LocomoteState.Disabled`, verifies `areControllersInUse() == false`, and reasserts that invariant from the late controller poll. This preserves the bridge's scheduled per-frame bookkeeping while preventing teleport, snap-turn, and world movement.

Host tests and exact APK installation/readback pass. The final correction has not yet received its required attended physical Touch acceptance run. Do not describe this issue as physically closed until the checklist near the end of this document passes on the installed APK.

## Required behavior

- The configured Touch thumbstick controls the same two-dimensional affect target used everywhere else:
  - X controls valence, clamped to `[-1, 1]`.
  - Y controls arousal, clamped to `[-1, 1]`.
  - Diagonal input updates both axes.
  - Continuous mode applies the configured radial dead zone and `continuousSpeed`.
  - Step mode applies the configured `stepSize`, threshold crossing, and neutral re-arm.
- Input remains active whenever the visible Flubber entity exists, including preparation, countdown, playback, and whole-session pause. It must not depend on video playback, LSL sampling, Android panel focus, or whether the pointer is over the Flubber.
- The selected hand comes from the one universal profile in `active-session.json`, so choosing another video cannot change it. The contract continues to support either `left` or `right`.
- The same stick must not display a teleport cursor/ray, teleport, snap-turn, or move the video/world.
- Controller tracking/models and pointer-trigger grabbing must continue working.
- Trigger grabbing must work anywhere on the tight transparent Flubber rectangle, not only on visible colored pixels. The entity uses the registered panel scene object's toolkit `Grabbable` listener and synchronized `PanelDimensions`; it deliberately omits the giant overlapping manual ISDK edge colliders that made the target oversized and inconsistent.
- With the default X reset/Y pause mapping, A recenters Flubber on the current head-gaze ray at its current clamped distance. Imported profiles that explicitly assign A to reset or pause keep that older action and do not also recenter.
- One activity owns every controller route and feeds one `AffectEngine`; video and Flubber are not competing applications.

## What the wearer observed

The observed sequence is important because each report ruled out a different layer:

1. The first installed versions displayed the app and video, but Flubber did not react to joystick input.
2. The controller laser changed color when the wearer moved the stick. That proved the headset noticed some controller interaction, but did not prove the application received valence/arousal input.
3. The in-app controller model was visible but did not visibly articulate buttons or stick motion like the Meta Home controller model. This was initially treated as possible evidence that the controller itself was disconnected from the app.
4. The wearer clarified that the active/standard controller was the right Touch controller. Hand-specific routing and diagnostics were adjusted so right-controller evidence could be distinguished from an unrelated left or fallback entity.
5. After explicit Interaction SDK setup, late controller polling, and broader controller-source resolution, the joystick began changing Flubber.
6. That success exposed a second problem: moving the stick also activated the teleport ray and moved/rotated the scene.
7. An attempt to eliminate that conflict by unregistering `LocomotionSystem` removed the unwanted movement, but the following physical test lost joystick-to-Flubber response and useful controller feedback again.
8. SDK bytecode inspection then showed that locomotion behavior and the ISDK input bridge share the same system object. The current implementation retains the object and disables only its locomotion state.
9. A later multi-video check exposed a separate configuration drift: `active-session.json` selected the right stick, while every generated optional-video manifest on the headset selected the left stick. Selecting a clip therefore replaced the working controller profile. The loader now treats the active manifest as the universal runtime profile and overlays it onto every video choice; optional manifests retain only video identity/layout semantics.

## Findings that narrowed the problem

### Flubber and video are not separate controller owners

OpenXR gives input focus to an application session. Affect Tracker has one immersive activity and one Spatial SDK session; the video carrier, Android panels, Flubber entity, controller systems, and LSL worker are components of that same app. There is no second foreground app that must be assigned a controller. Adding another OpenXR session or input-owning process would create the conflict the design is intended to avoid.

### A visible controller model is not an input receipt

`AvatarSystem.setShowControllers(true)` controls Spatial SDK's app-owned render model and tracked pose. Meta Home owns a different shell controller presentation whose animated button/stick articulation is not an application API contract. A controller model that tracks spatially but does not animate its buttons therefore does not prove that the app did or did not receive `Controller.buttonState`, an ISDK scroll event, or an Android `MotionEvent`.

For this reason, the readiness gate uses app-owned receipts instead of judging the shell-style model animation:

- controller entity inventory and selected-hand source;
- nonzero hand-specific controller button state;
- accepted hand-matched ISDK scroll input; or
- a pinned `VrActivity` game-controller motion event;
- followed by changed affect target/current values and a completed Flubber canvas draw.

### Spatial SDK 0.13.2 does not expose one universal analog-stick API

At the pinned SDK version, the public Spatial `Controller` component exposes hand-specific directional thumb bits. Some interaction paths instead deliver the stick through `PointerEvent.scrollInfo`. `VrActivity` also exposes a game-controller pinning route that can receive Android motion events for devices represented as joystick/gamepad sources. No one route can be assumed to exist on every runtime/controller composition, so the app retains three bounded physical routes that converge on the same engine.

### The `VRFeature` Boolean was misinterpreted

`VRFeature(this, LocomotionControls.Right, false, VrInputSystemType.INTERACTION_SDK)` does not mean "locomotion disabled." Pinned 0.13.2 signatures identify that Boolean as `shouldConsumeLeftRightInput`. Setting it to `false` therefore did not prevent teleport or snap/world movement.

### `LocomotionSystem` has two roles in this composition

Pinned 0.13.2 bytecode shows this lifecycle:

1. `VRFeature.earlySystemsToRegister()` creates one `LocomotionSystem`.
2. When Interaction SDK is selected, `VRFeature` passes the same instance into the ISDK systems as `ExternalControllerInputHandler`.
3. ISDK communicates controller-use results through `areControllersInUse()` and `setControllerInputResult(...)`.
4. The scheduled `LocomotionSystem.execute()` clears its per-controller result map every frame.

Unregistering the system can therefore leave ISDK holding the bridge object while the object's normal scheduled reset no longer runs. That explains why the unregister strategy removed locomotion and then starved or stalled controller delivery in this app lifecycle.

Calling `enableLocomotion(false)` is different. It enters `LocomoteState.Disabled`, destroys the locomotion cursor, bypasses movement/rotation, and makes `areControllersInUse()` false while keeping the system scheduled for bridge bookkeeping.

## Strategies attempted and their disposition

| Strategy | Why it was tried | Result or lesson | Current disposition |
| --- | --- | --- | --- |
| Keep video and Flubber in one immersive activity | Test the theory that Meta permits only one joystick-owning app | Correct architecture; no second app or OpenXR session exists | Retained and required |
| Make controller-model visibility configurable | Preserve controller pose/pointer feedback and allow studies to hide the models | Useful presentation option, but model animation is not proof of button delivery | Retained as `showControllerModels` |
| Add an optional numerical Flubber readout | Make the actual displayed affect coordinates visible without relying on inconsistent button-model articulation | Shows only current `X` (valence) and `Y` (arousal), each in `[-1,1]`, directly in the headset | Retained as `vr.flubber.showAffectValues`, plus a transient Ready-screen override; disabled by default |
| Treat the visible controller/laser as proof of input | The ray changed color when the wearer moved the stick | Insufficient; shell/ISDK pointer feedback does not prove affect-engine delivery | Rejected as acceptance evidence |
| Read Spatial `Controller.buttonState` | Follow Meta's public controller component and sample patterns | Provides directional thumb bits on supported runtime paths | Retained as primary physical route |
| Merge `buttonState` with `directTouchButtonState` | Avoid dropping state exposed through direct-touch representation | Broadens valid controller-state observation without raw device access | Retained |
| Resolve the selected hand before fallback | The wearer uses the right controller and unrelated entities can exist | Prevents left/right ambiguity and stale fallback entities from owning the mapping | Retained: local attachment → player avatar → bounded all-controller fallback |
| Register polling as a late Spatial feature | Early polling can run before avatar/controller entities exist | Matches the working MesmerPrism lifecycle and produces stable controller inventories | Retained |
| Explicitly select the Interaction SDK backend | Relying on implicit/default input initialization left routing ambiguous | Establishes the intended pointer/controller system in the one activity | Retained |
| Observe `PointerEvent.scrollInfo` | Some Spatial/ISDK paths reserve the stick for pointer scrolling instead of updating public thumb bits | Provides a hand-checked physical fallback when scroll events are delivered | Retained as secondary route with short freshness window |
| Use `VrActivity.pinGameController` | Spatial SDK exposes a public Android joystick/gamepad delivery route | Useful when a controller is surfaced as an Android input device; not assumed for every Touch runtime | Retained as tertiary compatibility route |
| Enumerate already-connected joystick/gamepad devices before pinning | SDK listener code observed add/change callbacks but did not seed devices already connected before activity creation | Closes the initialization gap for compatible Android devices | Retained using SDK-like source masks only |
| Read generic Android activity motion events | Provide compatibility when the device is delivered to `dispatchGenericMotionEvent` | Bounded fallback; pinned devices remain owned by `VrActivity` | Retained without privileged input access |
| Add route/status text inside the app | A moving laser and static controller model were misleading | Makes the selected hand, source, and normalized X/Y visible to the wearer/operator | Retained |
| Add detailed app-owned log markers | Needed to locate the break between SDK input, engine target, smoothing, and canvas | Enables deterministic route-by-route diagnosis and readiness gates | Retained |
| Add a debug joystick CLI/broadcast | Separate internal engine/render correctness from physical Touch delivery | Proves diagnostic command → `AffectEngine` → Flubber draw; cannot prove Touch input | Retained in debuggable builds only, protected by `android.permission.DUMP` |
| Depend on Android panel focus | Conventional Android input often targets a focused view | Wrong boundary for this app; Flubber input must survive countdown/playback/pause and no panel focus | Rejected; visibility/lifetime gates input instead |
| Depend on LSL or playback state | Controller sampling was initially discussed alongside experiment start | Would make the tracker unresponsive at Ready/countdown/pause | Rejected; LSL sampling and video state are independent |
| Assume `VRFeature(..., false, ...)` disables locomotion | The Boolean looked like a simple locomotion switch | Incorrect; it is `shouldConsumeLeftRightInput`, so teleport/world movement remained | Rejected |
| Unregister `LocomotionSystem` | Stop the newly observed teleport ray and scene motion | Removed locomotion but also disrupted the ISDK bridge lifecycle; physical response regressed | Rejected and guarded by source tests |
| Keep `LocomotionSystem` registered and call `enableLocomotion(false)` | Disable locomotion behavior without deleting the shared ISDK handoff object | Bytecode and host policy tests support the lifecycle; exact APK installed | Current correction; physical acceptance pending |
| Reassert `Disabled` during late polling | Protect against lifecycle/system code re-enabling locomotion | Maintains the no-locomotion invariant adjacent to controller sampling | Retained |
| Inspect or inject `/dev/input` | Considered while isolating whether Android saw the device | Privileged/raw input would violate the intended SDK boundary and still would not prove OpenXR/Touch semantics | Not implemented |
| Synthesize ADB input as Touch evidence | Fast way to exercise the app while unattended | Synthetic input is not Meta Touch/OpenXR parity | Explicitly excluded from acceptance |

## Current implementation

### One owner, three physical routes

All accepted input is normalized and sent to the activity-owned `AffectEngine` in this priority order:

1. `spatial_standard_system`: selected-hand Spatial `Controller` thumb-direction state;
2. `spatial_isdk_scroll`: fresh, hand-matched `PointerEvent.scrollInfo`;
3. `diagnostic_cli`: debug-only internal-pipeline diagnosis;
4. `spatial_vractivity_game_controller`: pinned or directly dispatched Android joystick axes;
5. neutral when none is active.

The diagnostic route is below both native Spatial routes but currently precedes the tertiary Android compatibility route for its bounded lifetime. Do not send a diagnostic command during physical acceptance because it could temporarily mask that Android fallback. Each route uses the same dead-zone, input-mode, target, smoothing, palette, Flubber geometry, canvas, and LSL marker logic.

### Selected-hand resolution

`TouchControllerAdapter.capture(scene)` resolves state in this order for each hand:

1. the hand's local controller attachment;
2. the corresponding player-avatar controller/hand;
3. a bounded all-controller fallback.

The app records the selected source in `controller_inventory` and uses the session's `vr.controls.stick` value to choose the left or right state. New/omitted settings default to the right controller after wearer clarification; explicit left mappings remain supported. The `LocomotionControls.Right` constructor argument is not the experiment's stick-selection authority; locomotion is disabled and JSON remains the mapping authority.

### Locomotion invariant

Startup must produce:

```text
controller_owner activity=affect_tracker input_system=interaction_sdk locomotion_registered=true locomotion_enabled=false locomotion_state=Disabled locomotion_claims_controllers=false input_bridge=retained polling_phase=late_feature
```

The activity fails startup if the system is not disabled or still claims controllers. The late poll calls `enableLocomotion(false)` again if a later lifecycle transition changes the state. Do not replace this with `unregisterSystem<LocomotionSystem>()` without a new SDK-level proof and an attended regression run.

### Optional controller-follow placement

The same selected-hand controller query also retains live world-space poses for both local Touch attachments, with player-avatar pose fallback. `vr.flubber.controllerFollow` can independently choose either hand (left by default) and `0.05–0.6 m` spacing. While enabled, the activity places Flubber in front of that controller, between it and the wearer on the viewer-to-controller ray, and recomputes full viewer-facing orientation every scene tick. It emits acquired/lost tracking edges and one measured-movement receipt after 2 cm. It does not change joystick ownership or affect routing.

Controller-follow, ordinary world dragging, and A-button gaze recentering must not write the same transform concurrently. Follow mode therefore becomes the sole placement authority; the registered panel's `Grabbable` is disabled and A recenter is unavailable until a profile with follow disabled is loaded. Passthrough is orthogonal and remains compositor-owned.

The headset Ready screen exposes per-run **Mixed reality passthrough**, **Flubber-only passthrough**, and **Track Flubber near a controller** switches plus explicit left/right follow selection and a followed-controller visibility switch. They are applied by copying only the armed in-memory session. Flubber-only mode omits video entity creation and decoding while keeping passthrough, Flubber, input, and LSL in the same activity. Per-hand model visibility is reapplied independently from the `Controller` component, so hiding the model cannot disable tracking or affect input. Follow mode keeps the immersive window awake and the late controller poll active; physical Touch-controller sleep remains firmware-controlled. The admitted manifest, media files, and staged fingerprint remain unchanged. `launcher_runtime_options` records the effective selection before LSL startup and immersive launch.

### Controller-to-Flubber receipt chain

A valid physical acceptance receipt must contain all relevant links, not merely one input-looking event:

```text
controller_owner ... locomotion_state=Disabled ... input_bridge=retained
controller_inventory ... right_source=...
controller_button_state ... right=0x...             # standard route
isdk_scroll_input ... selected=right accepted=true  # ISDK route, alternative
spatial_game_controller_motion ... selected=right   # Android route, alternative
joystick_source route=<physical route>
joystick_input direction=<left|right|up|down>
flubber_input_response route=<same physical route> current_valence=... current_arousal=... target_valence=... target_arousal=...
```

The Flubber response marker is emitted only after the Android drawing surface reports a changed affect draw relative to the armed baseline. It therefore closes the route from input to engine to visible renderer. A foreground process, controller entity, laser-color change, or entity-created marker alone does not pass.

## Tests and diagnostics added

### Pure/source tests

- `test/vr-controller-ownership.test.js` prevents reintroducing locomotion unregistration and verifies setup ordering plus the readiness marker.
- `LocomotionPolicyTest.kt` loads the pinned SDK classes and verifies that `enableLocomotion(false)` produces `Disabled` and does not claim controllers.
- `TouchControllerInputTest.kt` covers hand-specific direction mapping, attachment/avatar/fallback merging, diagonal input, dead zones, and ISDK scroll normalization.
- `AffectTelemetryTextTest.kt` verifies the locale-stable bounded current `X`/`Y` pair, 10 Hz throttling, and session reset.
- Session tests validate `left`/`right` mappings, controller button uniqueness, `showControllerModels`, optional `showAffectValues`, `dark`/`passthrough`, and the controller-follow object/defaults.

### Debug CLI

For a debuggable installed APK with the immersive activity alive:

```powershell
.\tools\affect-vr.ps1 status -DeviceSerial <serial>
.\tools\affect-vr.ps1 joystick -Direction up -DurationMs 900 -DeviceSerial <serial>
.\tools\affect-vr.ps1 verify-reactivity -Direction right -DeviceSerial <serial>
```

`verify-reactivity` passes only after it observes the command ID in a changed Flubber draw receipt. It proves the internal joystick → engine → canvas pipeline. It does not prove the physical Touch route, controller focus, hand selection, or absence of locomotion.

### Hierarchical device gate

`vr/verify-readiness.ps1` deliberately separates:

1. shared contract and renderer tests;
2. locked Kotlin/Rust build, lint, and APK inspection;
3. exact-artifact install and installed-byte readback;
4. Ready/session/render checks;
5. attended physical stick and transparent-panel grab checks;
6. bounded performance/soak evidence.

This prevents repeatedly recompiling the APK while diagnosing a headset-only input issue and prevents a synthetic or host-only pass from being mistaken for physical readiness.

## Verification completed for the current correction

- Shared Node suite: 86/86 passed.
- Native Rust LSL schema test: passed.
- Android/Kotlin unit tests: 34/34 passed.
- Direct pinned-SDK locomotion policy test: passed.
- Android lint: passed.
- Locked offline debug build: passed.
- APK identity, permission, ABI, and admission inspection: passed.
- Exact APK installed through QuestIonAble File Manager.
- Installed-byte hash and size matched the host-admitted artifact.
- Installed APK SHA-256: `67f44903c1d90a840a5324e6ae035a657a2b6a8969bed9b21c362f59dca5e492`.
- App-owned launcher evidence reached `launcher_rendered`, `launcher_controls_rendered mixed_reality=true controller_follow=true follow_hand_selector=true`, and revalidated the existing headset session as `session_ready`. This proves the newly installed process contains the Ready-screen controls and that optional JSON fields remain backward-compatible when omitted. No fatal runtime entry was present.

The APK launcher was started for bounded loader/readiness diagnosis, but the experiment itself was not started unattended because physical Touch acceptance requires a wearer. No raw device log, headset serial, private machine path, or APK binary is committed to Git.

## Remaining attended acceptance check

The controller goal remains open until a real Touch-controller run proves all of the following in one immersive session using the exact installed APK:

1. Put on the headset, launch Affect Tracker VR, select the admitted session, and press **Start experiment**.
2. Confirm the controller model remains spatially tracked and its pointer/trigger can interact. Do not require Meta Home-style button articulation as the evidence standard.
3. Confirm the status panel names the configured right or left Touch source and initially reports neutral X/Y.
4. During countdown, sweep the configured physical stick left/right/up/down and diagonally. Confirm the status X/Y and Flubber both respond.
5. Repeat the sweep during video playback.
6. Pause the whole session and repeat the sweep; Flubber input must remain live while the engine/video pause policy remains internally consistent.
7. Throughout the complete sweep, confirm there is no teleport ray/cursor, teleport, snap-turn, or video/world movement.
8. Confirm the maximum Flubber outline and optional X/Y line fit inside the tight panel without clipping or an oversized invisible target.
9. Point at the center, each visually empty quadrant, and all four corners of the transparent Flubber panel. Hold either trigger, move the panel laterally and in depth by at least 2 cm, and release.
10. Look away from Flubber and press an unassigned A button. Confirm Flubber moves to the current gaze center without changing its distance.
11. Preserve the app-owned controller-source receipt, input edge, changed target/current affect values, post-input canvas draw receipt, grab start/move/end markers, and gaze-recenter marker.
12. Exit and relaunch the immersive activity once after the pass and reject any `DataModel` assertion, entity teardown race, or native exception.

For a second manifest with controller-follow and passthrough enabled, replace steps 9–10 with: confirm see-through around a flat video; move the configured controller laterally, vertically, and in depth by at least 2 cm; confirm Flubber follows at the configured spacing while facing the wearer; and retain `flubber_controller_follow_tracking` plus `flubber_controller_follow_moved` receipts. In this mode grab and A recenter are deliberately inactive so they cannot fight the tracking transform.

If the physical stick still fails, capture the complete app-owned receipt chain before changing code. The first missing link identifies the next boundary:

- no controller inventory: controller/avatar entity lifecycle;
- inventory but no physical state/scroll/motion marker: Spatial/ISDK/Android delivery;
- physical marker but neutral `joystick_source`: route priority/freshness or hand matching;
- active route but unchanged target: `AffectEngine` input-mode/dead-zone state;
- changed target/current but no Flubber receipt: render visibility/canvas lifecycle;
- Flubber changes plus teleport/world motion: locomotion invariant regressed.

## Files future maintainers should inspect first

- `vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/AffectTrackerVrActivity.kt`
- `vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/TouchControllerSystem.kt`
- `vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/TouchControllerInput.kt`
- `vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/VrActivityGameControllerAccess.java`
- `vr/app/src/test/java/io/github/georgefejer91/affecttracker/vr/LocomotionPolicyTest.kt`
- `vr/app/src/test/java/io/github/georgefejer91/affecttracker/vr/TouchControllerInputTest.kt`
- `test/vr-controller-ownership.test.js`
- `vr/tools/affect-vr.ps1`
- `vr/verify-readiness.ps1`
- `for-ai/20-ARCHITECTURE.md`
- `for-ai/30-TESTING-AND-RELEASE.md`
- `for-ai/70-RESEARCH-PROVENANCE.md`

## Source provenance

- Meta Spatial SDK sample repository: <https://github.com/meta-quest/Meta-Spatial-SDK-Samples>
- Meta `PremiumMediaSample` immersive activity: <https://github.com/meta-quest/Meta-Spatial-SDK-Samples/blob/a46c632cb94eadce0a521dfefca458e3968b2780/PremiumMediaSample/app/src/main/java/com/meta/spatial/samples/premiummediasample/immersive/ImmersiveActivity.kt>
- Meta controller scaling sample: <https://github.com/meta-quest/Meta-Spatial-SDK-Samples/blob/a46c632cb94eadce0a521dfefca458e3968b2780/PremiumMediaSample/app/src/main/java/com/meta/spatial/samples/premiummediasample/systems/scalable/AnalogScalableSystem.kt>
- MesmerPrism Spatial controller adapter: <https://github.com/MesmerPrism/rusty-quest/blob/main/apps/spatial-vr-strobe-android/app/src/main/java/io/github/mesmerprism/rustyquest/spatial_vr_strobe/SpatialVrStrobeControllerAdapter.kt>
- Meta employee thumb-axis clarification: <https://communityforums.atmeta.com/discussions/Questions_Discussions/getting-analog-values-from-joysticks-in-spatial-sdk-native-android-app/1352334>
- Khronos OpenXR input-focus contract: <https://registry.khronos.org/OpenXR/specs/1.1/html/xrspec.html#session-running>

External patterns were independently implemented; no reference source was copied into this application. The durable source/adoption ledger is `for-ai/70-RESEARCH-PROVENANCE.md`.

## Working-state boundary

The Quest implementation, web **Export for Quest** workflow, contracts, native LSL adapter, tests, open-media catalog, and durable `for-ai/` updates belong to the Affect Tracker repository. Rusty Quest and QuestIonAble File Manager were used only as reference/deployment infrastructure and were not modified for this fix.
