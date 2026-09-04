import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  canonicalJson,
  canonicalSha256,
} from "../site/src/research/canonical.js";
import {
  INPUT_PRESET_IDS,
  RESEARCH_EVENT_SCHEMA,
  RESEARCH_RUN_MANIFEST_SCHEMA,
  RESEARCH_SAMPLE_SCHEMA,
  createDefaultResearchSettings,
  createInputBindingPreset,
  importPortableSettingsV1,
  validateInputBindingV1,
  validateResearchEventV1,
  validateResearchRunManifestV2,
  validateResearchSampleV1,
  validateResearchSettingsV1,
  validateStimulusV1,
} from "../site/src/research/contracts.js";

const digest = "a".repeat(64);
const planDigest = "b".repeat(64);
const localIdentity = Object.freeze({
  kind: "workspaceFile",
  stimulusId: "calm-01",
  sha256: "c".repeat(64),
  byteLength: 1024,
  durationMs: 60_000,
  url: null,
  videoId: null,
});

function sample(overrides = {}) {
  return {
    schema: RESEARCH_SAMPLE_SCHEMA,
    version: 1,
    sequence: 1,
    runId: "run-001",
    participantId: "P001",
    attemptNumber: 1,
    settingsSha256: digest,
    assignmentPlanSha256: planDigest,
    stimulusPosition: 1,
    stimulusIdentity: structuredClone(localIdentity),
    wallTimeUtc: "2026-09-03T14:30:12.482Z",
    monotonicTimeNs: "123456789",
    lslTimeSeconds: null,
    sampleRateHz: 130,
    scheduledElapsedMs: 100,
    observedElapsedMs: 100.4,
    schedulerLatenessMs: 0.4,
    schedulerJitterMs: -0.1,
    stateAnchorAgeMs: 1.2,
    missedSlotsBefore: 0,
    mediaTimeMs: 100,
    currentValence: 0.1,
    currentArousal: -0.2,
    targetValence: 0.2,
    targetArousal: -0.1,
    radius: 0.2236067977,
    angleDegrees: 296.5650512,
    oscillationFrequency: 1.4,
    edgeSmoothness: 0.6,
    projectionAmplitude: 0.3,
    pulseSynchrony: 0.7,
    waveSizeVariation: 0.32,
    saturation: 0.2236067977,
    animationActive: true,
    inputActive: false,
    inputKind: "digital",
    feedbackVisible: true,
    ...overrides,
  };
}

