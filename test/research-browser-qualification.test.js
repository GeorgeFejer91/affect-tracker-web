import test from "node:test";
import assert from "node:assert/strict";

import { RESEARCH_UI_EVENTS } from "../site/src/research/app.js";
import {
  RESEARCH_RUN_MANIFEST_SCHEMA,
  createDefaultResearchSettings,
} from "../site/src/research/contracts.js";
import { canonicalJson, canonicalSha256, sha256Hex } from "../site/src/research/canonical.js";
import { resolveAssignmentPlan } from "../site/src/research/counterbalancer.js";
import { serializeRatings } from "../site/src/research/tabular.js";
import {
  BrowserResearchRuntimeBridge,
  mergeParticipantStateRows,
} from "../site/src/research/runtime-bridge.js";
import {
  BrowserResearchWorkspace,
  probeVideoFile,
  sha256Blob,
} from "../site/src/research/workspace.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const STARTED_AT = "2026-09-03T14:30:12.482Z";
const SESSION_STEM = "P001_EF_A27_GW_HR_20260903T143012482Z_R01";

function researchManifest(overrides = {}) {
  return {
    schema: RESEARCH_RUN_MANIFEST_SCHEMA,
    version: 2,
    runId: "run-manifest-001",
    experimentId: "experiment-1",
    participantId: "P001",
    participantCode: "EF",
    age: 27,
    gender: "W",
    handedness: "R",
    attemptNumber: 1,
    sessionStem: SESSION_STEM,
    completionStatus: "completed",
    playbackMode: "browserMediaAdapters",
    playbackQualification: "browser",
    settingsSha256: HASH_A,
    assignmentPlanSha256: HASH_B,
    stimuli: [{
      kind: "workspaceFile",
      stimulusId: "video-1",
      sha256: "c".repeat(64),
      byteLength: 1_024,
      durationMs: 60_000,
      url: null,
      videoId: null,
    }],
    timing: {
      sampleRateHz: 130,
      sampleCount: 0,
      eventCount: 0,
      gapEventCount: 0,
      missedSlotCount: 0,
      startedAt: STARTED_AT,
      finalizedAt: "2026-09-03T14:40:00.000Z",
    },
    outputs: [
      { kind: "settings", fileName: "settings.snapshot.json", sha256: HASH_A, byteLength: 1, rowCount: null },
      { kind: "events", fileName: "events.jsonl", sha256: HASH_A, byteLength: 1, rowCount: null },
      { kind: "csv", fileName: "ratings.csv", sha256: HASH_A, byteLength: 1, rowCount: 0 },
    ],
    recovery: { resumed: false, sourceRunId: null, restartedStimulusIds: [] },
    build: { platform: "chrome", appVersion: "0.4.0-alpha.1", buildCommit: "qualification-test" },
    ...overrides,
  };
}

class MemoryFileHandle {
  constructor(name, file) {
    this.kind = "file";
    this.name = name;
    this.file = file;
  }

  async getFile() {
    return this.file;
  }

  async createWritable() {
    const chunks = [];
    return {
      write: async (chunk) => chunks.push(chunk),
      close: async () => {
        this.file = new File(chunks, this.name, { type: this.file?.type ?? "application/octet-stream" });
      },
      abort: async () => {},
    };
  }
}

class MemoryDirectoryHandle {
  constructor(name = "workspace") {
    this.kind = "directory";
    this.name = name;
    this.children = new Map();
  }

  async queryPermission() {
    return "granted";
  }

  async requestPermission() {
    return "granted";
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    const existing = this.children.get(name);
    if (existing?.kind === "directory") return existing;
    if (existing || !create) throw Object.assign(new Error("Missing directory"), { name: "NotFoundError" });
    const directory = new MemoryDirectoryHandle(name);
    this.children.set(name, directory);
    return directory;
  }

