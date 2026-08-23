# Quest controller-input handoff

## Desired outcome

The configured Touch thumbstick must continuously drive Flubber valence on X and arousal on Y whenever the visible Flubber exists. The same stick must not activate teleport, snap-turn, or screen/world movement. Controller tracking/model presentation and pointer/trigger grabbing must remain available in the single Affect Tracker immersive activity.

## Regression sequence

1. The first Interaction SDK configuration exposed controller input to Flubber, but Meta's default locomotion system consumed the same stick for teleport and snap/world movement.
2. The Boolean passed to `VRFeature` was initially treated as a locomotion switch. Pinned 0.13.2 signatures show that it is `shouldConsumeLeftRightInput`; it does not disable locomotion.
3. Explicitly unregistering `LocomotionSystem` removed the unwanted locomotion, but the next attended run showed that joystick-driven Flubber changes and controller feedback also stopped.

## Root cause

`VRFeature.earlySystemsToRegister()` creates one `LocomotionSystem` and passes that same object to Interaction SDK as its `ExternalControllerInputHandler`. ISDK calls the bridge's `areControllersInUse()` and `setControllerInputResult(...)` methods. The scheduled locomotion system clears its per-controller result map every frame.

Unregistering the system therefore removed more than locomotion behavior in this app lifecycle: the ISDK bridge object remained referenced, but its normal frame execution/reset stopped. This can leave controller handoff state stale and starve the app's late controller poll.

Meta's [`PremiumMediaSample`](https://github.com/meta-quest/Meta-Spatial-SDK-Samples/blob/a46c632cb94eadce0a521dfefca458e3968b2780/PremiumMediaSample/app/src/main/java/com/meta/spatial/samples/premiummediasample/immersive/ImmersiveActivity.kt) demonstrates unregistering locomotion for its own system composition, while its [`AnalogScalableSystem`](https://github.com/meta-quest/Meta-Spatial-SDK-Samples/blob/a46c632cb94eadce0a521dfefca458e3968b2780/PremiumMediaSample/app/src/main/java/com/meta/spatial/samples/premiummediasample/systems/scalable/AnalogScalableSystem.kt) reads controller bits independently. Affect Tracker's physical regression shows that pattern is not sufficient for this app's ISDK handoff ordering.

## Implemented correction

- Keep the SDK-created `LocomotionSystem` registered as ISDK's input bridge.
- Immediately call its public `enableLocomotion(false)` API after Spatial feature initialization.
- Fail startup unless `locomoteState == Disabled` and `areControllersInUse() == false`.
- Reassert `Disabled` from the late controller poll if a future lifecycle change re-enables it.
- Keep Interaction SDK, `AvatarSystem`, controller models, pointer/grab input, and the existing attachment → player-avatar → bounded fallback controller reader.
- Emit an app-owned readiness marker that distinguishes “registered input bridge” from “enabled locomotion.”

Pinned 0.13.2 bytecode confirms that `Disabled` makes `areControllersInUse()` false, bypasses movement/rotation, destroys the locomotion cursor, and still allows the scheduled system to reset its controller-result map.

## Verification completed

- Shared Node suite: 80/80 passed.
- Native LSL schema test: passed.
- Android/Kotlin unit tests: passed, including a direct pinned-SDK test that verifies `enableLocomotion(false)` produces `Disabled` and does not claim controllers.
- Android lint and locked offline debug build: passed.
- APK identity/admission inspection: passed.
- Exact APK installed through QuestIonAble File Manager and installed-byte readback matched.
- Installed APK SHA-256: `ad472d6896b4c02555371141f24687f1febd58ec8aec332722652582c7d3f33d`.

The APK was installed without launching an unattended experiment because the wearer was unavailable.

## Remaining attended acceptance check

This goal is not complete until a real Touch-controller run proves all of the following in the same immersive session:

1. Start an admitted session and confirm the controller model/pointer remains tracked.
2. Sweep the configured right thumbstick left/right/up/down and diagonally during countdown, playback, and pause.
3. Confirm the in-app controller X/Y receipt changes and Flubber visibly changes valence/arousal.
4. Confirm there is no teleport arc/cursor, teleport, snap-turn, or video/world movement.
5. Confirm trigger grabbing still works anywhere on the transparent Flubber quad.
6. Preserve the app-owned `controller_button_state` or ISDK-scroll marker, the changed target/current affect values, and the post-input Flubber canvas draw receipt.

Synthetic CLI input remains useful only for joystick → engine → canvas diagnostics; it does not qualify as physical Touch evidence.

## Key files

- `vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/AffectTrackerVrActivity.kt`
- `vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/TouchControllerSystem.kt`
- `vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/TouchControllerInput.kt`
- `vr/app/src/test/java/io/github/georgefejer91/affecttracker/vr/LocomotionPolicyTest.kt`
- `test/vr-controller-ownership.test.js`
- `vr/verify-readiness.ps1`

## Working-state note

The Quest implementation, web “Export for Quest” workflow, contracts, native LSL adapter, tests, open-media catalog, and durable `for-ai/` updates were developed together as one additive VR delivery form. Existing Rusty Quest and QuestIonAble File Manager repositories were not modified.
