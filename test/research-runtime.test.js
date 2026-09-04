import test from "node:test";
import assert from "node:assert/strict";
import {
  IndexedDbResearchJournal,
  MemoryResearchJournal,
  RESEARCH_JOURNAL_DATABASE,
  ResearchJournalError,
} from "../site/src/research/browser-journal.js";
import { ResearchSamplingClock, installWorkerProtocol } from "../site/src/research/sampling-worker.js";
import {
  capturedDigitalAction,
  ResearchInputController,
  withCustomDigitalAction,
} from "../site/src/research/input-controller.js";
import {
  RESEARCH_EVENT_SCHEMA,
  RESEARCH_RUN_MANIFEST_SCHEMA,
  RESEARCH_SAMPLE_SCHEMA,
  createDefaultResearchSettings,
  createInputBindingPreset,
} from "../site/src/research/contracts.js";
import { resolveAssignmentPlan } from "../site/src/research/counterbalancer.js";
import { BrowserResearchRunController } from "../site/src/research/run-controller.js";
import {
  acquireExclusiveRuntimeLease,
  nextAttemptNumber,
  participantStateDetail,
  selectCompatibleRecovery,
} from "../site/src/research/runtime-bridge.js";
import {
  BrowserResearchWorkspace,
  isSupportedVideoName,
  normalizeWorkspaceRelativePath,
  parseStrictJson,
  parseExperimentalYouTubeUrl,
  RESEARCH_STORAGE_NAMESPACE,
  RESEARCH_WORKSPACE_DIRECTORIES,
  RESEARCH_WORKSPACE_IDENTITY_FILE,
} from "../site/src/research/workspace.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function reservation(overrides = {}) {
  return {
    runId: "run-001",
    experimentId: "experiment-1",
    participantId: "P001",
    attemptNumber: 1,
    sessionStem: "P001_EF_A27_GW_HR_20260903T143012482Z_R01",
    settingsHash: HASH_A,
    planHash: HASH_B,
    createdAt: "2026-09-03T14:30:12.482Z",
    ownerId: "tab-001",
    context: {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      participant: { participantCode: "EF", age: 27, gender: "W", handedness: "R" },
    },
    ...overrides,
  };
}

const JOURNAL_STIMULUS_IDENTITY = Object.freeze({
  kind: "workspaceFile",
  stimulusId: "video-1",
  sha256: "c".repeat(64),
  byteLength: 1024,
  durationMs: 60_000,
  url: null,
  videoId: null,
});

function sample(runId, sequence, overrides = {}) {
  return {
    schema: RESEARCH_SAMPLE_SCHEMA,
    version: 1,
    sequence,
    runId,
    participantId: "P001",
    attemptNumber: 1,
    settingsSha256: HASH_A,
    assignmentPlanSha256: HASH_B,
    stimulusPosition: 1,
    stimulusIdentity: structuredClone(JOURNAL_STIMULUS_IDENTITY),
    wallTimeUtc: "2026-09-03T14:30:13.000Z",
    monotonicTimeNs: String(sequence),
    lslTimeSeconds: null,
    sampleRateHz: 130,
    scheduledElapsedMs: sequence * 10,
    observedElapsedMs: sequence * 10,
    schedulerLatenessMs: 0,
    schedulerJitterMs: 0,
    stateAnchorAgeMs: 0,
    missedSlotsBefore: 0,
    mediaTimeMs: sequence * 10,
    currentValence: 0,
    currentArousal: 0,
    targetValence: 0,
    targetArousal: 0,
    radius: 0,
    angleDegrees: 0,
    oscillationFrequency: 0.5,
    edgeSmoothness: 0.5,
    projectionAmplitude: 0.2,
    pulseSynchrony: 0.2,
    waveSizeVariation: 0.8,
    saturation: 0,
    animationActive: true,
    inputActive: false,
    inputKind: "digital",
    feedbackVisible: true,
    ...overrides,
  };
}

function event(runId, sequence, type = "sessionStarted", overrides = {}) {
  return {
    schema: RESEARCH_EVENT_SCHEMA,
    version: 1,
    sequence,
    runId,
    participantId: "P001",
    attemptNumber: 1,
    settingsSha256: HASH_A,
    assignmentPlanSha256: HASH_B,
    wallTimeUtc: "2026-09-03T14:30:13.000Z",
    monotonicTimeNs: String(sequence),
    type,
    stimulusIdentity: null,
    stimulusPosition: null,
    mediaTimeMs: null,
    missedSlotCount: null,
    detailCode: "test-event",
    ...overrides,
  };
}

function manifest(overrides = {}) {
  return {
    schema: RESEARCH_RUN_MANIFEST_SCHEMA,
    version: 2,
    runId: "run-001",
    experimentId: "experiment-1",
    participantId: "P001",
    participantCode: "EF",
    age: 27,
    gender: "W",
    handedness: "R",
    attemptNumber: 1,
    sessionStem: "P001_EF_A27_GW_HR_20260903T143012482Z_R01",
    completionStatus: "completed",
    settingsSha256: HASH_A,
    assignmentPlanSha256: HASH_B,
    stimuli: [structuredClone(JOURNAL_STIMULUS_IDENTITY)],
    timing: {
      sampleRateHz: 130,
      sampleCount: 0,
      eventCount: 0,
      gapEventCount: 0,
      missedSlotCount: 0,
      startedAt: "2026-09-03T14:30:12.482Z",
      finalizedAt: "2026-09-03T14:40:00.000Z",
    },
    outputs: [
      { kind: "settings", fileName: "settings.snapshot.json", sha256: HASH_A, byteLength: 1, rowCount: null },
      { kind: "events", fileName: "events.jsonl", sha256: HASH_A, byteLength: 1, rowCount: null },
      { kind: "csv", fileName: "ratings.csv", sha256: HASH_A, byteLength: 1, rowCount: 0 },
    ],
    recovery: { resumed: false, sourceRunId: null, restartedStimulusIds: [] },
    build: { platform: "chrome", appVersion: "0.4.0-alpha.1", buildCommit: "test" },
    ...overrides,
  };
}

test("the browser journal namespace is isolated and never silently falls back", () => {
  assert.equal(RESEARCH_JOURNAL_DATABASE, "affect-research/v1");
  assert.throws(
    () => new IndexedDbResearchJournal({ indexedDB: null, keyRange: null }),
    (error) => error instanceof ResearchJournalError && error.code === "indexeddb-unavailable",
  );
});

test("attempt reservation is create-new and participant locks are atomic", async () => {
  const journal = new MemoryResearchJournal();
  const created = await journal.reserveAttempt(reservation());
  assert.equal(created.status, "active");
  assert.equal(created.safeStimulusIndex, 0);

  await assert.rejects(
    journal.reserveAttempt(reservation({ runId: "run-002", ownerId: "tab-002" })),
    (error) => error.code === "participant-locked",
  );
  await assert.rejects(
    journal.reserveAttempt(reservation()),
    (error) => error.code === "attempt-exists",
  );
  assert.deepEqual(await journal.participantStates("experiment-1", ["P001", "P002"]), [
    { participantId: "P001", state: "Active", attempts: 1 },
    { participantId: "P002", state: "Available", attempts: 0 },
  ]);
});