  async getFileHandle(name, { create = false } = {}) {
    const existing = this.children.get(name);
    if (existing?.kind === "file") return existing;
    if (existing || !create) throw Object.assign(new Error("Missing file"), { name: "NotFoundError" });
    const handle = new MemoryFileHandle(name, new File([], name));
    this.children.set(name, handle);
    return handle;
  }

  async removeEntry(name) {
    if (!this.children.delete(name)) throw Object.assign(new Error("Missing entry"), { name: "NotFoundError" });
  }

  async *entries() {
    yield* this.children.entries();
  }
}

async function createSessionDirectory(outputs, participantId, sessionStem) {
  const experiment = await outputs.getDirectoryHandle("experiment-1", { create: true });
  const participant = await experiment.getDirectoryHandle(participantId, { create: true });
  return participant.getDirectoryHandle(sessionStem, { create: true });
}

function addJsonFile(directory, name, value) {
  directory.children.set(name, new MemoryFileHandle(
    name,
    new File([typeof value === "string" ? value : JSON.stringify(value)], name, { type: "application/json" }),
  ));
}

function addTextFile(directory, name, value, type = "text/plain") {
  directory.children.set(name, new MemoryFileHandle(name, new File([value], name, { type })));
}

test("workspace manifest reconstruction accepts only strict manifests bound to their curated directories", async () => {
  const root = new MemoryDirectoryHandle();
  const workspace = new BrowserResearchWorkspace(root);
  await workspace.initialize();
  const outputs = root.children.get("outputs");

  const valid = await createSessionDirectory(outputs, "P001", SESSION_STEM);
  const settings = structuredClone(createDefaultResearchSettings());
  settings.experiment.id = "experiment-1";
  const settingsText = `${canonicalJson(settings)}\n`;
  const eventsText = "\n";
  const ratingsText = serializeRatings([], { format: "csv" });
  const manifest = researchManifest({
    settingsSha256: await canonicalSha256(settings),
    outputs: [
      { kind: "settings", fileName: "settings.snapshot.json", sha256: await sha256Hex(settingsText), byteLength: new TextEncoder().encode(settingsText).byteLength, rowCount: null },
      { kind: "events", fileName: "events.jsonl", sha256: await sha256Hex(eventsText), byteLength: new TextEncoder().encode(eventsText).byteLength, rowCount: null },
      { kind: "csv", fileName: "ratings.csv", sha256: await sha256Hex(ratingsText), byteLength: new TextEncoder().encode(ratingsText).byteLength, rowCount: 0 },
    ],
  });
  addTextFile(valid, "settings.snapshot.json", settingsText, "application/json");
  addTextFile(valid, "events.jsonl", eventsText, "application/x-ndjson");
  addTextFile(valid, "ratings.csv", ratingsText, "text/csv");
  addJsonFile(valid, "manifest.json", manifest);

  const mismatched = await createSessionDirectory(outputs, "P002", SESSION_STEM);
  addJsonFile(mismatched, "manifest.json", researchManifest());

  const malformed = await createSessionDirectory(outputs, "P003", "corrupt-session");
  addJsonFile(malformed, "manifest.json", "{not-json");

  const noManifest = await createSessionDirectory(outputs, "P004", "no-manifest");
  addJsonFile(noManifest, "receipt.txt", "not a manifest");

  const result = await workspace.listRunManifests("experiment-1");
  assert.equal(result.manifests.length, 1);
  assert.equal(result.manifests[0].runId, "run-manifest-001");
  assert.equal(result.manifests[0].participantId, "P001");
  assert.equal(Object.isFrozen(result.manifests), true);
  assert.equal(Object.isFrozen(result.manifests[0]), true);

  assert.equal(result.issues.length, 2, "identity drift and malformed JSON are isolated as separate issues");
  assert.match(result.issues[0].message, /identity does not match its curated output directory/u);
  assert.equal(result.issues[0].participantId, "P002");
  assert.match(result.issues[1].message, /not valid JSON/u);
  assert.equal(result.issues[1].participantId, "P003");

  valid.children.get("ratings.csv").file = new File([`${ratingsText}tampered`], "ratings.csv", { type: "text/csv" });
  const tampered = await workspace.listRunManifests("experiment-1");
  assert.equal(tampered.manifests.length, 0, "a receipt with changed output bytes is not a usable participant manifest");
  assert.ok(tampered.issues.some((issue) => issue.participantId === "P001" && issue.code === "artifact-size"));

  assert.deepEqual(await workspace.listRunManifests("unknown-experiment"), {
    manifests: [],
    issues: [],
  });
});