test("canonical JSON sorts object keys, preserves array order, and hashes exact UTF-8 bytes", async () => {
  const value = { z: [3, { b: -0, a: "é" }], a: true };
  const expected = '{"a":true,"z":[3,{"a":"é","b":0}]}';
  assert.equal(canonicalJson(value), expected);
  assert.equal(
    await canonicalSha256(value),
    createHash("sha256").update(expected, "utf8").digest("hex"),
  );
  assert.throws(() => canonicalJson({ bad: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalJson({ bad: undefined }), /cannot represent/);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => canonicalJson(cycle), /circular/);
});

test("ResearchSettingsV1 defaults encode the fixed Research decisions and reject unknown fields", () => {
  const settings = createDefaultResearchSettings();
  assert.equal(settings.experiment.samplingFrequencyHz, 130);
  assert.equal(settings.stimuli.conditionOrder, "williams");
  assert.equal(settings.stimuli.allocationAlgorithm, "balanced-v1");
  assert.equal(settings.input.preset, "arrowKeys");
  assert.equal(settings.input.stepSize, 0.1);
  assert.equal(settings.output.csv, true);
  assert.equal("continuousRating" in settings.experiment, false);
  assert.equal("singleSummaryRating" in settings.experiment, false);
  assert.deepEqual(validateResearchSettingsV1(structuredClone(settings)), settings);

  const unknown = structuredClone(settings);
  unknown.visual.flubber.haloColor = "#ffffff";
  assert.throws(() => validateResearchSettingsV1(unknown), /unknown field haloColor/);
  const noOutput = structuredClone(settings);
  noOutput.output = { csv: false, tsv: false };
  assert.throws(() => validateResearchSettingsV1(noOutput), /requires CSV/);
  const invalidRate = structuredClone(settings);
  invalidRate.experiment.samplingFrequencyHz = 241;
  assert.throws(() => validateResearchSettingsV1(invalidRate), /1–240/);
});

test("stimulus paths reject absolute and recursively encoded traversal syntax", () => {
  const stimulus = (relativePath) => ({
    stimulusId: "safe-video",
    title: "Safe video",
    source: {
      kind: "workspaceFile",
      relativePath,
      mimeType: "video/mp4",
      sha256: digest,
      byteLength: 1,
      durationMs: 1,
    },
  });
  assert.equal(validateStimulusV1(stimulus("stimuli/pool/video.mp4")).source.relativePath, "stimuli/pool/video.mp4");
  for (const path of [
    "/stimuli/video.mp4",
    "C:/stimuli/video.mp4",
    "stimuli/%2e%2e/video.mp4",
    "stimuli/%252e%252e/video.mp4",
    "stimuli/pool%2fvideo.mp4",
    "stimuli/pool%255cvideo.mp4",
  ]) {
    assert.throws(() => validateStimulusV1(stimulus(path)), /relative|percent|unsafe/u, path);
  }
});

test("every input preset round-trips and custom digital actions reject conflicts", () => {
  const expected = {
    arrowKeys: ["keyboard:ArrowUp", "keyboard:ArrowDown", "keyboard:ArrowLeft", "keyboard:ArrowRight"],
    wasd: ["keyboard:KeyW", "keyboard:KeyS", "keyboard:KeyA", "keyboard:KeyD"],
    ijkl: ["keyboard:KeyI", "keyboard:KeyK", "keyboard:KeyJ", "keyboard:KeyL"],
    numpad: ["keyboard:Numpad8", "keyboard:Numpad2", "keyboard:Numpad4", "keyboard:Numpad6"],
    pointerGrid: ["pointerAxis:x:false", "pointerAxis:y:true"],
    mouseButtonsWheel: ["wheel:up", "wheel:down", "mouseButton:2", "mouseButton:0"],
    gamepadDpad: ["gamepadButton:12", "gamepadButton:13", "gamepadButton:14", "gamepadButton:15"],
    gamepadLeftStick: ["gamepadAxis:0:false", "gamepadAxis:1:true"],
    gamepadRightStick: ["gamepadAxis:2:false", "gamepadAxis:3:true"],
  };
  const signature = (token) => token.kind === "keyboard" ? `keyboard:${token.code}`
    : token.kind === "mouseButton" || token.kind === "gamepadButton" ? `${token.kind}:${token.button}`
      : token.kind === "wheel" ? `wheel:${token.direction}`
        : token.kind === "pointerAxis" ? `pointerAxis:${token.axis}:${token.invert}`
          : `gamepadAxis:${token.index}:${token.invert}`;
  for (const id of INPUT_PRESET_IDS) {
    const binding = createInputBindingPreset(id);
    assert.equal(validateInputBindingV1(structuredClone(binding)).preset, id);
    assert.equal(binding.kind === "digital" ? binding.stepSize : null, binding.stepSize);
    const tokens = binding.kind === "digital"
      ? ["up", "down", "left", "right"].map((direction) => binding.directions[direction])
      : [binding.axes.x, binding.axes.y];
    assert.deepEqual(tokens.map(signature), expected[id]);
  }
  const custom = structuredClone(createInputBindingPreset("wasd", 0.25));
  custom.preset = "custom";
  assert.equal(validateInputBindingV1(custom).stepSize, 0.25);
  custom.directions.down = structuredClone(custom.directions.up);
  assert.throws(() => validateInputBindingV1(custom), /unique physical action/);
});

test("sample and event contracts bind settings, plan, and exact stimulus identity", () => {
  const normalized = validateResearchSampleV1(sample());
  assert.equal(normalized.stimulusIdentity.sha256, "c".repeat(64));
  assert.equal(normalized.lslTimeSeconds, null);
  assert.throws(() => validateResearchSampleV1({ ...sample(), surprise: 1 }), /unknown field surprise/);
  assert.throws(() => validateResearchSampleV1(sample({ mediaTimeMs: 60_001 })), /within 0–60000/);
  assert.throws(() => validateResearchSampleV1(sample({ observedElapsedMs: 99 })), /cannot precede/u);
  assert.throws(() => validateResearchSampleV1(sample({ schedulerLatenessMs: 1 })), /must equal observed minus scheduled/u);
  assert.throws(() => validateResearchSampleV1(sample({ radius: 0.5 })), /radius must match/u);
  assert.throws(() => validateResearchSampleV1(sample({ angleDegrees: 0 })), /angle must match/u);

  const event = {
    schema: RESEARCH_EVENT_SCHEMA,
    version: 1,
    sequence: 2,
    runId: "run-001",
    participantId: "P001",
    attemptNumber: 1,
    settingsSha256: digest,
    assignmentPlanSha256: planDigest,
    wallTimeUtc: "2026-09-03T14:30:12.490Z",
    monotonicTimeNs: "123456800",
    type: "timingGap",
    stimulusIdentity: structuredClone(localIdentity),
    stimulusPosition: 1,
    mediaTimeMs: 108,
    missedSlotCount: 2,
    detailCode: "scheduler-late",
  };
  assert.equal(validateResearchEventV1(event).missedSlotCount, 2);
  assert.throws(() => validateResearchEventV1({ ...event, missedSlotCount: null }), /requires missedSlotCount/);
  assert.throws(() => validateResearchEventV1({ ...event, type: "inputEdge" }), /Only timingGap/);
});

test("ResearchRunManifestV2 contains coded demographics but no raw-name slots", () => {
  const manifest = {
    schema: RESEARCH_RUN_MANIFEST_SCHEMA,
    version: 2,
    runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    experimentId: "video-affect-study",
    participantId: "P001",
    participantCode: "EF",
    age: 27,
    gender: "W",
    handedness: "R",
    attemptNumber: 1,
    sessionStem: "P001_EF_A27_GW_HR_20260903T143012482Z_R01",
    completionStatus: "partial",
    playbackMode: "unqualifiedWebview",
    playbackQualification: "unqualified",
    settingsSha256: digest,
    assignmentPlanSha256: planDigest,
    stimuli: [structuredClone(localIdentity)],
    timing: {
      sampleRateHz: 130,
      sampleCount: 10,
      eventCount: 4,
      gapEventCount: 1,
      missedSlotCount: 2,
      startedAt: "2026-09-03T14:30:12.482Z",
      finalizedAt: "2026-09-03T14:31:12.482Z",
    },
    outputs: [
      { kind: "settings", fileName: "settings.json", sha256: digest, byteLength: 100, rowCount: null },
      { kind: "events", fileName: "events.jsonl", sha256: digest, byteLength: 200, rowCount: null },
      { kind: "csv", fileName: "ratings.csv", sha256: digest, byteLength: 300, rowCount: 10 },
    ],
    recovery: { resumed: false, sourceRunId: null, restartedStimulusIds: [] },
    build: { platform: "tauri-windows", appVersion: "0.4.0-alpha.1", buildCommit: "34a137d" },
  };
  const normalized = validateResearchRunManifestV2(manifest);
  assert.equal(normalized.participantCode, "EF");
  assert.equal(normalized.playbackQualification, "unqualified");
  assert.equal(JSON.stringify(normalized).includes("firstName"), false);
  assert.throws(() => validateResearchRunManifestV2({
    ...manifest,
    playbackMode: "nativeLibvlc",
  }), /playback mode and qualification do not match/u);
  assert.throws(() => validateResearchRunManifestV2({ ...manifest, firstName: "Erika" }), /unknown field firstName/);
  assert.throws(() => validateResearchRunManifestV2({ ...manifest, runId: "run-001" }), /canonical UUID for Tauri Windows/u);
  for (const runId of [manifest.runId.toUpperCase(), ` ${manifest.runId}`]) {
    assert.throws(() => validateResearchRunManifestV2({ ...manifest, runId }), /runId must use its canonical lowercase identifier spelling/u);
  }
  const invalidNativeRunIds = [
    "00000000-0000-0000-0000-000000000000",
    "aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-9aaa-8aaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-4aaa-0aaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-4aaa-caaa-aaaaaaaaaaaa",
  ];
  for (const runId of invalidNativeRunIds) {
    assert.throws(() => validateResearchRunManifestV2({ ...manifest, runId }), /canonical UUID for Tauri Windows/u);
  }
  for (const experimentId of [manifest.experimentId.toUpperCase(), `${manifest.experimentId} `]) {
    assert.throws(() => validateResearchRunManifestV2({ ...manifest, experimentId }), /experimentId must use its canonical lowercase identifier spelling/u);
  }
  assert.throws(() => validateResearchRunManifestV2({
    ...manifest,
    recovery: { resumed: true, sourceRunId: "run-prior", restartedStimulusIds: [] },
  }), /recovery\.sourceRunId must be a canonical UUID for Tauri Windows/u);
  const resumedNativeManifest = validateResearchRunManifestV2({
    ...manifest,
    recovery: {
      resumed: true,
      sourceRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      restartedStimulusIds: [],
    },
  });
  assert.equal(resumedNativeManifest.recovery.sourceRunId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  for (const sourceRunId of [
    resumedNativeManifest.recovery.sourceRunId.toUpperCase(),
    `${resumedNativeManifest.recovery.sourceRunId} `,
  ]) {
    assert.throws(() => validateResearchRunManifestV2({
      ...manifest,
      recovery: { resumed: true, sourceRunId, restartedStimulusIds: [] },
    }), /recovery\.sourceRunId must use its canonical lowercase identifier spelling/u);
  }
  for (const sourceRunId of invalidNativeRunIds) {
    assert.throws(() => validateResearchRunManifestV2({
      ...manifest,
      recovery: { resumed: true, sourceRunId, restartedStimulusIds: [] },
    }), /recovery\.sourceRunId must be a canonical UUID for Tauri Windows/u);
  }
  const browserManifest = validateResearchRunManifestV2({
    ...manifest,
    runId: "run-001",
    playbackMode: "browserMediaAdapters",
    playbackQualification: "browser",
    recovery: { resumed: true, sourceRunId: "run-prior", restartedStimulusIds: [] },
    build: { ...manifest.build, platform: "edge" },
  });
  assert.equal(browserManifest.runId, "run-001");
  assert.equal(browserManifest.recovery.sourceRunId, "run-prior");
  for (const runId of ["Run-001", "run-001 "]) {
    assert.throws(() => validateResearchRunManifestV2({ ...browserManifest, runId }), /runId must use its canonical lowercase identifier spelling/u);
  }
  for (const sourceRunId of ["Run-Prior", " run-prior"]) {
    assert.throws(() => validateResearchRunManifestV2({
      ...browserManifest,
      recovery: { ...browserManifest.recovery, sourceRunId },
    }), /recovery\.sourceRunId must use its canonical lowercase identifier spelling/u);
  }
});

test("portable v1 import reports every mapping, default, and discarded legacy leaf", () => {
  const legacy = {
    version: 1,
    inputMode: "step",
    stepSize: 0.2,
    continuousSpeed: 0.8,
    response: 8,
    bindings: {
      increaseValence: "key:KeyD",
      decreaseValence: "key:KeyA",
      increaseArousal: "key:KeyW",
      decreaseArousal: "key:KeyS",
      reset: "key:KeyR",
    },
    palette: { up: "#112233", down: "#223344", left: "#334455", right: "#445566" },
    overlay: { x: 120, y: 120, size: 240, opacity: 0.75, visible: true },
    lsl: {
      streamName: "LegacyState",
      streamType: "Affect",
      markerName: "LegacyMarkers",
      sampleRate: 50,
      sourceId: "legacy-source",
    },
  };
  const original = structuredClone(legacy);
  const imported = importPortableSettingsV1(legacy);
  assert.deepEqual(legacy, original, "legacy input remains unchanged");
  assert.equal(imported.settings.experiment.samplingFrequencyHz, 50);
  assert.equal(imported.settings.input.preset, "custom");
  assert.equal(imported.settings.visual.transparency, 0.25);
  assert.equal(imported.settings.advanced.lsl.enabled, false);
  assert.ok(imported.report.some(({ status, sourcePath }) => status === "discarded" && sourcePath === "overlay.x"));
  assert.ok(imported.report.some(({ status, sourcePath }) => status === "discarded" && sourcePath === "bindings.reset"));
  assert.ok(imported.report.some(({ status, targetPath }) => status === "defaulted" && targetPath === "experiment.id"));
  assert.equal(imported.report.some(({ status, targetPath }) => status === "defaulted" && targetPath.startsWith("input.directions.")), false);
  assert.equal(imported.report.some(({ status, targetPath }) => status === "defaulted" && targetPath === "input.preset"), false);
  const cyclicLegacy = { version: 1 };
  cyclicLegacy.self = cyclicLegacy;
  assert.throws(() => importPortableSettingsV1(cyclicLegacy), /not bounded plain JSON/);
});
