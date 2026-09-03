import assert from "node:assert/strict";
import test from "node:test";

import { MemoryJournalBackend } from "../site/src/study/memory-journal-backend.js";
import {
  finalizedRunArtifacts,
  PartialRunRecoveryService,
  partialRunArtifacts,
} from "../site/src/study/partial-recovery.js";
import { eventsToLongCsv, sha256TextHex } from "../site/src/study/participant-runner.js";
import {
  partialRecoveryMarkup,
  recoveryArtifactLinksMarkup,
  recoveryPreparationMessage,
} from "../site/src/study/partial-recovery-ui.js";
import { StudyRunJournal } from "../site/src/study/run-journal.js";
import { StudyStorageConflictError } from "../site/src/study/storage-common.js";
import {
  createTestRunOwnership,
  FakeWebLocks,
} from "./helpers/fake-web-locks.js";

const protocolHash = "a".repeat(64);

async function partialJournal() {
  const journal = new StudyRunJournal({
    backend: new MemoryJournalBackend(),
    now: () => new Date("2026-09-03T12:00:00.000Z"),
  });
  await journal.createRun({
    runId: "run-recovery-1",
    studyId: "study-recovery",
    protocolHash,
    metadata: { platform: "pages2d" },
  });
  await journal.appendEvents("run-recovery-1", [{
    schema: "affect-tracker-run-event",
    version: 1,
    sequence: 1,
    authorityGeneration: 1,
    revision: 1,
    runId: "run-recovery-1",
    sectionId: "section-1",
    trialId: "trial-1",
    blockId: "instruction-1",
    monotonicMs: 10,
    wallTimeUtc: "2026-09-03T12:00:00.000Z",
    payload: { type: "runPrepared" },
  }]);
  return journal;
}

test("partial recovery exposes only export and destructive restart", async () => {
  const service = new PartialRunRecoveryService({
    journal: await partialJournal(),
    runOwnership: createTestRunOwnership(),
  });
  const [summary] = await service.list();

  assert.equal(summary.runId, "run-recovery-1");
  assert.equal(summary.eventCount, 1);
  assert.deepEqual(summary.allowedActions, ["export-partial", "discard-and-restart"]);
  assert.equal("resume" in summary, false);

  await service.close();
});

test("partial recovery produces matching JSON and long-form CSV artifacts", async () => {
  const service = new PartialRunRecoveryService({
    journal: await partialJournal(),
    runOwnership: createTestRunOwnership(),
  });
  const artifacts = await service.export("run-recovery-1");
  const exported = JSON.parse(artifacts.json.content);

  assert.equal(artifacts.json.name, "study-recovery-run-recovery-1.partial.json");
  assert.equal(artifacts.csv.name, "study-recovery-run-recovery-1.partial.csv");
  assert.equal(exported.completionStatus, "partial");
  assert.equal(exported.events.length, 1);
  assert.match(artifacts.csv.content, /^sequence,authority_generation,revision,run_id,/);
  assert.match(artifacts.csv.content, /runPrepared/);
  assert.equal((await service.list()).length, 1, "export must not discard evidence");

  await service.close();
});

test("discard removes the selected partial run and cannot be confused with export", async () => {
  const service = new PartialRunRecoveryService({
    journal: await partialJournal(),
    runOwnership: createTestRunOwnership(),
  });
  assert.deepEqual(await service.discard("run-recovery-1"), []);
  await assert.rejects(service.export("run-recovery-1"));
  await service.close();
});

test("partial artifact builder rejects non-partial records and sanitizes download names", () => {
  assert.throws(() => partialRunArtifacts({ completionStatus: "completed" }), TypeError);
  const artifacts = partialRunArtifacts({
    protocol: "affect-tracker-partial-run-export",
    version: 1,
    exportedAt: "2026-09-03T12:00:00.000Z",
    completionStatus: "partial",
    run: { runId: "run / one", studyId: "study:unsafe" },
    events: [],
    recovery: { strategy: "restart-run" },
  });
  assert.equal(artifacts.json.name, "study-unsafe-run-one.partial.json");
});

test("recovery notice offers export or destructive restart without a resume control", () => {
  const html = partialRecoveryMarkup([{
    runId: "run-recovery-1",
    studyId: "study-recovery",
    status: "partial",
    completionStatus: "partial",
    updatedAt: "2026-09-03T12:00:00.000Z",
    eventCount: 4,
    pendingAction: { actionId: "action-uncommitted-1", commandType: "recordAffectSample" },
    discardAllowed: true,
    allowedActions: ["export-partial", "discard-and-restart"],
  }]);
  assert.match(html, /data-recovery-export="run-recovery-1"/);
  assert.match(html, /data-recovery-discard="run-recovery-1"/);
  assert.match(html, /Discard and restart/);
  assert.match(html, /Partial · uncommitted recordAffectSample outcome/);
  assert.match(html, /action-uncommitted-1/);
  assert.match(html, /data-loss boundary/);
  assert.doesNotMatch(html, /data-recovery-resume/);
});