class RepresentativeDecodeVideo extends EventTarget {
  constructor({ duration = 10, frameMode = "decode" } = {}) {
    super();
    this.duration = duration;
    this.videoWidth = 1_920;
    this.videoHeight = 1_080;
    this.frameMode = frameMode;
    this.preload = "";
    this.muted = false;
    this.playsInline = false;
    this.src = "";
    this.seeks = [];
    this.decodedFrames = [];
    this.pauseCalls = 0;
    this._currentTime = 0;
  }

  get currentTime() {
    return this._currentTime;
  }

  set currentTime(value) {
    this._currentTime = value;
    this.seeks.push(value);
    queueMicrotask(() => this.dispatchEvent(new Event("seeked")));
  }

  load() {
    if (this.src) queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata")));
  }

  pause() {
    this.pauseCalls += 1;
  }

  removeAttribute(name) {
    if (name === "src") this.src = "";
  }

  requestVideoFrameCallback(callback) {
    if (this.frameMode === "never") return 1;
    const position = this.currentTime;
    this.decodedFrames.push(position);
    queueMicrotask(() => callback(0, { mediaTime: position }));
    return this.decodedFrames.length;
  }
}

test("video preflight seeks across the complete duration and requires representative decoded frames", async () => {
  const video = new RepresentativeDecodeVideo({ duration: 10 });
  const revoked = [];
  const result = await probeVideoFile(new Blob(["representative video bytes"]), {
    createObjectURL: () => "blob:qualification-video",
    revokeObjectURL: (url) => revoked.push(url),
    createVideo: () => video,
    timeoutMs: 100,
  });

  assert.equal(result.decodeVerified, true);
  assert.equal(result.videoWidth, 1_920);
  assert.equal(result.videoHeight, 1_080);
  assert.deepEqual(result.decodedPositionsSeconds, [0.25, 5, 9.75]);
  assert.deepEqual(video.seeks, result.decodedPositionsSeconds);
  assert.deepEqual(video.decodedFrames, result.decodedPositionsSeconds,
    "a seeked/metadata event is not accepted until the browser reports a decoded video frame");
  assert.equal(video.pauseCalls, 1);
  assert.deepEqual(revoked, ["blob:qualification-video"]);
});

test("video metadata and successful seeks cannot pass when decoded-frame evidence never arrives", async () => {
  const video = new RepresentativeDecodeVideo({ duration: 10, frameMode: "never" });
  const revoked = [];
  await assert.rejects(probeVideoFile(new Blob(["metadata-only bytes"]), {
    createObjectURL: () => "blob:metadata-only",
    revokeObjectURL: (url) => revoked.push(url),
    createVideo: () => video,
    timeoutMs: 5,
  }), (error) => error?.code === "decode-timeout" && /representative video frame/u.test(error.message));
  assert.equal(video.seeks.length, 1, "the first seek succeeded before decoded-frame verification failed closed");
  assert.equal(video.decodedFrames.length, 0);
  assert.equal(video.pauseCalls, 1);
  assert.deepEqual(revoked, ["blob:metadata-only"]);
});

