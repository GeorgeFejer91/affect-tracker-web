import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const activity = readFileSync(
  new URL(
    "../vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/AffectTrackerVrActivity.kt",
    import.meta.url,
  ),
  "utf8",
);
const launcher = readFileSync(
  new URL(
    "../vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/AffectTrackerLauncherActivity.kt",
    import.meta.url,
  ),
  "utf8",
);
const telemetry = readFileSync(
  new URL(
    "../vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/AffectTelemetryText.kt",
    import.meta.url,
  ),
  "utf8",
);
const loader = readFileSync(
  new URL(
    "../vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/SessionLoader.kt",
    import.meta.url,
  ),
  "utf8",
);
const panelLayout = readFileSync(
  new URL(
    "../vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/FlubberPanelLayout.kt",
    import.meta.url,
  ),
  "utf8",
);
const webIndex = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const androidManifest = readFileSync(
  new URL("../vr/app/src/main/AndroidManifest.xml", import.meta.url),
  "utf8",
);

test("Quest keeps the ISDK input bridge scheduled while disabling its locomotion behavior", () => {
  const superCreate = activity.indexOf("super.onCreate(savedInstanceState)");
  const findLocomotion = activity.indexOf("systemManager.findSystem<LocomotionSystem>()");
  const disableLocomotion = activity.indexOf("it.enableLocomotion(false)", findLocomotion);
  const inputObserver = activity.indexOf("systemManager.findSystem<IsdkSystem>()");

  assert.ok(superCreate >= 0, "Spatial activity lifecycle must initialize first");
  assert.ok(findLocomotion > superCreate, "VRFeature must register the shared input bridge first");
  assert.ok(disableLocomotion > findLocomotion, "locomotion behavior must then be disabled");
  assert.ok(inputObserver > disableLocomotion, "controller input remains initialized after disabling locomotion");
  assert.match(activity, /VrInputSystemType\.INTERACTION_SDK/);
  assert.match(activity, /TouchControllerPollingFeature\(::pollSpatialControllers\)/);
  assert.match(
    activity,
    /locomotion_registered=true locomotion_enabled=false locomotion_state=Disabled/,
  );
  assert.match(activity, /locomotion_claims_controllers=false input_bridge=retained polling_phase=late_feature/);
  assert.match(activity, /check\(!it\.areControllersInUse\(\)\)/);
  assert.match(activity, /locomotionInputBridge\.locomoteState != LocomoteState\.Disabled/);
  assert.doesNotMatch(activity, /unregisterSystem<LocomotionSystem>/);
});

test("Quest exposes a per-run two-coordinate affect readout without making model animation authoritative", () => {
  assert.match(launcher, /Text\("Show X\/Y affect coordinates"\)/);
  assert.match(launcher, /putExtra\(AffectTrackerVrActivity\.EXTRA_SHOW_AFFECT_VALUES, showAffectValues\)/);
  assert.match(activity, /effectiveShowAffectValues\(session\)/);
  assert.match(activity, /affect_value_readout visible=\$\{effectiveShowAffectValues\(next\.session\)\}/);
  assert.match(telemetry, /refreshNanos: Long = 100_000_000L/);
  assert.match(telemetry, /X %\+\.3f   Y %\+\.3f/);
  assert.doesNotMatch(telemetry, /target|rate|Stick/);
});

test("Quest applies one active profile and uses the registered panel's complete surface", () => {
  assert.match(loader, /session\.withRuntimeProfile\(it\.session\)/);
  assert.match(loader, /VideoChoiceSource\.ACTIVE_LAYOUT_DEFAULTS/);
  assert.match(activity, /Entity\.createPanelEntity\(\s*R\.id\.flubber_panel/);
  assert.match(activity, /PanelDimensions\(Vector2\(surfaceWidth, surfaceHeight\)\)/);
  assert.match(activity, /Grabbable\(enabled = grabEnabled, type = GrabbableType\.PIVOT_Y/);
  assert.match(activity, /manual_isdk_edge_handles=false grab_enabled=\$grabEnabled recenter_button=a/);
  assert.doesNotMatch(activity, /IsdkPanelGrabHandle/);
  assert.doesNotMatch(activity, /grabHandleCollisionWidths/);
  assert.match(panelLayout, /SURFACE_WIDTH_MULTIPLIER = 1\.15f/);
  assert.match(panelLayout, /SURFACE_HEIGHT_TO_WIDTH = 1\.12f/);
  assert.match(panelLayout, /MAX_CANONICAL_RADIUS = 3\.08f/);
});

test("Quest recenters Flubber on the current gaze ray with the free A button", () => {
  assert.match(activity, /ButtonBits\.ButtonA/);
  assert.match(activity, /isAButtonAvailableForRecenter\(staged\?\.session\)/);
  assert.match(activity, /SpatialPlacement\.gazeCenteredFlubberPose\(viewer, distance\)/);
  assert.match(activity, /flubber:recentered:a/);
  assert.match(activity, /flubber_recentered source=\$source button=a/);
});

test("Quest passthrough and controller-follow stay in the single immersive frame loop", () => {
  assert.match(webIndex, /id="quest-mixed-reality" type="checkbox"/);
  assert.match(webIndex, /id="quest-follow-controller" type="checkbox"/);
  assert.match(webIndex, /id="quest-follow-controller-hand"/);
  assert.match(androidManifest, /com\.oculus\.feature\.PASSTHROUGH/);
  assert.match(activity, /scene\.enablePassthrough\(passthrough\)/);
  assert.match(activity, /camera_frames=system_compositor_only/);
  assert.match(activity, /updateControllerFollow\(session\)/);
  assert.match(activity, /SpatialPlacement\.controllerFollowFlubberPose\(viewer, it, follow\.distanceMeters\)/);
  assert.match(activity, /flubber:controller_follow:\$state:\$\{follow\.hand\.token\}/);
  assert.match(activity, /val grabEnabled = !next\.session\.flubber\.controllerFollow\.enabled/);
  assert.match(launcher, /Text\("Mixed reality passthrough"\)/);
  assert.match(launcher, /Text\("Flubber-only passthrough"\)/);
  assert.match(launcher, /no video is decoded or shown/);
  assert.match(launcher, /Text\("Track Flubber near a controller"\)/);
  assert.match(launcher, /Text\("Show followed controller"\)/);
  assert.match(launcher, /Left is the default; Flubber faces the headset/);
  assert.match(launcher, /withLauncherRuntimeOverrides\(/);
  assert.match(launcher, /launcher_runtime_options environment=/);
  assert.match(launcher, /launcher_controls_rendered mixed_reality=true flubber_only_passthrough=true/);
  assert.match(activity, /presentation_ready mode=flubber-only passthrough=true video_prepared=false video_rendered=false/);
  assert.match(activity, /hardware_controller_sleep_control=platform/);
  assert.match(activity, /TouchControllerAdapter\.setModelVisibility/);
});
