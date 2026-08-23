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
