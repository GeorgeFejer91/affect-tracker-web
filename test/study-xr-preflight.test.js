import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateWebXrPreflight,
  XR_PANEL_ADAPTER_CAPABILITIES,
} from "../site/src/study-xr/index.js";

function portableStudy({ source, assetOverrides = {}, requiredCapabilities } = {}) {
  const media = source?.kind === "contentAsset"
    ? [{
        assetId: source.assetId,
        sha256: "a".repeat(64),
        byteLength: 1024,
        mimeType: "video/mp4",
        container: "mp4",
        durationMs: 10_000,
        hasAudio: true,
        projection: "flat",
        stereoLayout: "mono",
        requiredCapabilities: ["contentAddressedMedia", "flatVideo"],
        ...assetOverrides,
      }]
    : [];
  const blocks = [
    {
      type: "instruction",
      blockId: "intro",
      content: "Use the controller to continue.",
      presentation: "faceFlubberComparison",
    },
    {
      type: "questionnaire",
      blockId: "questionnaire-block",
      questionnaireId: "pre-run",
    },
    ...(source ? [{
      type: "video",
      blockId: "stimulus",
      purpose: "stimulus",
      source,
      collectAffect: true,
    }] : []),
    { type: "break", blockId: "rest", content: "Take a short break.", minimumDurationMs: 1_000 },
    { type: "completion", blockId: "done", content: "Complete." },
  ];
  return {
    schema: "affect-tracker-study",
    version: 1,
    studyId: "xr-preflight",
    revision: 1,
    title: "XR preflight fixture",
    description: "",
    requiredCapabilities: requiredCapabilities ?? ["questionnaires", "faceFlubberComparison"],
    media,
    questionnaires: [{
      questionnaireId: "pre-run",
      title: "Before the run",
      description: "",
      items: [{
        type: "acknowledgement",
        itemId: "ready",
        prompt: "I am ready.",
        required: true,
      }],
    }],
    sections: [{
      sectionId: "main",
      title: "Main",
      orderPolicy: { type: "fixed" },
      trials: [{ trialId: "trial-1", label: "Trial 1", blocks }],
    }],
  };
}

function supportedCapabilities(...extra) {
  return [
    ...XR_PANEL_ADAPTER_CAPABILITIES,
    "controllerInput",
    "durableJournal",
    ...extra,
  ];
}

test("WebXR preflight accepts a fully evidenced portable panel and media study", () => {
  const study = portableStudy({ source: { kind: "contentAsset", assetId: "asset-video" } });
  const report = evaluateWebXrPreflight(study, {
    availableCapabilities: supportedCapabilities("affectInput", "contentAddressedMedia", "flatVideo"),
    verifiedAssetIds: ["asset-video"],
    supportedMimeTypes: ["video/mp4"],
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.issues, []);
  assert.equal(report.qualification, "logicalPreflightOnly");
  assert.equal(report.physicalQuestQualified, false);
  assert.ok(report.requiredCapabilities.includes("controllerInput"));
  assert.ok(report.requiredCapabilities.includes("durableJournal"));
  assert.ok(report.requiredCapabilities.includes("affectInput"));
  assert.deepEqual(report.supportedMimeTypes, ["video/mp4"]);
  assert.equal(Object.isFrozen(report), true);
});

test("preflight rejects the browser-only YouTube exception for WebXR", () => {
  const study = portableStudy({
    source: { kind: "youtube", videoId: "example", startMs: 0, endMs: 10_000 },
  });
  const report = evaluateWebXrPreflight(study, {
    availableCapabilities: supportedCapabilities("affectInput"),
  });

  assert.equal(report.ok, false);
  assert.ok(report.issues.some(({ code }) => code === "youtubePagesOnly"));
});

test("preflight reports storage, controller, questionnaire, and presentation capability gaps", () => {
  const report = evaluateWebXrPreflight(portableStudy(), { availableCapabilities: [] });
  const missing = report.issues
    .filter(({ code }) => code === "missingCapability")
    .map(({ capability }) => capability);

  for (const capability of [
    "durableJournal",
    "immersivePanels",
    "controllerInput",
    "questionnaires",
    "faceFlubberComparison",
  ]) {
    assert.ok(missing.includes(capability), capability);
  }
});

test("content assets require hash binding and observed MIME playback support", () => {
  const study = portableStudy({ source: { kind: "contentAsset", assetId: "asset-video" } });
  const capabilities = supportedCapabilities("affectInput", "contentAddressedMedia", "flatVideo");
  const unobserved = evaluateWebXrPreflight(study, {
    availableCapabilities: capabilities,
  });
  assert.ok(unobserved.issues.some(({ code }) => code === "assetNotVerified"));
  assert.ok(unobserved.issues.some(({ code }) => code === "mediaSupportUnverified"));

  const unsupported = evaluateWebXrPreflight(study, {
    availableCapabilities: capabilities,
    verifiedAssetIds: { "asset-video": { verified: true } },
    supportedMimeTypes: ["video/webm"],
  });
  assert.ok(unsupported.issues.some(({ code, mimeType }) => (
    code === "unsupportedMimeType" && mimeType === "video/mp4"
  )));
});

test("preflight rejects unsupported projection and stereo variants instead of skipping them", () => {
  const study = portableStudy({
    source: { kind: "contentAsset", assetId: "asset-video" },
    assetOverrides: { projection: "cubemap", stereoLayout: "anaglyph" },
  });
  const report = evaluateWebXrPreflight(study, {
    availableCapabilities: supportedCapabilities("affectInput", "contentAddressedMedia"),
    verifiedAssetIds: ["asset-video"],
    supportedMimeTypes: ["video/mp4"],
  });

  assert.equal(report.ok, false);
  assert.ok(report.issues.some(({ code }) => code === "unsupportedProjection"));
  assert.ok(report.issues.some(({ code }) => code === "unsupportedStereoLayout"));
});

test("preflight rejects unprojectable question types and broken references", () => {
  const study = portableStudy();
  study.questionnaires[0].items[0].type = "freeText";
  study.questionnaires[0].title = "A title that cannot fit the bounded immersive heading. ".repeat(12);
  study.sections[0].trials[0].blocks.splice(1, 0, {
    type: "questionnaire",
    blockId: "missing-questionnaire-block",
    questionnaireId: "missing-questionnaire",
  });
  const report = evaluateWebXrPreflight(study, {
    availableCapabilities: supportedCapabilities(),
  });

  assert.ok(report.issues.some(({ code }) => code === "unsupportedQuestionType"));
  assert.ok(report.issues.some(({ code }) => code === "missingQuestionnaire"));
  assert.ok(report.issues.some(({ code, path }) => code === "panelProjection" && path.endsWith(".title")));
});