test("browser attempts and participant locks are isolated by persistent workspace identity", async () => {
  const journal = new MemoryResearchJournal();
  const workspaceA = "11111111-1111-4111-8111-111111111111";
  const workspaceB = "22222222-2222-4222-8222-222222222222";
  const context = (workspaceId) => ({
    workspaceId,
    participant: { participantCode: "EF", age: 27, gender: "W", handedness: "R" },
  });
  await journal.reserveAttempt(reservation({ context: context(workspaceA) }));
  await journal.reserveAttempt(reservation({
    runId: "run-other-workspace",
    ownerId: "tab-other-workspace",
    context: context(workspaceB),
  }));

  assert.deepEqual(await journal.participantStates("experiment-1", ["P001"], { workspaceId: workspaceA }), [
    { participantId: "P001", state: "Active", attempts: 1 },
  ]);
  assert.deepEqual(await journal.participantStates("experiment-1", ["P001"], { workspaceId: workspaceB }), [
    { participantId: "P001", state: "Active", attempts: 1 },
  ]);
  await journal.markInterrupted({
    runId: "run-001",
    reason: "workspace-a-interruption",
    updatedAt: "2026-09-03T14:31:00.000Z",
  });
  await journal.markInterrupted({
    runId: "run-other-workspace",
    reason: "workspace-b-interruption",
    updatedAt: "2026-09-03T14:31:01.000Z",
  });
  const selected = selectCompatibleRecovery(await journal.listAttempts({ experimentId: "experiment-1" }), {
    participantId: "P001",
    settingsSha256: HASH_A,
    assignmentPlanSha256: HASH_B,
    workspaceId: workspaceB,
  });
  assert.equal(selected.runId, "run-other-workspace");
  assert.equal(selected.context.workspaceId, workspaceB);
});

test("journal batches enforce independent contiguous sample and event sequences", async () => {
  const journal = new MemoryResearchJournal();
  await journal.reserveAttempt(reservation());
  const after = await journal.appendBatch({
    runId: "run-001",
    expectedSampleSequence: 1,
    expectedEventSequence: 1,
    samples: [sample("run-001", 1), sample("run-001", 2)],
    events: [event("run-001", 1)],
    updatedAt: "2026-09-03T14:30:13.000Z",
  });
  assert.equal(after.nextSampleSequence, 3);
  assert.equal(after.nextEventSequence, 2);
  assert.deepEqual((await journal.readRecords("run-001", { kind: "samples" }))
    .map((row) => row.sequence), [1, 2]);

  await assert.rejects(journal.appendBatch({
    runId: "run-001",
    expectedSampleSequence: 2,
    expectedEventSequence: 2,
    samples: [sample("run-001", 2)],
    updatedAt: "2026-09-03T14:30:14.000Z",
  }), (error) => error.code === "sequence-conflict");
});

test("journal commits completion evidence and its safe boundary in one batch", async () => {
  const journal = new MemoryResearchJournal();
  await journal.reserveAttempt(reservation());
  const after = await journal.appendBatch({
    runId: "run-001",
    expectedSampleSequence: 1,
    expectedEventSequence: 1,
    events: [event("run-001", 1, "stimulusCompleted")],
    stimulusState: { activeStimulusIndex: null, safeStimulusIndex: 1 },
    updatedAt: "2026-09-03T14:30:13.000Z",
  });
  assert.equal(after.nextEventSequence, 2);
  assert.equal(after.safeStimulusIndex, 1);
  assert.equal(after.activeStimulusIndex, null);
});

test("journal detects missing tails and non-monotonic timing against its watermark", async () => {
  const journal = new MemoryResearchJournal();
  await journal.reserveAttempt(reservation());
  await journal.appendBatch({
    runId: "run-001",
    expectedSampleSequence: 1,
    expectedEventSequence: 1,
    samples: [sample("run-001", 1), sample("run-001", 2)],
    updatedAt: "2026-09-03T14:30:13.000Z",
  });
  journal.samples.get("run-001").pop();
  await assert.rejects(
    journal.readRecords("run-001", { kind: "samples" }),
    (error) => error.code === "corrupt-record" && /watermark/u.test(error.message),
  );

  const second = new MemoryResearchJournal();
  await second.reserveAttempt(reservation());
  await second.appendBatch({
    runId: "run-001",
    expectedSampleSequence: 1,
    expectedEventSequence: 1,
    samples: [sample("run-001", 1)],
    updatedAt: "2026-09-03T14:30:13.000Z",
  });
  await assert.rejects(second.appendBatch({
    runId: "run-001",
    expectedSampleSequence: 2,
    expectedEventSequence: 1,
    samples: [sample("run-001", 2, {
      monotonicTimeNs: "0",
      scheduledElapsedMs: 5,
      observedElapsedMs: 5,
    })],
    updatedAt: "2026-09-03T14:30:14.000Z",
  }), (error) => error.code === "corrupt-record");
});

test("journal rejects contract drift and detects corrupt persisted records on read", async () => {
  const journal = new MemoryResearchJournal();
  await journal.reserveAttempt(reservation());
  await assert.rejects(journal.appendBatch({
    runId: "run-001",
    expectedSampleSequence: 1,
    expectedEventSequence: 1,
    samples: [{ ...sample("run-001", 1), unknown: true }],
    updatedAt: "2026-09-03T14:30:13.000Z",
  }), (error) => error.code === "corrupt-record");
  await journal.appendBatch({
    runId: "run-001",
    expectedSampleSequence: 1,
    expectedEventSequence: 1,
    samples: [sample("run-001", 1)],
    updatedAt: "2026-09-03T14:30:13.000Z",
  });
  journal.samples.get("run-001")[0].settingsSha256 = "d".repeat(64);
  await assert.rejects(
    journal.readRecords("run-001", { kind: "samples" }),
    (error) => error.code === "corrupt-record",
  );
  await assert.rejects(journal.finalize({
    runId: "run-001",
    status: "complete",
    manifest: { ...manifest(), extra: true },
    finalizedAt: "2026-09-03T14:40:00.000Z",
  }), (error) => error.code === "corrupt-record");
});

