import test from "node:test";
import assert from "node:assert/strict";

import {
  IndexedDbResearchJournal,
  RESEARCH_JOURNAL_DATABASE,
} from "../site/src/research/browser-journal.js";
import {
  RESEARCH_EVENT_SCHEMA,
  RESEARCH_SAMPLE_SCHEMA,
} from "../site/src/research/contracts.js";
import {
  idbRequestResult,
  idbTransactionDone,
  ResearchIdbKeyRange,
  ResearchIndexedDbHarness,
} from "./support/research-indexeddb-harness.js";

const SETTINGS_HASH = "a".repeat(64);
const PLAN_HASH = "b".repeat(64);
const STIMULUS_IDENTITY = Object.freeze({
  kind: "workspaceFile",
  stimulusId: "video-1",
  sha256: "c".repeat(64),
  byteLength: 1024,
  durationMs: 60_000,
  url: null,
  videoId: null,
});

function reservation(overrides = {}) {
  return {
    runId: "run-001",
    experimentId: "experiment-1",
    participantId: "P001",
    attemptNumber: 1,
    sessionStem: "P001_EF_A27_GW_HR_20260903T143012482Z_R01",
    settingsHash: SETTINGS_HASH,
    planHash: PLAN_HASH,
    createdAt: "2026-09-03T14:30:12.482Z",
    ownerId: "tab-001",
    context: {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      participant: { participantCode: "EF", age: 27, gender: "W", handedness: "R" },
    },
    ...overrides,
  };
}

function sample(sequence) {
  return {
    schema: RESEARCH_SAMPLE_SCHEMA,
    version: 1,
    sequence,
    runId: "run-001",
    participantId: "P001",
    attemptNumber: 1,
    settingsSha256: SETTINGS_HASH,
    assignmentPlanSha256: PLAN_HASH,
    stimulusPosition: 1,
    stimulusIdentity: structuredClone(STIMULUS_IDENTITY),
    wallTimeUtc: `2026-09-03T14:30:${String(12 + sequence).padStart(2, "0")}.000Z`,
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
  };
}

function journalEvent(sequence) {
  return {
    schema: RESEARCH_EVENT_SCHEMA,
    version: 1,
    sequence,
    runId: "run-001",
    participantId: "P001",
    attemptNumber: 1,
    settingsSha256: SETTINGS_HASH,
    assignmentPlanSha256: PLAN_HASH,
    wallTimeUtc: `2026-09-03T14:30:${String(12 + sequence).padStart(2, "0")}.000Z`,
    monotonicTimeNs: String(sequence),
    type: "sessionStarted",
    stimulusIdentity: null,
    stimulusPosition: null,
    mediaTimeMs: null,
    missedSlotCount: null,
    detailCode: `test-event-${sequence}`,
  };
}

function createJournal(indexedDB, databaseName) {
  return new IndexedDbResearchJournal({
    indexedDB,
    keyRange: ResearchIdbKeyRange,
    databaseName,
  });
}

async function withoutLocalStorageFallback(action) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let accessCount = 0;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      accessCount += 1;
      throw new Error("The IndexedDB journal must not touch localStorage.");
    },
  });
  try {
    const result = await action();
    assert.equal(accessCount, 0);
    return result;
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
}

test("IndexedDB commit abort rolls back the whole batch and retains the acknowledged prefix after reload", async () => {
  await withoutLocalStorageFallback(async () => {
    const indexedDB = new ResearchIndexedDbHarness();
    const databaseName = `${RESEARCH_JOURNAL_DATABASE}/commit-abort`;
    const first = createJournal(indexedDB, databaseName);
    await first.reserveAttempt(reservation());
    await first.appendBatch({
      runId: "run-001",
      expectedSampleSequence: 1,
      expectedEventSequence: 1,
      samples: [sample(1)],
      events: [journalEvent(1)],
      updatedAt: "2026-09-03T14:30:13.000Z",
    });

    indexedDB.abortNextReadwriteCommit();
    await assert.rejects(first.appendBatch({
      runId: "run-001",
      expectedSampleSequence: 2,
      expectedEventSequence: 2,
      samples: [sample(2)],
      events: [journalEvent(2)],
      updatedAt: "2026-09-03T14:30:14.000Z",
    }), (error) => error?.name === "AbortError");
    await first.close();

    const reopened = createJournal(indexedDB, databaseName);
    const attempt = await reopened.getAttempt("run-001");
    assert.equal(attempt.nextSampleSequence, 2);
    assert.equal(attempt.nextEventSequence, 2);
    assert.deepEqual(
      (await reopened.readRecords("run-001", { kind: "samples" })).map(({ sequence }) => sequence),
      [1],
    );
    assert.deepEqual(
      (await reopened.readRecords("run-001", { kind: "events" })).map(({ sequence }) => sequence),
      [1],
    );

    const committed = await reopened.appendBatch({
      runId: "run-001",
      expectedSampleSequence: 2,
      expectedEventSequence: 2,
      samples: [sample(2)],
      events: [journalEvent(2)],
      updatedAt: "2026-09-03T14:30:14.000Z",
    });
    assert.equal(committed.nextSampleSequence, 3);
    assert.equal(committed.nextEventSequence, 3);
    assert.equal(indexedDB.openCount, 2, "reload opens the same durable IndexedDB database");
    await reopened.close();
  });
});

