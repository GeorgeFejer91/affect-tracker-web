import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePortableWebXrRuntimePreflight,
  portableControllerSnapshot,
  portableStudyRunInputs,
  referencedContentAssets,
  XR_PANEL_ADAPTER_CAPABILITIES,
} from "../site/src/study-xr/index.js";

function study(blocks) {
  return {
    schema: "affect-tracker-study",
    version: 1,
    studyId: "portable-xr",
    revision: 1,
    title: "Portable XR",
    description: "",
    requiredCapabilities: ["questionnaires", "faceFlubberComparison"],
    pinnedSettings: {
      portableSettingsSha256: "a".repeat(64),
      acquisition: { sampleRateHz: 20, resetPolicy: "requireCalibration" },
      visual: {},
    },
    media: [{
      assetId: "video-1",
      sha256: "b".repeat(64),
      byteLength: 100,
      mimeType: "video/mp4",
      container: "mp4",
      durationMs: 1_000,
      hasAudio: false,
      projection: "flat",
      stereoLayout: "mono",
      requiredCapabilities: ["contentAddressedMedia", "flatVideo"],
    }],
    questionnaires: [{
      questionnaireId: "q1",
      title: "Questionnaire",
      description: "",
      items: [{ type: "acknowledgement", itemId: "ready", prompt: "Ready?", required: true }],
    }],
    sections: [{
      sectionId: "main",
      title: "Main",
      orderPolicy: { type: "seededShuffle" },
      trials: [{ trialId: "trial-1", label: "Trial", blocks }],
    }],
  };
}

const capabilities = [
  ...XR_PANEL_ADAPTER_CAPABILITIES,
  "controllerInput",
  "durableJournal",
  "affectInput",
  "contentAddressedMedia",
  "flatVideo",
];

test("portable runtime accepts panel studies and reports order/calibration inputs", () => {
  const definition = study([
    { type: "instruction", blockId: "intro", content: "Continue.", presentation: "faceFlubberComparison" },
    { type: "questionnaire", blockId: "questions", questionnaireId: "q1" },
    { type: "completion", blockId: "done", content: "Complete." },
  ]);
  const report = evaluatePortableWebXrRuntimePreflight(definition, { availableCapabilities: capabilities });
  assert.equal(report.ok, true);
  assert.equal(report.runtimeProfile, "content-asset-media-v1");
  assert.equal(report.physicalQuestQualified, false);
  assert.deepEqual(portableStudyRunInputs(definition), {
    needsRandomSeed: true,
    counterbalanceGroupCount: null,
    needsCalibration: true,
  });
});

test("verified content-addressed video is runnable while YouTube remains rejected", () => {
  const definition = study([{
    type: "video",
    blockId: "video-block",
    purpose: "stimulus",
    source: { kind: "contentAsset", assetId: "video-1" },
    collectAffect: true,
  }]);
  const report = evaluatePortableWebXrRuntimePreflight(definition, {
    availableCapabilities: capabilities,
    verifiedAssetIds: ["video-1"],
    supportedMimeTypes: ["video/mp4"],
  });
  assert.equal(report.ok, true);
  assert.ok(report.runnableBlockTypes.includes("video"));
  assert.deepEqual(referencedContentAssets(definition).map(({ assetId }) => assetId), ["video-1"]);

  definition.sections[0].trials[0].blocks[0].source = {
    kind: "youtube",
    videoId: "example",
    startMs: 0,
    endMs: 1_000,
  };
  const youtube = evaluatePortableWebXrRuntimePreflight(definition, {
    availableCapabilities: capabilities,
  });
  assert.equal(youtube.ok, false);
  assert.ok(youtube.issues.some(({ code }) => code === "youtubePagesOnly"));
});

test("portable controller snapshot maps right stick/trigger and left trigger without legacy X/Y buttons", () => {
  const snapshot = portableControllerSnapshot([
    {
      handedness: "left",
      gamepad: { axes: [0, 0], buttons: [{ pressed: true }, {}, {}, {}, { pressed: true }, { pressed: true }] },
    },
    {
      handedness: "right",
      gamepad: { axes: [0, 0, 0.8, -0.75], buttons: [{ pressed: true }] },
    },
  ]);
  assert.equal(snapshot.controllerPresent, true);
  assert.equal(snapshot.hand, "right");
  assert.ok(snapshot.x > 0);
  assert.ok(snapshot.y < 0);
  assert.equal(snapshot.select, true);
  assert.equal(snapshot.back, true);
  assert.equal("reset" in snapshot, false);
  assert.equal("pause" in snapshot, false);
});
