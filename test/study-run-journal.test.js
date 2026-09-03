import test from "node:test";
import assert from "node:assert/strict";
import {
  createRunCheckpoint,
  IndexedDbJournalBackend,
  MemoryJournalBackend,
  PARTIAL_RUN_EXPORT_PROTOCOL,
  RUN_JOURNAL_PROTOCOL,
  StudyRunJournal,
  StudyStorageConflictError,
  StudyStorageQuotaError,
  StudyStorageStateError,
  StudyStorageValidationError,
} from "../site/src/study/index.js";

const HASH = "c".repeat(64);

function createJournal({ backend = new MemoryJournalBackend(), limits } = {}) {
  let tick = 0;
  return {
    backend,
    journal: new StudyRunJournal({
      backend,
      limits,
      now: () => new Date(1_710_000_000_000 + tick++ * 1000),
    }),
  };
}

function event(runId, sequence, payload = {}) {
  return {
    schema: "affect-tracker-run-event",
    version: 1,
    sequence,
    runId,
    payload,
  };
}

async function begin(journal, runId = "run-1") {
  return journal.createRun({
    runId,
    studyId: "study-1",
    protocolHash: HASH,
    metadata: { platform: "pages", build: "test" },
  });
}

test("run journals enforce contiguous authority-supplied event sequences", async () => {
  const { journal } = createJournal();
  const created = await begin(journal);
  assert.equal(created.protocol, RUN_JOURNAL_PROTOCOL);
  assert.equal(created.status, "partial");
  assert.equal(created.nextSequence, 1);
  assert.ok(Object.isFrozen(created.metadata));

  const checkpoint = createRunCheckpoint({
    sequence: 2,
    position: "block-active",
    blockId: "stimulus-1",
    blockKind: "video",
    phase: "playing",
  });
  const updated = await journal.appendEvents("run-1", [
    event("run-1", 1, { type: "run-started" }),
    event("run-1", 2, { type: "media-started" }),
  ], { expectedNextSequence: 1, checkpoint });
  assert.equal(updated.nextSequence, 3);
  assert.deepEqual((await journal.readEvents("run-1", { limit: 2 })).map((item) => item.sequence), [1, 2]);

  await assert.rejects(
    journal.appendEvents("run-1", [event("run-1", 4)]),
    StudyStorageConflictError,
  );
  await assert.rejects(
    journal.appendEvents("run-1", [event("another-run", 3)]),
    /runId does not match/,
  );
  assert.equal((await journal.getRun("run-1")).nextSequence, 3);
});

test("event batches and individual event sizes are bounded before persistence", async () => {
  const { journal } = createJournal({
    limits: { maxBatchEvents: 2, maxBatchBytes: 500, maxEventBytes: 300 },
  });
  await begin(journal);
  await assert.rejects(journal.appendEvents("run-1", [
    event("run-1", 1),
    event("run-1", 2),
    event("run-1", 3),
  ]), /limit is 2/);
  await assert.rejects(
    journal.appendEvents("run-1", [event("run-1", 1, { text: "x".repeat(500) })]),
    /limit is 300 bytes/,
  );
  assert.equal((await journal.getRun("run-1")).nextSequence, 1);
});

test("aggregate event evidence is byte-bounded before recovery can require an unbounded export", async () => {
  const first = event("run-byte-cap", 1, { type: "sample", note: "x".repeat(80) });
  const firstBytes = new TextEncoder().encode(JSON.stringify(first)).byteLength;
  const { journal } = createJournal({ limits: { maxRunBytes: firstBytes } });
  await journal.createRun({ runId: "run-byte-cap", studyId: "study-byte-cap", protocolHash: HASH });
  const afterFirst = await journal.appendEvents("run-byte-cap", [first]);
  assert.equal(afterFirst.eventBytes, firstBytes);

  await assert.rejects(
    journal.appendEvents("run-byte-cap", [event("run-byte-cap", 2, { type: "sample" })]),
    StudyStorageQuotaError,
  );
  const retained = await journal.getRun("run-byte-cap");
  assert.equal(retained.nextSequence, 2);
  assert.equal(retained.eventBytes, firstBytes);
  assert.equal((await journal.readEvents("run-byte-cap")).length, 1);
});