test("participant state projection uses deterministic Active > Partial > Complete > Available precedence", () => {
  const rows = [
    { participantId: "P001", state: "Complete" },
    { participantId: "P002", state: "Partial" },
    { participantId: "P003", state: "Active" },
    { participantId: "P004", state: "Available" },
    { participantId: "P999", state: "Active" },
  ];
  const manifests = [
    { participantId: "P001", completionStatus: "partial" },
    { participantId: "P002", completionStatus: "completed" },
    { participantId: "P003", completionStatus: "partial" },
    { participantId: "P004", completionStatus: "completed" },
    { participantId: "P998", completionStatus: "partial" },
  ];
  const projected = mergeParticipantStateRows(rows, manifests, ["P001", "P002", "P003", "P004", "P005"]);
  assert.deepEqual(projected, [
    { participantId: "P001", state: "Partial" },
    { participantId: "P002", state: "Partial" },
    { participantId: "P003", state: "Active" },
    { participantId: "P004", state: "Complete" },
    { participantId: "P005", state: "Available" },
  ]);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(projected.every(Object.isFrozen), true);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class RuntimeVideo extends EventTarget {
  constructor(playback) {
    super();
    this.playback = playback;
    this.readyState = 1;
    this.currentTime = 0;
    this.hidden = true;
    this.src = "";
    this.playCalls = 0;
    this.pauseCalls = 0;
  }

  play() {
    this.playCalls += 1;
    return this.playback.promise;
  }

  pause() {
    this.pauseCalls += 1;
  }

  load() {}

  removeAttribute(name) {
    if (name === "src") this.src = "";
  }
}

class RuntimeDocument extends EventTarget {
  constructor() {
    super();
    this.baseURI = "https://example.test/research/";
    this.visibilityState = "visible";
    this.probeVideos = [];
  }

  createElement(name) {
    assert.equal(name, "video");
    const video = new RepresentativeDecodeVideo({ duration: 10 });
    this.probeVideos.push(video);
    return video;
  }
}

class RuntimeRoot extends EventTarget {
  constructor(video, workspace) {
    super();
    this.video = video;
    this.startStatus = { textContent: "" };
    this.resetReasons = [];
    this.researchUi = {
      workspace,
      resetAffect: (reason) => this.resetReasons.push(reason),
    };
  }

  querySelector(selector) {
    if (selector === "#run-video") return this.video;
    if (selector === "#start-status") return this.startStatus;
    return null;
  }
}

class RuntimeJournal {
  constructor(attempts) {
    this.attempts = attempts;
    this.closed = false;
  }

  async open() {}
  async reconcileAbandonedAttempts() { return []; }
  async listAttempts() { return this.attempts; }
  async participantStates(_experimentId, ids) {
    return ids.map((participantId) => ({ participantId, state: "Available", attempts: 0 }));
  }
  async close() { this.closed = true; }
}

class RuntimeController extends EventTarget {
  constructor() {
    super();
    this.calls = [];
    this.paused = false;
    this.safeStimulusIndex = 0;
  }

  async initialize() {
    this.calls.push(["initialize"]);
  }

  async start(input) {
    this.calls.push(["start", input]);
    return this.snapshot();
  }

  async resume(input) {
    this.calls.push(["resume", input]);
    return this.snapshot();
  }

  snapshot() {
    return {
      mode: "run",
      paused: this.paused,
      safeStimulusIndex: this.safeStimulusIndex,
      persistedSamples: 0,
      persistedEvents: 0,
    };
  }

  async startStimulus(index) {
    this.calls.push(["startStimulus", index]);
    this.paused = false;
  }

  updateAffect(input) {
    this.calls.push(["updateAffect", input]);
  }

  async pause(mediaTimeMs) {
    this.calls.push(["pause", mediaTimeMs]);
    this.paused = true;
  }

  async resumeStimulus(mediaTimeMs) {
    this.calls.push(["resumeStimulus", mediaTimeMs]);
    this.paused = false;
  }

  async interrupt(reason) {
    this.calls.push(["interrupt", reason]);
  }
}

function installDocument(documentObject) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentObject });
  return () => {
    if (prior) Object.defineProperty(globalThis, "document", prior);
    else delete globalThis.document;
  };
}