test("IndexedDB quota rejection cannot acknowledge a partial batch and reload reconstructs recovery", async () => {
  await withoutLocalStorageFallback(async () => {
    const indexedDB = new ResearchIndexedDbHarness();
    const databaseName = `${RESEARCH_JOURNAL_DATABASE}/quota`;
    const first = createJournal(indexedDB, databaseName);
    await first.reserveAttempt(reservation());
    await first.appendBatch({
      runId: "run-001",
      expectedSampleSequence: 1,
      expectedEventSequence: 1,
      samples: [sample(1)],
      stimulusState: { activeStimulusIndex: 0, safeStimulusIndex: 0 },
      updatedAt: "2026-09-03T14:30:13.000Z",
    });

    indexedDB.rejectNextRequest({
      storeName: "samples",
      operation: "add",
      error: new DOMException("Injected quota exhaustion.", "QuotaExceededError"),
    });
    await assert.rejects(first.appendBatch({
      runId: "run-001",
      expectedSampleSequence: 2,
      expectedEventSequence: 1,
      samples: [sample(2)],
      events: [journalEvent(1)],
      updatedAt: "2026-09-03T14:30:14.000Z",
    }), (error) => error?.name === "QuotaExceededError");
    await first.close();

    const recoveryJournal = createJournal(indexedDB, databaseName);
    const [recovered] = await recoveryJournal.reconcileAbandonedAttempts({
      updatedAt: "2026-09-03T14:31:00.000Z",
    });
    assert.equal(recovered.status, "partial");
    assert.equal(recovered.recoverable, true);
    assert.equal(recovered.interruption.restartStimulusIndex, 0);
    assert.equal(recovered.interruption.interruptedStimulusIndex, 0);
    assert.deepEqual(
      (await recoveryJournal.readRecords("run-001", { kind: "samples" })).map(({ sequence }) => sequence),
      [1],
    );
    assert.deepEqual(await recoveryJournal.readRecords("run-001", { kind: "events" }), []);
    await recoveryJournal.close();

    const secondReload = createJournal(indexedDB, databaseName);
    const resumed = await secondReload.resumeAttempt({
      runId: "run-001",
      ownerId: "tab-reloaded",
      resumedAt: "2026-09-03T14:32:00.000Z",
    });
    assert.equal(resumed.status, "active");
    assert.equal(resumed.nextSampleSequence, 2);
    assert.equal(resumed.nextEventSequence, 1);
    await secondReload.close();
  });
});

test("corrupt IndexedDB evidence is preserved in quarantine and remains quarantined across reload", async () => {
  await withoutLocalStorageFallback(async () => {
    const indexedDB = new ResearchIndexedDbHarness();
    const databaseName = `${RESEARCH_JOURNAL_DATABASE}/corrupt-evidence`;
    const first = createJournal(indexedDB, databaseName);
    await first.reserveAttempt(reservation());
    await first.appendBatch({
      runId: "run-001",
      expectedSampleSequence: 1,
      expectedEventSequence: 1,
      samples: [sample(1)],
      events: [journalEvent(1)],
      updatedAt: "2026-09-03T14:30:13.000Z",
    });

    const database = await first.open();
    const corruption = database.transaction(["samples"], "readwrite");
    const corruptionDone = idbTransactionDone(corruption);
    const samples = corruption.objectStore("samples");
    const entry = await idbRequestResult(samples.get(["run-001", 1]));
    entry.value.settingsSha256 = "d".repeat(64);
    samples.put(entry);
    await corruptionDone;
    await first.close();

    const reopened = createJournal(indexedDB, databaseName);
    assert.deepEqual(await reopened.listAttempts({ experimentId: "experiment-1" }), []);
    assert.deepEqual(await reopened.participantStates("experiment-1", ["P001"]), [
      { participantId: "P001", state: "Available", attempts: 0 },
    ]);
    const [quarantined] = await reopened.listQuarantinedRecords();
    assert.equal(quarantined.runId, "run-001");
    assert.equal(quarantined.reasonCode, "corrupt-record");
    assert.equal(quarantined.evidence.attempt.runId, "run-001");
    assert.equal(quarantined.evidence.samples.length, 1);
    assert.equal(quarantined.evidence.samples[0].value.settingsSha256, "d".repeat(64));
    assert.equal(quarantined.evidence.events.length, 1);
    await reopened.close();

    const secondReload = createJournal(indexedDB, databaseName);
    assert.equal((await secondReload.listQuarantinedRecords()).length, 1);
    assert.equal(await secondReload.getAttempt("run-001"), undefined);
    assert.equal((await secondReload.listQuarantinedRecords()).length, 1);
    await secondReload.close();
  });
});