test("corrupt attempt records are quarantined without blocking healthy participants", async () => {
  const journal = new MemoryResearchJournal();
  await journal.reserveAttempt(reservation());
  await journal.appendBatch({
    runId: "run-001",
    expectedSampleSequence: 1,
    expectedEventSequence: 1,
    samples: [sample("run-001", 1)],
    events: [event("run-001", 1)],
    updatedAt: "2026-09-03T14:30:13.000Z",
  });
  await journal.markInterrupted({
    runId: "run-001",
    reason: "forced-termination",
    updatedAt: "2026-09-03T14:31:00.000Z",
  });
  await journal.reserveAttempt(reservation({
    runId: "run-healthy",
    participantId: "P002",
    ownerId: "tab-healthy",
    sessionStem: "P002_EF_A27_GW_HR_20260903T143100000Z_R01",
    createdAt: "2026-09-03T14:31:00.000Z",
  }));
  journal.attempts.get("run-001").unexpected = "contract drift";

  const remaining = await journal.listAttempts({ experimentId: "experiment-1" });
  assert.deepEqual(remaining.map((attempt) => attempt.runId), ["run-healthy"]);
  const quarantined = await journal.listQuarantinedRecords();
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0].runId, "run-001");
  assert.equal(quarantined[0].reasonCode, "corrupt-attempt");
  assert.match(quarantined[0].reason, /unsupported shape/u);
  assert.equal(quarantined[0].evidence.samples.length, 1);
  assert.equal(quarantined[0].evidence.events.length, 1);
  assert.equal(quarantined[0].evidence.attempt.unexpected, "contract drift");
  assert.equal(journal.samples.has("run-001"), false);
});

test("recovery contexts reject detached assignments and derive restarted stimuli from the frozen plan", async () => {
  const settings = oneVideoSettings();
  const plan = await resolveAssignmentPlan(settings);
  const baseContext = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    participant: { participantCode: "EF", age: 27, gender: "W", handedness: "R" },
    plan,
    resumed: false,
    sourceRunId: null,
    restartedStimulusIds: [],
  };
  const rejected = new MemoryResearchJournal();
  await assert.rejects(rejected.reserveAttempt(reservation({
    context: { ...baseContext, assignment: plan.assignments[0] },
  })), (error) => error.code === "invalid-record" && /detached/u.test(error.message));

  const journal = new MemoryResearchJournal();
  await journal.reserveAttempt(reservation({ context: baseContext }));
  await journal.setStimulusState({
    runId: "run-001",
    activeStimulusIndex: 0,
    safeStimulusIndex: 0,
    updatedAt: "2026-09-03T14:31:00.000Z",
  });
  await journal.markInterrupted({
    runId: "run-001",
    reason: "forced-termination",
    updatedAt: "2026-09-03T14:31:01.000Z",
  });
  const resumed = await journal.resumeAttempt({
    runId: "run-001",
    ownerId: "tab-resume",
    resumedAt: "2026-09-03T14:32:00.000Z",
  });
  assert.deepEqual(resumed.context.restartedStimulusIds, ["video-1"]);
  assert.equal(Object.hasOwn(resumed.context, "assignment"), false);
});

test("journal accepts filename-safe Unicode participant codes in a session stem", async () => {
  const journal = new MemoryResearchJournal();
  const created = await journal.reserveAttempt(reservation({
    runId: "run-unicode",
    sessionStem: "P001_ΩД_A27_GW_HR_20260903T143012482Z_R01",
  }));
  assert.match(created.sessionStem, /ΩД/u);
});

test("interruption recovers only at the last safe video boundary", async () => {
  const journal = new MemoryResearchJournal();
  await journal.reserveAttempt(reservation());
  await journal.setStimulusState({
    runId: "run-001",
    activeStimulusIndex: 2,
    safeStimulusIndex: 2,
    updatedAt: "2026-09-03T14:31:00.000Z",
  });
  const partial = await journal.markInterrupted({
    runId: "run-001",
    reason: "forced-termination",
    updatedAt: "2026-09-03T14:31:01.000Z",
  });
  assert.equal(partial.status, "partial");
  assert.equal(partial.activeStimulusIndex, null);
  assert.equal(partial.interruption.restartStimulusIndex, 2);
  assert.deepEqual(await journal.participantStates("experiment-1", ["P001"]), [
    { participantId: "P001", state: "Partial", attempts: 1 },
  ]);

  const resumed = await journal.resumeAttempt({
    runId: "run-001",
    ownerId: "tab-recovery",
    resumedAt: "2026-09-03T14:32:00.000Z",
  });
  assert.equal(resumed.status, "active");
  assert.equal(resumed.recoverable, false);
  assert.equal(resumed.safeStimulusIndex, 2);
  assert.equal(resumed.activeStimulusIndex, null);
});

test("exclusive runtime recovery converts abandoned active locks into resumable partial attempts", async () => {
  const journal = new MemoryResearchJournal();
  await journal.open();
  await journal.reserveAttempt(reservation({ runId: "run-abandoned", ownerId: "tab-gone" }));
  await journal.setStimulusState({
    runId: "run-abandoned",
    activeStimulusIndex: 2,
    safeStimulusIndex: 2,
    updatedAt: "2026-09-04T10:00:01.000Z",
  });
  const recovered = await journal.reconcileAbandonedAttempts({
    updatedAt: "2026-09-04T10:01:00.000Z",
  });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, "partial");
  assert.equal(recovered[0].recoverable, true);
  assert.equal(recovered[0].interruption.restartStimulusIndex, 2);
  assert.equal(recovered[0].interruption.interruptedStimulusIndex, 2);
  assert.equal((await journal.participantStates("experiment-1", ["P001"]))[0].state, "Partial");
});

test("complete finalization releases the lock and retains immutable evidence", async () => {
  const journal = new MemoryResearchJournal();
  await journal.reserveAttempt(reservation());
  const runManifest = manifest();
  const complete = await journal.finalize({
    runId: "run-001",
    status: "complete",
    manifest: runManifest,
    finalizedAt: "2026-09-03T14:40:00.000Z",
  });
  runManifest.completionStatus = "partial";
  assert.equal(complete.manifest.completionStatus, "completed");
  assert.deepEqual(await journal.participantStates("experiment-1", ["P001"]), [
    { participantId: "P001", state: "Complete", attempts: 1 },
  ]);

  await assert.rejects(journal.reserveAttempt(reservation({
    runId: "run-reused-attempt",
    ownerId: "tab-reused-attempt",
  })), (error) => error.code === "attempt-exists");

  const rerun = await journal.reserveAttempt(reservation({
    runId: "run-002",
    attemptNumber: 2,
    sessionStem: "P001_EF_A27_GW_HR_20260903T144500000Z_R02",
    ownerId: "tab-002",
    createdAt: "2026-09-03T14:45:00.000Z",
  }));
  assert.equal(rerun.attemptNumber, 2);
});

function createManualClock(frequencyHz = 100) {
  let now = 0;
  let wallNow = Date.parse("2026-09-03T14:30:00.000Z");
  let callback = null;
  const samples = [];
  const gaps = [];
  const clock = new ResearchSamplingClock({
    samplingFrequencyHz: frequencyHz,
    now: () => now,
    wallNow: () => wallNow,
    setTimer: (next) => {
      callback = next;
      return 1;
    },
    clearTimer: () => { callback = null; },
    onSample: (value) => samples.push(value),
    onGap: (value) => gaps.push(value),
  });
  return {
    clock,
    samples,
    gaps,
    advanceTo(value) {
      wallNow += value - now;
      now = value;
      const next = callback;
      callback = null;
      next?.();
    },
  };
}