test("a 12.5-minute 20 Hz run remains finalizable beyond the generic JSON node budget", async () => {
  const eventCount = 15_000;
  const runId = "run-long-export";
  const template = event(runId, 1, { type: "affectSampleRecorded", x: 0, y: 0 });
  const estimatedBytes = new TextEncoder().encode(JSON.stringify(template)).byteLength * eventCount;
  const run = {
    protocol: RUN_JOURNAL_PROTOCOL,
    version: 1,
    runId,
    studyId: "study-long-export",
    protocolHash: HASH,
    status: "partial",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:12:30.000Z",
    nextSequence: eventCount + 1,
    eventBytes: estimatedBytes,
    metadata: {},
    pendingAction: null,
    checkpoint: null,
    finalizedAt: null,
    resultManifest: null,
  };
  const backend = {
    async createRun() {},
    async getRun(requestedRunId) { return requestedRunId === runId ? structuredClone(run) : undefined; },
    async listRuns() { return [structuredClone(run)]; },
    async commitBatch() { throw new Error("not used"); },
    async getEvents(requestedRunId, { fromSequence, limit }) {
      assert.equal(requestedRunId, runId);
      const count = Math.min(limit, eventCount - fromSequence + 1);
      return Array.from({ length: Math.max(0, count) }, (_, index) => event(
        runId,
        fromSequence + index,
        { type: "affectSampleRecorded", x: 0, y: 0 },
      ));
    },
    async finalizeRun() { throw new Error("not used"); },
    async deleteRun() { throw new Error("not used"); },
  };
  const journal = new StudyRunJournal({ backend });

  const exported = await journal.exportPartial(runId);
  assert.equal(exported.events.length, eventCount);
  assert.equal(exported.events.at(-1).sequence, eventCount);
});

test("metadata and checkpoints use compare-and-swap journal updates", async () => {
  const { journal } = createJournal();
  await begin(journal);
  const metadataUpdate = await journal.replaceMetadata("run-1", {
    platform: "webxr",
    headset: "quest-test",
  }, { expectedNextSequence: 1 });
  assert.deepEqual(metadataUpdate.metadata, { platform: "webxr", headset: "quest-test" });

  const runStart = createRunCheckpoint({ sequence: 0, position: "run-start", phase: "prepared" });
  const checkpointed = await journal.setCheckpoint("run-1", runStart, { expectedNextSequence: 1 });
  assert.equal(checkpointed.checkpoint.position, "run-start");
  await assert.rejects(journal.setCheckpoint("run-1", createRunCheckpoint({
    sequence: 2,
    position: "block-ready",
    blockId: "block-1",
    blockKind: "instruction",
  })), StudyStorageConflictError);
});

test("a safe recovery checkpoint may lag behind later lifecycle events", async () => {
  const { journal } = createJournal();
  await begin(journal);
  await journal.appendEvents("run-1", [event("run-1", 1)], {
    checkpoint: createRunCheckpoint({
      sequence: 1,
      position: "block-ready",
      blockId: "instructions",
      blockKind: "instruction",
      phase: "prepared",
    }),
  });

  const updated = await journal.appendEvents("run-1", [event("run-1", 2, { type: "armed" })]);
  assert.equal(updated.nextSequence, 3);
  assert.equal(updated.checkpoint.sequence, 1);
  assert.equal(updated.checkpoint.position, "block-ready");

  await assert.rejects(journal.appendEvents("run-1", [event("run-1", 3)], {
    checkpoint: createRunCheckpoint({
      sequence: 2,
      position: "block-ready",
      blockId: "instructions",
      blockKind: "instruction",
      phase: "armed",
    }),
  }), StudyStorageConflictError, "a newly supplied checkpoint must describe the complete batch");
});

test("partial recovery never resumes inside a stimulus", async () => {
  const { journal } = createJournal();
  await begin(journal);
  await journal.appendEvents("run-1", [event("run-1", 1, { mediaTime: 12.5 })], {
    checkpoint: createRunCheckpoint({
      sequence: 1,
      position: "block-active",
      blockId: "video-1",
      blockKind: "video",
      phase: "playing",
    }),
  });

  const [summary] = await journal.listPartialRuns();
  assert.equal(summary.runId, "run-1");
  const recovery = await journal.recoverPartialRun("run-1");
  assert.equal(recovery.recovery.strategy, "restart-block");
  assert.equal(recovery.recovery.canResumeMidStimulus, false);
  assert.equal(recovery.recovery.reason, "mid-stimulus-resume-forbidden");
  assert.deepEqual(recovery.allowedActions, ["export-partial", "discard-and-restart"]);
  assert.equal(recovery.events.length, 1);
  assert.ok(Object.isFrozen(recovery.events[0]));

  const exported = await journal.exportPartial("run-1");
  assert.equal(exported.protocol, PARTIAL_RUN_EXPORT_PROTOCOL);
  assert.equal(exported.completionStatus, "partial");
  assert.equal(exported.events[0].payload.mediaTime, 12.5);
  assert.equal((await journal.getRun("run-1")).status, "partial", "export must be non-destructive");
});

test("completed-block recovery resumes only from the boundary", async () => {
  const { journal } = createJournal();
  await begin(journal);
  await journal.appendEvents("run-1", [event("run-1", 1)], {
    checkpoint: createRunCheckpoint({
      sequence: 1,
      position: "block-complete",
      blockId: "questionnaire-1",
      blockKind: "questionnaire",
      phase: "committed",
    }),
  });
  const recovery = await journal.recoverPartialRun("run-1");
  assert.deepEqual(recovery.recovery, {
    canResumeMidStimulus: false,
    strategy: "resume-after-block",
    blockId: "questionnaire-1",
    reason: "completed-block-boundary",
  });
});