async function runtimeHarness({ attemptFactory = () => [], playback = deferred() } = {}) {
  const media = new File(["runtime qualification video"], "video-one.mp4", { type: "video/mp4" });
  const digest = await sha256Blob(media);
  const settings = structuredClone(createDefaultResearchSettings());
  settings.experiment.participantCount = 1;
  settings.stimuli.items = [{
    stimulusId: "video-1",
    title: "Video One",
    source: {
      kind: "workspaceFile",
      relativePath: "stimuli/video-one.mp4",
      mimeType: "video/mp4",
      sha256: digest,
      byteLength: media.size,
      durationMs: 10_000,
    },
  }];
  settings.stimuli.pools = [{
    poolId: "all-videos",
    label: "All videos",
    videosPerParticipant: 1,
    stimulusIds: ["video-1"],
  }];
  const plan = await resolveAssignmentPlan(settings);
  const settingsSha256 = HASH_A;
  const attempts = attemptFactory({ settings, plan, settingsSha256 });
  const workspace = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    async openStimulusFile() { return media; },
    async listRunManifests() { return { manifests: [], issues: [] }; },
    async probeOutputWriteReadiness() { return { writeReady: true }; },
  };
  const runtimeVideo = new RuntimeVideo(playback);
  const runtimeDocument = new RuntimeDocument();
  const restoreDocument = installDocument(runtimeDocument);
  const root = new RuntimeRoot(runtimeVideo, workspace);
  const journal = new RuntimeJournal(attempts);
  const controller = new RuntimeController();
  let leaseReleased = false;
  const revokedUrls = [];
  const bridge = new BrowserResearchRuntimeBridge(root, {
    journal,
    controllerFactory: () => controller,
    workerProbe: async () => true,
    storageProbe: async ({ requiredBytes }) => ({
      usageBytes: 1_024,
      quotaBytes: 1_000_000_000,
      availableBytes: 999_998_976,
      requiredBytes,
      sufficient: true,
      persisted: true,
      persistenceRequested: false,
    }),
    leaseFactory: async () => ({ release() { leaseReleased = true; } }),
    createObjectURL: () => "blob:runtime-video",
    revokeObjectURL: (url) => revokedUrls.push(url),
    documentObject: runtimeDocument,
    windowObject: new EventTarget(),
    now: () => "2026-09-03T14:30:12.482Z",
  });
  await bridge.initialize();
  const startDetail = {
    participantId: "P001",
    participant: { participantCode: "EF", age: 27, gender: "W", handedness: "R" },
    settings,
    resolvedPlan: plan,
    settingsSha256,
    preflight: {
      inputTestPassed: true,
      verifiedStimulusIds: ["video-1"],
      directoryPermission: true,
      indexedDbReady: true,
      timingWorkerReady: true,
      storageReady: true,
      manifestReady: true,
    },
    outputFormats: { csv: true, tsv: false },
  };
  return {
    bridge,
    controller,
    journal,
    playback,
    plan,
    root,
    runtimeDocument,
    runtimeVideo,
    settings,
    startDetail,
    revokedUrls,
    get leaseReleased() { return leaseReleased; },
    destroy() {
      bridge.destroy();
      restoreDocument();
    },
  };
}

function recoverableAttempt({ settings, plan, settingsSha256 }) {
  return {
    runId: "run-recovery-002",
    experimentId: settings.experiment.id,
    participantId: "P001",
    attemptNumber: 2,
    status: "partial",
    recoverable: true,
    settingsHash: settingsSha256,
    planHash: plan.planHashSha256,
    context: {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      settings,
      plan,
    },
  };
}

function dispatchRequest(root, type, detail) {
  const event = new CustomEvent(type, { detail, cancelable: true });
  root.dispatchEvent(event);
  return event;
}