test("sampling uses real deadlines and never fabricates catch-up rows", () => {
  const harness = createManualClock(100);
  harness.clock.updateState({
    currentValence: 0.25,
    currentArousal: -0.5,
    targetValence: 0.3,
    targetArousal: -0.4,
    animationActive: true,
    inputActive: false,
    stimulusTimeMs: 250,
    anchorMonotonicMs: 0,
    mappingValues: { saturation: 0.5 },
  });
  harness.clock.startStimulus({ stimulusIndex: 0, stimulusId: "video-1", stimulusEpoch: 1 });
  harness.advanceTo(10);
  assert.equal(harness.samples.length, 1);
  assert.equal(harness.samples[0].sequence, 1);
  assert.equal(harness.samples[0].angleDegrees, (Math.atan2(-0.5, 0.25) * 180 / Math.PI + 360) % 360);

  harness.advanceTo(52);
  assert.equal(harness.gaps.length, 1);
  assert.equal(harness.gaps[0].missedSlots, 3);
  assert.equal(harness.samples.length, 2, "one delayed deadline yields one real row, never catch-up rows");
  assert.equal(harness.samples[1].sequence, 2);
  assert.equal(harness.samples[1].scheduledMonotonicMs, 50);
  assert.equal(harness.samples[1].latenessMs, 2);
});

test("sampling stops between videos and restarts from neutral on a fresh deadline", () => {
  const harness = createManualClock(100);
  harness.clock.startStimulus({ stimulusIndex: 0, stimulusId: "video-1", stimulusEpoch: 1 });
  harness.advanceTo(10);
  harness.clock.stopStimulus();
  harness.advanceTo(500);
  assert.equal(harness.samples.length, 1);
  assert.equal(harness.gaps.length, 0);

  harness.clock.startStimulus({ stimulusIndex: 1, stimulusId: "video-2", stimulusEpoch: 2 });
  harness.advanceTo(510);
  assert.equal(harness.samples.length, 2);
  assert.equal(harness.samples[1].stimulusIndex, 1);
  assert.equal(harness.samples[1].currentValence, 0);
  assert.equal(harness.samples[1].currentArousal, 0);
  assert.equal(harness.samples[1].stimulusTimeMs, null);
});

test("sampling rejects values outside the declared 1–240 Hz range", () => {
  assert.throws(() => new ResearchSamplingClock({ samplingFrequencyHz: 0 }), /1 through 240/);
  assert.throws(() => new ResearchSamplingClock({ samplingFrequencyHz: 241 }), /1 through 240/);
  assert.doesNotThrow(() => new ResearchSamplingClock({ samplingFrequencyHz: 130 }));
});

test("sampling worker maps its local clock into the controller origin and ACKs a drained command fence", () => {
  class WorkerScope extends EventTarget {
    constructor() { super(); this.output = []; }
    postMessage(value) { this.output.push(structuredClone(value)); }
    receive(data) { this.dispatchEvent(new MessageEvent("message", { data })); }
  }
  const scope = new WorkerScope();
  let localNow = 0;
  let callback = null;
  installWorkerProtocol(scope, {
    timeOriginMs: 2_000,
    now: () => localNow,
    wallNow: () => Date.parse("2026-09-03T14:30:00.000Z"),
    setTimer: (next) => { callback = next; return 1; },
    clearTimer: () => { callback = null; },
  });
  scope.receive({
    type: "configure",
    sessionToken: "session-one",
    controllerTimeOriginMs: 1_000,
    samplingFrequencyHz: 100,
  });
  assert.deepEqual(scope.output[0], {
    type: "ready",
    sessionToken: "session-one",
    samplingFrequencyHz: 100,
    clockDomain: "controller-performance-v1",
    controllerTimeOriginMs: 1_000,
    workerTimeOriginMs: 2_000,
    clockOffsetMs: 1_000,
  });
  scope.receive({
    type: "stimulus-start",
    commandId: 1,
    sessionToken: "session-one",
    stimulusIndex: 0,
    stimulusId: "video-1",
    stimulusEpoch: 7,
  });
  localNow = 10;
  const tick = callback; callback = null; tick();
  scope.receive({ type: "pause", commandId: 2, sessionToken: "session-one", stimulusEpoch: 7 });
  const sampleOutputIndex = scope.output.findIndex(({ type }) => type === "sample");
  const pauseAckIndex = scope.output.findIndex(({ type, commandId }) => type === "ack" && commandId === 2);
  assert.equal(scope.output[sampleOutputIndex].sample.scheduledMonotonicMs, 1_010);
  assert.ok(sampleOutputIndex < pauseAckIndex, "the pause ACK is a FIFO drain fence for prior samples");
  scope.receive({ type: "resume", commandId: 3, sessionToken: "wrong", stimulusEpoch: 7 });
  assert.equal(scope.output.at(-1).type, "error");
});

test("digital input applies one edge step and ignores operating-system key repeat", () => {
  const states = [];
  const edges = [];
  let time = 10;
  const controller = new ResearchInputController({
    now: () => time++,
    onState: (state) => states.push(state),
    onInputEdge: (edge) => edges.push(edge),
  });
  const event = { code: "ArrowRight", repeat: false, preventDefault() {} };
  assert.equal(controller.handleKeyDown(event), true);
  assert.equal(states.at(-1).x, 0.1);
  assert.equal(controller.handleKeyDown({ ...event, repeat: true }), false);
  assert.equal(states.at(-1).x, 0.1);
  assert.equal(controller.handleKeyDown(event), false, "a second physical down without release is not another edge");
  assert.equal(controller.handleKeyUp({ code: "ArrowRight" }), true);
  assert.equal(edges.length, 2);
  assert.equal(edges[0].active, true);
  assert.equal(edges[1].active, false);
});

test("authoritative neutral resets prevent setup and prior-stimulus input from leaking", () => {
  const states = [];
  const controller = new ResearchInputController({ onState: (state) => states.push(state) });
  const right = { code: "ArrowRight", repeat: false, preventDefault() {} };
  assert.equal(controller.handleKeyDown(right), true);
  assert.equal(controller.state.x, 0.1, "the setup live test moved the controller");
  controller.resetNeutral("attempt-start");
  assert.deepEqual({ x: controller.state.x, y: controller.state.y, inputActive: controller.state.inputActive }, { x: 0, y: 0, inputActive: false });
  assert.equal(states.at(-1).source, "attempt-start");
  assert.equal(controller.handleKeyDown(right), true, "reset also clears held digital actions");
  assert.equal(controller.state.x, 0.1, "the new attempt starts from neutral rather than 0.2");
  controller.resetNeutral("safe-boundary");
  assert.deepEqual({ x: controller.state.x, y: controller.state.y, inputActive: controller.state.inputActive }, { x: 0, y: 0, inputActive: false });
  assert.equal(states.at(-1).source, "safe-boundary");
});