test("discard removes a partial run and its events", async () => {
  const { journal, backend } = createJournal();
  await begin(journal);
  await journal.appendEvents("run-1", [event("run-1", 1)]);
  assert.equal(await journal.discardPartial("run-1"), true);
  assert.equal(await journal.getRun("run-1"), undefined);
  assert.deepEqual(backend.snapshot(), { runs: [], events: [] });
});

test("finalization is terminal and partial-only operations fail closed", async () => {
  const { journal } = createJournal();
  await begin(journal);
  await journal.appendEvents("run-1", [event("run-1", 1)]);
  const finalized = await journal.finalizeRun("run-1", {
    expectedNextSequence: 2,
    resultManifest: {
      schema: "affect-tracker-result-manifest",
      version: 1,
      runId: "run-1",
      completionStatus: "completed",
      eventCount: 1,
    },
  });
  assert.equal(finalized.status, "finalized");
  assert.equal(finalized.resultManifest.eventCount, 1);
  assert.ok(Object.isFrozen(finalized.resultManifest));
  await assert.rejects(journal.appendEvents("run-1", [event("run-1", 2)]), StudyStorageStateError);
  await assert.rejects(journal.exportPartial("run-1"), StudyStorageStateError);
  await assert.rejects(journal.discardPartial("run-1"), StudyStorageStateError);
  assert.deepEqual(await journal.listPartialRuns(), []);
});

test("a quota failure leaves the complete event batch uncommitted", async () => {
  const backend = new MemoryJournalBackend();
  const { journal } = createJournal({ backend });
  await begin(journal);
  const currentBytes = new TextEncoder().encode(JSON.stringify(backend.snapshot())).byteLength;
  backend.maxBytes = currentBytes + 32;
  await assert.rejects(
    journal.appendEvents("run-1", [event("run-1", 1, { value: "x".repeat(500) })]),
    StudyStorageQuotaError,
  );
  assert.equal((await journal.getRun("run-1")).nextSequence, 1);
  assert.deepEqual(await journal.readEvents("run-1"), []);
});

test("an interrupted batch is atomic and the exact batch can be retried", async () => {
  const backend = new MemoryJournalBackend();
  const { journal } = createJournal({ backend });
  await begin(journal);
  backend.failNext("commitBatch", new Error("simulated interruption"));
  await assert.rejects(
    journal.appendEvents("run-1", [event("run-1", 1), event("run-1", 2)]),
    /simulated interruption/,
  );
  assert.equal((await journal.getRun("run-1")).nextSequence, 1);
  assert.deepEqual(await journal.readEvents("run-1"), []);

  const retried = await journal.appendEvents("run-1", [event("run-1", 1), event("run-1", 2)]);
  assert.equal(retried.nextSequence, 3);
  assert.deepEqual((await journal.readEvents("run-1", { limit: 2 })).map((item) => item.sequence), [1, 2]);
});

test("a staged action survives an interrupted outcome commit and clears atomically on retry", async () => {
  const backend = new MemoryJournalBackend();
  const { journal } = createJournal({ backend });
  await begin(journal);
  const action = { actionId: "action-stage-1", runId: "run-1", command: { type: "advance" } };
  const staged = await journal.stageAction("run-1", action, { expectedNextSequence: 1 });
  assert.equal(staged.pendingAction.action.actionId, "action-stage-1");

  backend.failNext("commitBatch", new Error("simulated outcome interruption"));
  await assert.rejects(journal.appendEvents("run-1", [event("run-1", 1)], {
    expectedNextSequence: 1,
    stagedActionId: "action-stage-1",
  }), /simulated outcome interruption/);
  assert.equal((await journal.getRun("run-1")).pendingAction.action.actionId, "action-stage-1");
  assert.deepEqual(await journal.readEvents("run-1"), []);

  const committed = await journal.appendEvents("run-1", [event("run-1", 1)], {
    expectedNextSequence: 1,
    stagedActionId: "action-stage-1",
  });
  assert.equal(committed.pendingAction, null);
  assert.equal(committed.nextSequence, 2);
});

test("journal boundaries reject invalid IDs, hashes, checkpoint states, and manifests", async () => {
  const { journal } = createJournal();
  await assert.rejects(journal.createRun({
    runId: "bad/run",
    studyId: "study-1",
    protocolHash: HASH,
  }), StudyStorageValidationError);
  await assert.rejects(journal.createRun({
    runId: "run-1",
    studyId: "study-1",
    protocolHash: "bad",
  }), /SHA-256/);
  assert.throws(() => createRunCheckpoint({
    sequence: 0,
    position: "block-active",
    blockId: "video-1",
    blockKind: "unknown",
  }), /blockKind/);

  await begin(journal);
  await assert.rejects(journal.finalizeRun("run-1", {
    resultManifest: { runId: "other-run" },
  }), /matching runId/);
});

test("IndexedDB adapter fails clearly when browser primitives are unavailable", () => {
  assert.throws(
    () => new IndexedDbJournalBackend({ indexedDB: null, keyRange: null }),
    /IndexedDB is not available/,
  );
});