test("new-attempt disposition preserves a compatible partial and sampling waits for play before buffering gates", { concurrency: false }, async () => {
  const harness = await runtimeHarness({ attemptFactory: ({ settings, plan, settingsSha256 }) => [
    { ...recoverableAttempt({ settings, plan, settingsSha256 }), attemptNumber: 2 },
  ] });
  try {
    const startEvent = dispatchRequest(harness.root, RESEARCH_UI_EVENTS.startRequest, {
      ...harness.startDetail,
      attemptDisposition: "new-attempt",
    });
    assert.equal(startEvent.defaultPrevented, true);
    await harness.bridge.operation;

    const startCall = harness.controller.calls.find(([name]) => name === "start");
    assert.equal(startCall[1].attemptNumber, 3, "the retained partial forces a create-new attempt counter");
    assert.equal(harness.controller.calls.some(([name]) => name === "resume"), false);
    assert.equal(harness.controller.calls.some(([name]) => name === "startStimulus"), false,
      "preparing the first video must not start the sampling authority");

    dispatchRequest(harness.root, RESEARCH_UI_EVENTS.continueRequest);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.runtimeVideo.playCalls, 1);
    assert.equal(harness.controller.calls.some(([name]) => name === "startStimulus"), false,
      "sampling remains stopped while HTMLMediaElement.play() is unresolved");

    harness.playback.resolve();
    await harness.bridge.operation;
    assert.deepEqual(harness.controller.calls.filter(([name]) => name === "startStimulus"), [["startStimulus", 0]]);

    harness.runtimeVideo.currentTime = 1.25;
    harness.runtimeVideo.dispatchEvent(new Event("waiting"));
    await harness.bridge.operation;
    assert.deepEqual(harness.controller.calls.filter(([name]) => name === "pause"), [["pause", 1_250]]);

    harness.runtimeVideo.currentTime = 1.5;
    harness.runtimeVideo.dispatchEvent(new Event("playing"));
    await harness.bridge.operation;
    assert.deepEqual(harness.controller.calls.filter(([name]) => name === "resumeStimulus"), [["resumeStimulus", 1_500]]);
    const lifecycle = harness.controller.calls
      .map(([name]) => name)
      .filter((name) => ["startStimulus", "pause", "resumeStimulus"].includes(name));
    assert.deepEqual(lifecycle, ["startStimulus", "pause", "resumeStimulus"]);
    assert.equal(harness.runtimeDocument.probeVideos.length, 1);
    assert.deepEqual(harness.runtimeDocument.probeVideos[0].decodedFrames, [0.25, 5, 9.75]);
  } finally {
    harness.destroy();
  }
});

test("resume-compatible disposition resumes the newest exact-hash partial instead of allocating an attempt", { concurrency: false }, async () => {
  const harness = await runtimeHarness({ attemptFactory: ({ settings, plan, settingsSha256 }) => [
    { ...recoverableAttempt({ settings, plan, settingsSha256 }), attemptNumber: 1, runId: "run-recovery-001" },
    recoverableAttempt({ settings, plan, settingsSha256 }),
  ] });
  try {
    dispatchRequest(harness.root, RESEARCH_UI_EVENTS.startRequest, {
      ...harness.startDetail,
      attemptDisposition: "resume-compatible",
    });
    await harness.bridge.operation;
    assert.deepEqual(harness.controller.calls.filter(([name]) => name === "resume"), [
      ["resume", { runId: "run-recovery-002" }],
    ]);
    assert.equal(harness.controller.calls.some(([name]) => name === "start"), false);
    assert.equal(harness.controller.calls.some(([name]) => name === "startStimulus"), false,
      "recovery also waits at the safe boundary for an explicit Begin gesture");
    assert.equal(harness.root.resetReasons.at(-1), "attempt-start");
  } finally {
    harness.destroy();
  }
});