test("custom capture rejects global conflicts and accepts keyboard, mouse, wheel, and gamepad actions", () => {
  const arrows = createInputBindingPreset("arrowKeys");
  assert.throws(
    () => withCustomDigitalAction(arrows, "left", { kind: "keyboard", code: "ArrowRight" }),
    /already assigned to right/,
  );
  const custom = withCustomDigitalAction(arrows, "left", { kind: "mouseButton", button: 3 });
  assert.equal(custom.preset, "custom");
  assert.deepEqual(custom.directions.left, { kind: "mouseButton", button: 3 });
  assert.deepEqual(capturedDigitalAction({ type: "keydown", code: "KeyQ" }), { kind: "keyboard", code: "KeyQ" });
  assert.deepEqual(capturedDigitalAction({ type: "mousedown", button: 1 }), { kind: "mouseButton", button: 1 });
  assert.deepEqual(capturedDigitalAction({ type: "wheel", deltaX: 0, deltaY: -2 }), { kind: "wheel", direction: "up" });
  assert.deepEqual(capturedDigitalAction({ type: "gamepadbutton", button: 9 }), { kind: "gamepadButton", button: 9 });
});

test("pointer and analog presets are absolute and expose no digital Step Size", () => {
  const pointer = createInputBindingPreset("pointerGrid");
  assert.equal(pointer.stepSize, null);
  const states = [];
  const controller = new ResearchInputController({ binding: pointer, onState: (state) => states.push(state) });
  const handled = controller.handlePointer({
    type: "pointerdown",
    buttons: 1,
    clientX: 75,
    clientY: 25,
    preventDefault() {},
  }, { left: 0, top: 0, width: 100, height: 100 });
  assert.equal(handled, true);
  assert.equal(states.at(-1).x, 0.5);
  assert.equal(states.at(-1).y, 0.5);
  assert.equal(states.at(-1).inputActive, true);
  assert.equal(controller.handlePointer({ type: "pointerup", preventDefault() {} }), true);
  assert.equal(states.at(-1).x, 0.5, "pointer release retains the last absolute coordinate");
  assert.equal(states.at(-1).y, 0.5, "pointer release retains the last absolute coordinate");
  assert.equal(states.at(-1).inputActive, false);
  for (const type of ["pointercancel", "lostpointercapture"]) {
    assert.equal(controller.handlePointer({ type, preventDefault() {} }), true);
    assert.equal(states.at(-1).inputActive, false);
  }

  const analog = createInputBindingPreset("gamepadRightStick");
  const analogStates = [];
  const gamepad = new ResearchInputController({
    binding: analog,
    getGamepads: () => [{ index: 0, axes: [0, 0, -0.75, 0.25], buttons: [] }],
    onState: (state) => analogStates.push(state),
  });
  gamepad.pollGamepads();
  assert.equal(analogStates.at(-1).x, -0.75);
  assert.equal(analogStates.at(-1).y, -0.25);
  assert.equal(analog.stepSize, null);
});

class FakeSamplingWorker extends EventTarget {
  constructor() {
    super();
    this.messages = [];
    this.state = null;
    this.terminated = false;
    this.sessionToken = null;
    this.stimulus = null;
  }

  postMessage(message) {
    this.messages.push(structuredClone(message));
    if (message.type === "configure") {
      this.sessionToken = message.sessionToken;
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
        data: {
          type: "ready",
          sessionToken: message.sessionToken,
          samplingFrequencyHz: message.samplingFrequencyHz,
          clockDomain: "controller-performance-v1",
          controllerTimeOriginMs: message.controllerTimeOriginMs,
          workerTimeOriginMs: message.controllerTimeOriginMs + 100,
          clockOffsetMs: 100,
        },
      })));
    }
    if (message.type === "state") this.state = structuredClone(message.state);
    if (message.type === "stimulus-start") this.stimulus = structuredClone(message);
    if (["stimulus-start", "stimulus-stop", "pause", "resume", "stop"].includes(message.type)) {
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: {
        type: "ack",
        commandType: message.type,
        commandId: message.commandId,
        sessionToken: message.sessionToken,
        stimulusEpoch: message.stimulusEpoch,
        stimulusIndex: message.stimulusIndex,
        stimulusId: message.stimulusId,
      } })));
    }
  }

  emitSample(overrides = {}) {
    const state = this.state;
    this.dispatchEvent(new MessageEvent("message", { data: {
      type: "sample",
      sessionToken: this.sessionToken,
      sample: {
        sequence: 1,
        stimulusIndex: 0,
        stimulusId: "video-1",
        stimulusEpoch: this.stimulus?.stimulusEpoch,
        stimulusTimeMs: 500,
        wallTimeUtc: "2026-09-03T14:30:13.000Z",
        scheduledMonotonicMs: 10,
        observedMonotonicMs: 11,
        latenessMs: 1,
        anchorAgeMs: 1,
        samplingFrequencyHz: 130,
        currentValence: state.currentValence,
        currentArousal: state.currentArousal,
        targetValence: state.targetValence,
        targetArousal: state.targetArousal,
        radius: Math.hypot(state.currentValence, state.currentArousal),
        angleDegrees: 0,
        animationActive: true,
        inputActive: state.inputActive,
        mappingValues: state.mappingValues,
        ...overrides,
      },
    } }));
  }

  emitGap(missedSlots = 2) {
    this.dispatchEvent(new MessageEvent("message", { data: {
      type: "gap",
      sessionToken: this.sessionToken,
      event: {
        stimulusIndex: this.stimulus?.stimulusIndex,
        stimulusId: this.stimulus?.stimulusId,
        stimulusEpoch: this.stimulus?.stimulusEpoch,
        observedMonotonicMs: 11,
        firstMissedMonotonicMs: 9,
        durationMs: missedSlots * (1000 / 130),
        samplingFrequencyHz: 130,
        missedSlots,
      },
    } }));
  }

  terminate() { this.terminated = true; }
}

function oneVideoSettings() {
  const settings = structuredClone(createDefaultResearchSettings());
  settings.experiment.participantCount = 1;
  settings.output.tsv = true;
  settings.stimuli.items = [{
    stimulusId: "video-1",
    title: "Video One",
    source: {
      kind: "workspaceFile",
      relativePath: "stimuli/video-one.mp4",
      mimeType: "video/mp4",
      sha256: "c".repeat(64),
      byteLength: 1_024,
      durationMs: 2_000,
    },
  }];
  settings.stimuli.pools = [{
    poolId: "all-videos",
    label: "All videos",
    videosPerParticipant: 1,
    stimulusIds: ["video-1"],
  }];
  return settings;
}