test("recovery notice hides discard when cross-tab ownership cannot be proven", () => {
  const html = partialRecoveryMarkup([{
    runId: "run-recovery-1",
    studyId: "study-recovery",
    status: "partial",
    completionStatus: "partial",
    updatedAt: "2026-09-03T12:00:00.000Z",
    eventCount: 4,
    discardAllowed: false,
    allowedActions: ["export-partial", "discard-and-restart"],
  }]);
  assert.match(html, /data-recovery-export="run-recovery-1"/);
  assert.doesNotMatch(html, /data-recovery-discard/);
  assert.match(html, /Safe discard is unavailable without Web Locks/);
  assert.match(html, /Preparing downloads remains available/);
});

test("one corrupt retained record cannot hide healthy recovery evidence", async () => {
  const journal = await partialJournal();
  journal.backend.runs.set("corrupt-run", {
    runId: "corrupt-run",
    studyId: "study-corrupt",
    status: "partial",
    nextSequence: "not-an-integer",
  });
  const service = new PartialRunRecoveryService({
    journal,
    runOwnership: createTestRunOwnership(),
  });

  const listing = await service.listWithIssues();
  assert.equal(listing.runs.length, 1);
  assert.equal(listing.runs[0].runId, "run-recovery-1");
  assert.equal(listing.issues.length, 1);
  assert.equal(listing.issues[0].recordId, "corrupt-run");
  const html = partialRecoveryMarkup(listing.runs, listing.issues);
  assert.match(html, /run-recovery-1/);
  assert.match(html, /Unreadable stored record/);
  assert.match(html, /corrupt-run/);

  await service.close();
});

test("prepared recovery artifacts require two explicit downloads and make no save claim", () => {
  const artifacts = {
    evidenceStatus: "finalized",
    json: {
      name: "study-run.manifest.json",
      type: "application/json;charset=utf-8",
      content: "{}\n",
    },
    csv: {
      name: "study-run.csv",
      type: "text/csv;charset=utf-8",
      content: "sequence\r\n",
    },
  };
  const html = recoveryArtifactLinksMarkup(artifacts, {
    json: "blob:https://example.test/manifest",
    csv: "blob:https://example.test/csv",
  });
  const message = recoveryPreparationMessage(artifacts);

  assert.equal((html.match(/<a /g) ?? []).length, 2);
  assert.match(html, /href="blob:https:\/\/example\.test\/manifest" download="study-run\.manifest\.json"/);
  assert.match(html, /href="blob:https:\/\/example\.test\/csv" download="study-run\.csv"/);
  assert.match(html, />Download manifest<.*>Download CSV</);
  assert.match(message, /prepared/i);
  assert.match(message, /cannot confirm that either file was saved/i);
  assert.match(message, /stored evidence remains retained/i);
  assert.doesNotMatch(message, /\bexported\b/i);
});

test("an active per-run Web Lock excludes the run from recovery", async () => {
  const locks = new FakeWebLocks();
  const activeOwnership = createTestRunOwnership(locks);
  const recoveryOwnership = createTestRunOwnership(locks);
  const handle = await activeOwnership.acquire("run-recovery-1");
  const service = new PartialRunRecoveryService({
    journal: await partialJournal(),
    runOwnership: recoveryOwnership,
  });

  assert.deepEqual(await service.list(), []);
  await handle.release();
  assert.equal((await service.list()).length, 1);
  await service.close();
});

test("discard fails closed without Web Locks while non-destructive export remains available", async () => {
  const journal = await partialJournal();
  const service = new PartialRunRecoveryService({
    journal,
    runOwnership: createTestRunOwnership(null),
  });
  const [summary] = await service.list();

  assert.deepEqual(summary.allowedActions, ["export-partial"]);
  assert.equal(summary.discardAllowed, false);
  assert.equal((await service.export(summary.runId)).evidenceStatus, "partial");
  await assert.rejects(service.discard(summary.runId), /Web Locks is unavailable/);
  assert.equal((await journal.getRun(summary.runId)).status, "partial");
  await service.close();
});

