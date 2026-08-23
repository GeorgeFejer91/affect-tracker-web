import test from "node:test";
import assert from "node:assert/strict";
import { cloneDefaultSettings } from "../site/src/portable-settings.js";
import { createVrSession, normalizeVrSession, vrSessionJson } from "../site/src/vr-session.js";

const HASH = "a".repeat(64);

function example(overrides = {}) {
  const result = {
    schema: "affect-tracker-vr-session",
    version: 1,
    sessionId: "study-session-001",
    video: {
      file: "stimulus.mp4",
      byteLength: 4096,
      sha256: HASH,
      projection: "flat",
      stereo: "mono",
      loop: false,
    },
    affectSettings: cloneDefaultSettings(),
    vr: {
      environment: "dark",
      flubber: { widthMeters: 0.3, distanceMeters: 1.25, horizontalOffsetMeters: 0, verticalOffsetMeters: -0.3 },
      controls: { stick: "left", resetButton: "x", pauseButton: "y", grabTrigger: "either" },
    },
  };
  if (overrides.video) Object.assign(result.video, overrides.video);
  if (overrides.vr) Object.assign(result.vr, overrides.vr);
  return result;
}

test("Quest session preserves portable settings without extending version 1", () => {
  const normalized = normalizeVrSession(example());
  assert.equal(normalized.affectSettings.version, 1);
  assert.equal(normalized.affectSettings.lsl.streamName, "AffectTracker");
  assert.equal(JSON.parse(vrSessionJson(normalized)).video.file, "stimulus.mp4");
  assert.equal(normalized.vr.controls.showControllerModels, true);
  assert.equal(normalized.vr.flubber.showAffectValues, false);
});

test("Quest session accepts an optional headset affect-value readout", () => {
  const session = example();
  session.vr.flubber.showAffectValues = true;
  assert.equal(normalizeVrSession(session).vr.flubber.showAffectValues, true);
  session.vr.flubber.showAffectValues = "true";
  assert.throws(() => normalizeVrSession(session), /true or false/);
});

test("Quest session accepts an explicit controller-model visibility switch", () => {
  const visible = example();
  visible.vr.controls.showControllerModels = false;
  assert.equal(normalizeVrSession(visible).vr.controls.showControllerModels, false);
  visible.vr.controls.showControllerModels = "false";
  assert.throws(() => normalizeVrSession(visible), /true or false/);
});

test("Quest session fails closed on paths, hashes, layouts, and duplicate actions", () => {
  assert.throws(() => normalizeVrSession(example({ video: { file: "../stimulus.mp4" } })), /path/);
  assert.throws(() => normalizeVrSession(example({ video: { sha256: "ABC" } })), /SHA-256/);
  assert.throws(() => normalizeVrSession(example({ video: { projection: "guessed-360" } })), /projection/);
  const duplicate = example();
  duplicate.vr.controls.pauseButton = "x";
  assert.throws(() => normalizeVrSession(duplicate), /same controller button/);
});

test("web-selected video metadata creates the activation manifest", () => {
  const file = new File([new Uint8Array([1, 2, 3])], "trial.webm", { type: "video/webm" });
  const session = createVrSession({
    sessionId: "trial-9",
    file,
    sha256: HASH,
    projection: "equirect-180",
    stereo: "side-by-side-left-right",
    affectSettings: cloneDefaultSettings(),
  });
  assert.deepEqual(session.video, {
    file: "trial.webm",
    byteLength: 3,
    sha256: HASH,
    projection: "equirect-180",
    stereo: "side-by-side-left-right",
    loop: false,
  });
  assert.equal(session.vr.controls.stick, "right");
  assert.equal(session.vr.flubber.showAffectValues, false);
});