test("browser run controller freezes one assignment and writes parity artifacts", async () => {
  const settings = oneVideoSettings();
  const plan = await resolveAssignmentPlan(settings);
  const journal = new MemoryResearchJournal();
  const workspace = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    artifacts: null,
    async createAttemptDirectory() { return { kind: "directory", name: "attempt" }; },
    async openAttemptDirectory() { return { kind: "directory", name: "attempt" }; },
    async writeAttemptArtifacts(_directory, artifacts) {
      this.artifacts = structuredClone(artifacts);
      return Object.freeze(Object.keys(artifacts));
    },
    async quarantineIncompleteAttemptArtifacts() { return []; },
  };
  const worker = new FakeSamplingWorker();
  let uuidCounter = 1;
  const cryptoObject = {
    randomUUID() {
      return `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, "0")}`;
    },
  };
  let wall = Date.parse("2026-09-03T14:30:12.482Z");
  let mono = 0;
  const controller = new BrowserResearchRunController({
    journal,
    workspace,
    workerFactory: () => worker,
    cryptoObject,
    platform: "chrome",
    now: () => wall,
    monotonicNow: () => mono,
    flushIntervalMs: 1_000_000,
  });
  await controller.initialize();
  await controller.start({
    settings,
    plan,
    participantId: "P001",
    participant: { participantCode: "LF", age: 27, gender: "W", handedness: "R" },
    attemptNumber: 1,
    preflight: {
      inputTestPassed: true,
      verifiedStimulusIds: ["video-1"],
      directoryPermission: true,
      indexedDbReady: true,
      timingWorkerReady: true,
      storageReady: true,
      manifestReady: true,
    },
  });
  assert.equal(controller.snapshot().mode, "run");
  assert.match(controller.snapshot().sessionStem, /^P001_LF_A27_GW_HR_/u);

  await controller.startStimulus(0);
  mono = 10;
  controller.updateAffect({ currentValence: 0.5, currentArousal: 0, inputActive: true, mediaTimeMs: 500 });
  await controller.pause(500);
  await controller.resumeStimulus(500);
  assert.equal(worker.state.currentValence, 0.5, "operator pause/resume preserves the current rating");
  assert.equal(worker.state.inputActive, true);
  worker.emitGap(2);
  worker.emitSample();
  await controller.flush();
  wall += 2_000;
  await controller.completeStimulus(2_000);
  const receipt = await controller.complete();

  assert.equal(receipt.completionStatus, "completed");
  assert.equal(receipt.sampleCount, 1);
  assert.equal(receipt.manifest.participantCode, "LF");
  assert.equal(receipt.manifest.timing.missedSlotCount, 2);
  assert.ok(workspace.artifacts["settings.snapshot.json"]);
  assert.ok(workspace.artifacts["events.jsonl"]);
  assert.ok(workspace.artifacts["ratings.csv"]);
  assert.ok(workspace.artifacts["ratings.tsv"]);
  assert.ok(workspace.artifacts["manifest.json"]);
  assert.equal(workspace.artifacts["ratings.csv"].split("\r\n").length,
    workspace.artifacts["ratings.tsv"].split("\r\n").length);
  assert.doesNotMatch(JSON.stringify(workspace.artifacts), /Emil|Fischer/u);
  assert.equal((await journal.getAttempt(receipt.runId)).status, "complete");
  assert.equal(controller.snapshot().mode, "setup");
});

test("browser controller fences on append failure, preserves accepted evidence, and records explicit recovery", async () => {
  const settings = oneVideoSettings();
  const plan = await resolveAssignmentPlan(settings);
  const journal = new MemoryResearchJournal();
  const append = journal.appendBatch.bind(journal);
  let rejectNextAppend = false;
  journal.appendBatch = async (input) => {
    if (rejectNextAppend) {
      rejectNextAppend = false;
      throw Object.assign(new Error("simulated quota interruption"), { code: "quota" });
    }
    return append(input);
  };
  const workspace = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    async createAttemptDirectory() { return { kind: "directory", name: "attempt" }; },
    async openAttemptDirectory() { return { kind: "directory", name: "attempt" }; },
    async writeAttemptArtifacts() { return []; },
    async quarantineIncompleteAttemptArtifacts() { return []; },
  };
  const worker = new FakeSamplingWorker();
  let id = 1;
  const controller = new BrowserResearchRunController({
    journal,
    workspace,
    workerFactory: () => worker,
    cryptoObject: { randomUUID: () => `00000000-0000-4000-8000-${String(id++).padStart(12, "0")}` },
    platform: "chrome",
    now: () => Date.parse("2026-09-03T14:30:12.482Z"),
    monotonicNow: () => 0,
    flushIntervalMs: 1_000_000,
  });
  await controller.initialize();
  await controller.start({
    settings,
    plan,
    participantId: "P001",
    participant: { participantCode: "LF", age: 27, gender: "W", handedness: "R" },
    attemptNumber: 1,
    preflight: {
      inputTestPassed: true,
      verifiedStimulusIds: ["video-1"],
      directoryPermission: true,
      indexedDbReady: true,
      timingWorkerReady: true,
      storageReady: true,
      manifestReady: true,
    },
  });
  await controller.startStimulus(0);
  controller.updateAffect({ currentValence: 0, currentArousal: 0, mediaTimeMs: 500 });
  worker.emitSample();
  rejectNextAppend = true;
  await assert.rejects(controller.flush(), /simulated quota interruption/u);
  assert.equal(controller.snapshot().mode, "run");
  assert.equal(controller.snapshot().writeState, "failed");
  assert.equal(controller.snapshot().pendingSamples, 1);
  assert.ok(controller.snapshot().pendingEvents >= 1);
  assert.equal((await journal.readRecords(controller.snapshot().runId, { kind: "samples" })).length, 0);

  await controller.retryWrites();
  const events = await journal.readRecords(controller.snapshot().runId, { kind: "events" });
  assert.equal((await journal.readRecords(controller.snapshot().runId, { kind: "samples" })).length, 1);
  assert.ok(events.some(({ type }) => type === "writeInterrupted"));
  assert.ok(events.some(({ type }) => type === "writeRecovered"));
  assert.equal(controller.snapshot().writeState, "idle");
  assert.equal(controller.snapshot().paused, true, "acquisition remains explicitly paused after a recovered write");
  await controller.interrupt("test-finished");
});

test("pending output finalization resumes without a worker and regenerates byte-identical artifacts", async () => {
  const settings = oneVideoSettings();
  const plan = await resolveAssignmentPlan(settings);
  const journal = new MemoryResearchJournal();
  let firstArtifacts = null;
  let materializationCalls = 0;
  let quarantineCalls = 0;
  const directory = { kind: "directory", name: "attempt" };
  const workspace = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    async createAttemptDirectory() { return directory; },
    async openAttemptDirectory() { return directory; },
    async writeAttemptArtifacts(_directory, artifacts) {
      materializationCalls += 1;
      if (materializationCalls === 1) {
        firstArtifacts = structuredClone(artifacts);
        throw Object.assign(new Error("simulated interrupted output"), { code: "output-write" });
      }
      assert.deepEqual(artifacts, firstArtifacts, "finalize-only recovery must regenerate identical bytes");
      if (materializationCalls === 2) {
        throw Object.assign(new Error("partial artifact conflict"), { code: "artifact-conflict" });
      }
      return Object.freeze(Object.keys(artifacts));
    },
    async quarantineIncompleteAttemptArtifacts() { quarantineCalls += 1; return []; },
  };
  let id = 1;
  const controller = new BrowserResearchRunController({
    journal,
    workspace,
    workerFactory: () => new FakeSamplingWorker(),
    cryptoObject: { randomUUID: () => `00000000-0000-4000-8000-${String(id++).padStart(12, "0")}` },
    platform: "chrome",
    now: () => Date.parse("2026-09-03T14:30:12.482Z"),
    monotonicNow: () => 0,
    flushIntervalMs: 1_000_000,
  });
  await controller.initialize();
  const started = await controller.start({
    settings,
    plan,
    participantId: "P001",
    participant: { participantCode: "LF", age: 27, gender: "W", handedness: "R" },
    attemptNumber: 1,
    preflight: {
      inputTestPassed: true,
      verifiedStimulusIds: ["video-1"],
      directoryPermission: true,
      indexedDbReady: true,
      timingWorkerReady: true,
      storageReady: true,
      manifestReady: true,
    },
  });
  await controller.startStimulus(0);
  await controller.completeStimulus(2_000);
  await assert.rejects(controller.complete(), /simulated interrupted output/u);
  const partial = await journal.getAttempt(started.runId);
  assert.equal(partial.recoverable, true);
  assert.equal(partial.pendingFinalization.completionStatus, "completed");

  const resumedController = new BrowserResearchRunController({
    journal,
    workspace,
    workerFactory: () => { throw new Error("finalize-only recovery must not create a worker"); },
    platform: "chrome",
    now: () => Date.parse("2026-09-03T14:31:00.000Z"),
    monotonicNow: () => 100,
  });
  await resumedController.initialize();
  const resumed = await resumedController.resume({ runId: started.runId, ownerId: "tab-finalize-retry" });
  assert.equal(resumed.finalizationPending, true);
  assert.equal(resumed.workerReady, false);
  const receipt = await resumedController.finalizePendingOutput();
  assert.equal(receipt.completionStatus, "completed");
  assert.equal(quarantineCalls, 1);
  assert.equal((await journal.getAttempt(started.runId)).status, "complete");
});