test("resume-compatible disposition fails closed when a retained partial has different frozen hashes", { concurrency: false }, async () => {
  const harness = await runtimeHarness({ attemptFactory: ({ settings, plan, settingsSha256 }) => [{
    ...recoverableAttempt({ settings, plan, settingsSha256 }),
    settingsHash: "f".repeat(64),
  }] });
  try {
    dispatchRequest(harness.root, RESEARCH_UI_EVENTS.startRequest, {
      ...harness.startDetail,
      attemptDisposition: "resume-compatible",
    });
    await harness.bridge.operation;
    assert.match(harness.root.startStatus.textContent, /no recoverable partial attempt compatible with the current settings and plan/u);
    assert.equal(harness.controller.calls.length, 0, "no runtime controller is created across a recovery hash mismatch");
    assert.equal(harness.runtimeVideo.playCalls, 0);
  } finally {
    harness.destroy();
  }
});

test("finalization-pending recovery bypasses media preparation and commits the terminal receipt", { concurrency: false }, async () => {
  const harness = await runtimeHarness({ attemptFactory: ({ settings, plan, settingsSha256 }) => [
    recoverableAttempt({ settings, plan, settingsSha256 }),
  ] });
  const receipt = {
    completionStatus: "completed",
    logicalPath: "outputs/video-affect-study/P001/session/",
    files: ["settings.snapshot.json", "events.jsonl", "ratings.csv", "manifest.json"],
    sampleCount: 10,
    eventCount: 8,
    settingsSha256: harness.startDetail.settingsSha256,
    assignmentPlanSha256: harness.plan.planHashSha256,
  };
  harness.controller.resume = async (input) => {
    harness.controller.calls.push(["resume", input]);
    return { ...harness.controller.snapshot(), finalizationPending: true, workerReady: false };
  };
  harness.controller.finalizePendingOutput = async () => {
    harness.controller.calls.push(["finalizePendingOutput"]);
    return receipt;
  };
  let completed = null;
  harness.root.addEventListener(RESEARCH_UI_EVENTS.runComplete, (event) => { completed = event.detail; });
  try {
    dispatchRequest(harness.root, RESEARCH_UI_EVENTS.startRequest, {
      ...harness.startDetail,
      attemptDisposition: "resume-compatible",
    });
    await harness.bridge.operation;
    assert.deepEqual(harness.controller.calls.filter(([name]) => name === "finalizePendingOutput"), [
      ["finalizePendingOutput"],
    ]);
    assert.equal(harness.controller.calls.some(([name]) => name === "startStimulus"), false);
    assert.equal(harness.runtimeVideo.playCalls, 0);
    assert.equal(harness.runtimeDocument.probeVideos.length, 0, "no local video decode/preparation runs for finalize-only recovery");
    assert.equal(completed.result, "completed");
    assert.equal(completed.output, receipt.logicalPath);
  } finally {
    harness.destroy();
  }
});

test("output finalization failure returns Setup authority with a recovery-required receipt", { concurrency: false }, async () => {
  const harness = await runtimeHarness();
  harness.controller.stopEarly = async () => {
    harness.controller.calls.push(["stopEarly"]);
    throw new Error("simulated output materialization failure");
  };
  let completed = null;
  harness.root.addEventListener(RESEARCH_UI_EVENTS.runComplete, (event) => { completed = event.detail; });
  try {
    dispatchRequest(harness.root, RESEARCH_UI_EVENTS.startRequest, {
      ...harness.startDetail,
      attemptDisposition: "new-attempt",
    });
    await harness.bridge.operation;
    dispatchRequest(harness.root, RESEARCH_UI_EVENTS.stopEarlyRequest);
    await harness.bridge.operation;
    assert.deepEqual(harness.controller.calls.filter(([name]) => name === "stopEarly"), [["stopEarly"]]);
    assert.equal(harness.bridge.controller, null, "runtime controller authority returns to Setup after the failed finalization");
    assert.equal(completed.result, "output recovery required");
    assert.match(completed.recovery, /recoverable Partial tile/u);
    assert.match(completed.error, /simulated output materialization failure/u);
  } finally {
    harness.destroy();
  }
});