test("a finalized run can be reopened and exports its retained manifest plus byte-identical CSV", async () => {
  const journal = await partialJournal();
  const backend = journal.backend;
  const events = await journal.readEvents("run-recovery-1");
  const csv = eventsToLongCsv(events);
  const manifest = {
    schema: "affect-tracker-result-manifest",
    version: 1,
    resultId: "result-recovery-1",
    runId: "run-recovery-1",
    completionStatus: "completed",
    eventCount: events.length,
    csvSha256: await sha256TextHex(csv),
  };
  await journal.finalizeRun("run-recovery-1", { resultManifest: manifest });
  await journal.close();

  const reopened = new StudyRunJournal({
    backend,
    now: () => new Date("2026-09-03T12:05:00.000Z"),
  });
  const service = new PartialRunRecoveryService({
    journal: reopened,
    runOwnership: createTestRunOwnership(),
  });
  const [summary] = await service.list();
  assert.equal(summary.status, "finalized");
  assert.equal(summary.completionStatus, "completed");
  assert.deepEqual(summary.allowedActions, ["export-finalized", "discard-finalized"]);

  const artifacts = await service.export(summary.runId);
  assert.equal(artifacts.evidenceStatus, "finalized");
  assert.equal(artifacts.csv.content, csv);
  assert.equal(artifacts.csv.name, "study-recovery-run-recovery-1.csv");
  assert.equal(artifacts.json.name, "study-recovery-run-recovery-1.manifest.json");
  assert.deepEqual(JSON.parse(artifacts.json.content), manifest);
  assert.doesNotMatch(artifacts.csv.name, /partial/);
  assert.equal((await service.list()).length, 1, "finalized evidence remains until explicit discard");
  await service.close();
});

test("finalized artifact export rejects a CSV digest mismatch", async () => {
  await assert.rejects(finalizedRunArtifacts({
    protocol: "affect-tracker-finalized-run-export",
    version: 1,
    completionStatus: "completed",
    run: { runId: "run-final", studyId: "study-final", status: "finalized" },
    events: [],
    resultManifest: {
      runId: "run-final",
      completionStatus: "completed",
      csvSha256: "0".repeat(64),
    },
  }), /no longer matches its CSV digest/);
});

class RacingDeleteBackend extends MemoryJournalBackend {
  async deleteRun(request) {
    const race = this.beforeDelete;
    this.beforeDelete = undefined;
    if (race) await race();
    return super.deleteRun(request);
  }
}

test("discard rejects an append committed between authorization read and atomic delete", async () => {
  const backend = new RacingDeleteBackend();
  const journal = new StudyRunJournal({ backend, now: () => new Date("2026-09-03T12:00:00.000Z") });
  await journal.createRun({
    runId: "run-delete-race",
    studyId: "study-recovery",
    protocolHash,
  });
  backend.beforeDelete = () => backend.commitBatch({
    runId: "run-delete-race",
    expectedNextSequence: 1,
    events: [{
      schema: "affect-tracker-run-event",
      version: 1,
      runId: "run-delete-race",
      sequence: 1,
      payload: { type: "runPrepared" },
    }],
    nextSequence: 2,
    updatedAt: "2026-09-03T12:00:01.000Z",
  });
  const service = new PartialRunRecoveryService({
    journal,
    runOwnership: createTestRunOwnership(),
  });

  await assert.rejects(service.discard("run-delete-race"), StudyStorageConflictError);
  assert.equal((await journal.getRun("run-delete-race")).nextSequence, 2);
  await service.close();
});

test("discard rejects finalization committed between authorization read and atomic delete", async () => {
  const backend = new RacingDeleteBackend();
  const journal = new StudyRunJournal({ backend, now: () => new Date("2026-09-03T12:00:00.000Z") });
  await journal.createRun({
    runId: "run-finalize-race",
    studyId: "study-recovery",
    protocolHash,
  });
  backend.beforeDelete = () => backend.finalizeRun({
    runId: "run-finalize-race",
    expectedNextSequence: 1,
    updatedAt: "2026-09-03T12:00:01.000Z",
    finalizedAt: "2026-09-03T12:00:01.000Z",
    resultManifest: {
      runId: "run-finalize-race",
      completionStatus: "completed",
      csvSha256: "0".repeat(64),
    },
  });
  const service = new PartialRunRecoveryService({
    journal,
    runOwnership: createTestRunOwnership(),
  });

  await assert.rejects(service.discard("run-finalize-race"), StudyStorageConflictError);
  assert.equal((await journal.getRun("run-finalize-race")).status, "finalized");
  await service.close();
});