test("browser start failure releases the participant lock as a recoverable partial", async () => {
  const settings = oneVideoSettings();
  const plan = await resolveAssignmentPlan(settings);
  const journal = new MemoryResearchJournal();
  const workspace = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    async createAttemptDirectory() { return { kind: "directory", name: "attempt" }; },
    async openAttemptDirectory() { return { kind: "directory", name: "attempt" }; },
    async writeAttemptArtifacts() { return []; },
    async quarantineIncompleteAttemptArtifacts() { return []; },
  };
  class FailingWorker extends EventTarget {
    postMessage(message) {
      if (message.type === "configure") queueMicrotask(() => this.dispatchEvent(new Event("error")));
    }
    terminate() {}
  }
  const controller = new BrowserResearchRunController({
    journal,
    workspace,
    workerFactory: () => new FailingWorker(),
    platform: "chrome",
  });
  await controller.initialize();
  await assert.rejects(controller.start({
    settings,
    plan,
    participantId: "P001",
    participant: { participantCode: "LF", age: 27, gender: "W", handedness: "R" },
    attemptNumber: 1,
    preflight: {
      inputTestPassed: true,
      verifiedStimulusIds: ["video-1"],
      directoryPermission: true,
      indexedDbReady: true,
      timingWorkerReady: true,
      storageReady: true,
      manifestReady: true,
    },
  }), /before readiness/u);
  const [attempt] = await journal.listAttempts({ experimentId: settings.experiment.id });
  assert.equal(attempt.status, "partial");
  assert.equal(attempt.recoverable, true);
  assert.equal((await journal.participantStates(settings.experiment.id, ["P001"]))[0].state, "Partial");
});

class MemoryFileHandle {
  constructor(name, file = new File(["initial"], name)) {
    this.kind = "file";
    this.name = name;
    this.file = file;
  }

  async getFile() { return this.file; }

  async createWritable() {
    const chunks = [];
    return {
      write: async (chunk) => { chunks.push(chunk); },
      close: async () => {
        this.file = new File(chunks, this.name, { type: this.file.type, lastModified: Date.now() });
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
    this.permission = "granted";
  }

  async queryPermission() { return this.permission; }
  async requestPermission() { this.permission = "granted"; return this.permission; }

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
    const file = new MemoryFileHandle(name, new File([], name));
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name) {
    if (!this.children.delete(name)) throw Object.assign(new Error("Missing entry"), { name: "NotFoundError" });
  }

  async *entries() {
    yield* this.children.entries();
  }
}

test("workspace initialization curates the four fixed libraries and recursively rescans videos", async () => {
  const root = new MemoryDirectoryHandle();
  const workspace = new BrowserResearchWorkspace(root);
  await workspace.initialize();
  assert.deepEqual([...root.children.keys()], [...RESEARCH_WORKSPACE_DIRECTORIES]);
  assert.equal(RESEARCH_STORAGE_NAMESPACE, "affect-research/v1");

  const stimuli = root.children.get("stimuli");
  const nested = await stimuli.getDirectoryHandle("Condition A", { create: true });
  nested.children.set("Full Video.mp4", new MemoryFileHandle(
    "Full Video.mp4",
    new File(["video bytes"], "Full Video.mp4", { type: "video/mp4", lastModified: 123 }),
  ));
  nested.children.set("notes.txt", new MemoryFileHandle("notes.txt"));
  const videos = await workspace.rescanVideos();
  assert.equal(videos.length, 1);
  assert.equal(videos[0].relativePath, "Condition A/Full Video.mp4");
  assert.equal(videos[0].byteLength, 11);
});

test("workspace output readiness proves create, write, read, and cleanup in the selected outputs library", async () => {
  const root = new MemoryDirectoryHandle();
  const workspace = new BrowserResearchWorkspace(root);
  await workspace.initialize();
  const outputs = root.children.get("outputs");
  assert.deepEqual(await workspace.probeOutputWriteReadiness(), { writeReady: true });
  assert.deepEqual([...outputs.children.keys()], []);
  outputs.removeEntry = undefined;
  await assert.rejects(
    workspace.probeOutputWriteReadiness(),
    (error) => error.code === "output-write-probe",
  );
});

test("workspace identity is persisted, strict, and stable across reopened handles", async () => {
  const root = new MemoryDirectoryHandle();
  const first = new BrowserResearchWorkspace(root);
  await first.initialize();
  assert.match(first.workspaceId, /^[a-f0-9-]{36}$/u);
  const identityHandle = root.children.get("settings").children.get(RESEARCH_WORKSPACE_IDENTITY_FILE);
  assert.ok(identityHandle, "initialization writes the opaque identity inside the curated settings library");
  const identity = parseStrictJson(await (await identityHandle.getFile()).text(), { maximumBytes: 16 * 1024 });
  assert.equal(identity.workspaceId, first.workspaceId);

  const reopened = new BrowserResearchWorkspace(root);
  await reopened.initialize();
  assert.equal(reopened.workspaceId, first.workspaceId, "reopening the same directory cannot create another identity");

  identityHandle.file = new File([
    '{"schema":"affect-research-workspace-identity","version":1,"workspaceId":"11111111-1111-4111-8111-111111111111","workspaceId":"22222222-2222-4222-8222-222222222222"}',
  ], RESEARCH_WORKSPACE_IDENTITY_FILE, { type: "application/json" });
  await assert.rejects(
    new BrowserResearchWorkspace(root).initialize(),
    (error) => error.code === "duplicate-json-key",
  );
});

test("strict settings JSON rejects duplicate keys, invalid numbers, and oversized inputs", () => {
  assert.deepEqual(parseStrictJson('{"outer":{"value":1},"items":[true,null,"ok"]}'), {
    outer: { value: 1 },
    items: [true, null, "ok"],
  });
  assert.throws(
    () => parseStrictJson('{"experiment":{"id":"one","id":"two"}}'),
    (error) => error.code === "duplicate-json-key",
  );
  assert.throws(
    () => parseStrictJson('{"value":01}'),
    (error) => error.code === "settings-json",
  );
  assert.throws(
    () => parseStrictJson('12345', { maximumBytes: 4 }),
    (error) => error.code === "settings-size",
  );
});

test("workspace imports preserve safe relative subfolders and never overwrite", async () => {
  const root = new MemoryDirectoryHandle();
  const workspace = new BrowserResearchWorkspace(root);
  await workspace.initialize();
  const file = new File(["1234"], "Clip One.mp4", { type: "video/mp4" });
  Object.defineProperty(file, "webkitRelativePath", { value: "Pool One/Clip One.mp4" });
  assert.deepEqual(await workspace.importVideoFiles([file]), ["Pool One/Clip One.mp4"]);
  await assert.rejects(workspace.importVideoFiles([file]), (error) => error.code === "already-exists");
  assert.equal((await workspace.rescanVideos())[0].relativePath, "Pool One/Clip One.mp4");
  assert.throws(() => normalizeWorkspaceRelativePath("../escape.mp4"), /unsafe/u);
  assert.equal(isSupportedVideoName("example.WEBM"), true);
  assert.equal(isSupportedVideoName("example.csv"), false);
});

test("workspace opens a verified stimulus only beneath the curated stimuli library", async () => {
  const root = new MemoryDirectoryHandle();
  const workspace = new BrowserResearchWorkspace(root);
  await workspace.initialize();
  const stimuli = root.children.get("stimuli");
  const nested = await stimuli.getDirectoryHandle("Pool One", { create: true });
  nested.children.set("Clip One.mp4", new MemoryFileHandle(
    "Clip One.mp4",
    new File(["video"], "Clip One.mp4", { type: "video/mp4" }),
  ));
  const file = await workspace.openStimulusFile("stimuli/Pool One/Clip One.mp4");
  assert.equal(file.name, "Clip One.mp4");
  assert.equal(await file.text(), "video");
  await assert.rejects(workspace.openStimulusFile("settings/not-video.json"), /supported complete-video/u);
});

test("experimental YouTube normalization is explicit, unverified, and never invents a byte hash", () => {
  assert.deepEqual(parseExperimentalYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=1"), {
    sourceKind: "youtube-experimental",
    videoId: "dQw4w9WgXcQ",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    verification: "unverified-noncanonical",
    sha256: null,
  });
  assert.throws(() => parseExperimentalYouTubeUrl("http://youtube.com/watch?v=dQw4w9WgXcQ"), /HTTPS/u);
  assert.throws(() => parseExperimentalYouTubeUrl("https://example.com/watch?v=dQw4w9WgXcQ"), /Only youtube/u);
});

test("workspace settings save uses the canonical experiment path", async () => {
  const root = new MemoryDirectoryHandle();
  const workspace = new BrowserResearchWorkspace(root);
  await workspace.initialize();
  const settings = createDefaultResearchSettings();
  await workspace.saveSettings(settings);
  const handle = root.children.get("settings").children.get("video-affect-study.settings.json");
  assert.ok(handle);
  const saved = JSON.parse(await (await handle.getFile()).text());
  assert.equal(saved.schema, "affect-research-settings");
  assert.equal(saved.experiment.samplingFrequencyHz, 130);
});

test("attempt artifact materialization is idempotent and quarantines conflicting partial files before retry", async () => {
  const root = new MemoryDirectoryHandle();
  const workspace = new BrowserResearchWorkspace(root);
  await workspace.initialize();
  const attempt = await workspace.createAttemptDirectory({
    experimentId: "experiment-1",
    participantId: "P001",
    sessionStem: "P001_EF_A27_GW_HR_20260903T143012482Z_R01",
  });
  attempt.children.set("settings.snapshot.json", new MemoryFileHandle(
    "settings.snapshot.json",
    new File(["settings\n"], "settings.snapshot.json"),
  ));
  attempt.children.set("events.jsonl", new MemoryFileHandle(
    "events.jsonl",
    new File(["partial"], "events.jsonl"),
  ));
  const artifacts = {
    "settings.snapshot.json": "settings\n",
    "events.jsonl": "event-one\nevent-two\n",
    "ratings.csv": "sequence\r\n1\r\n",
    "manifest.json": "manifest\n",
  };
  await assert.rejects(
    workspace.writeAttemptArtifacts(attempt, artifacts),
    (error) => error.code === "artifact-conflict",
  );
  const quarantine = await workspace.quarantineIncompleteAttemptArtifacts(attempt);
  assert.deepEqual(quarantine.map(({ artifactName }) => artifactName), [
    "settings.snapshot.json",
    "events.jsonl",
  ]);
  assert.deepEqual(await workspace.writeAttemptArtifacts(attempt, artifacts), Object.keys(artifacts));
  assert.equal(await (await attempt.children.get("events.jsonl").getFile()).text(), artifacts["events.jsonl"]);
  assert.deepEqual(await workspace.writeAttemptArtifacts(attempt, artifacts), Object.keys(artifacts));
});

test("browser runtime lease is exclusive and releases its held Web Lock", async () => {
  let released = false;
  const lockManager = {
    request: async (_name, options, callback) => {
      assert.equal(options.ifAvailable, true);
      await callback({ name: "held" });
      released = true;
    },
  };
  const lease = await acquireExclusiveRuntimeLease(lockManager);
  assert.equal(released, false);
  lease.release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(released, true);
  await assert.rejects(acquireExclusiveRuntimeLease({
    request: async (_name, _options, callback) => callback(null),
  }), /already open/u);
});

test("runtime integration derives attempt, recovery, and participant-state projections deterministically", () => {
  const attempts = [
    { participantId: "P001", attemptNumber: 1, status: "complete" },
    {
      participantId: "P001",
      attemptNumber: 2,
      status: "partial",
      recoverable: true,
      settingsHash: HASH_A,
      planHash: HASH_B,
    },
    { participantId: "P002", attemptNumber: 7, status: "complete" },
  ];
  assert.equal(nextAttemptNumber(attempts, "P001"), 3);
  assert.equal(selectCompatibleRecovery(attempts, {
    participantId: "P001",
    settingsSha256: HASH_A,
    assignmentPlanSha256: HASH_B,
  }).attemptNumber, 2);
  assert.equal(selectCompatibleRecovery(attempts, {
    participantId: "P001",
    settingsSha256: "c".repeat(64),
    assignmentPlanSha256: HASH_B,
  }), null);
  assert.deepEqual(participantStateDetail([
    { participantId: "P001", state: "Partial" },
    { participantId: "P002", state: "Complete" },
  ]), { P001: "partial", P002: "complete" });
});
