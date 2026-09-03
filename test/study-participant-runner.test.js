import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserStudySession,
  createRunConfiguration,
  eventsToLongCsv,
  findStudyBlock,
  randomRunSeed,
} from "../site/src/study/participant-runner.js";
import { MemoryJournalBackend } from "../site/src/study/memory-journal-backend.js";
import { StudyRunJournal } from "../site/src/study/run-journal.js";
import { PartialRunRecoveryService } from "../site/src/study/partial-recovery.js";
import { createDefaultStudy } from "../site/src/study/schema.js";
import { createTestRunOwnership, FakeWebLocks } from "./helpers/fake-web-locks.js";

test("run configuration adds only order inputs required by the study", () => {
  const fixed = createDefaultStudy({ studyId: "runner-fixed" });
  const fixedConfiguration = createRunConfiguration(fixed, {
    runId: "run-fixed",
    platform: "pages2d",
  });
  assert.equal(fixedConfiguration.randomSeed, undefined);
  assert.equal(fixedConfiguration.counterbalanceGroup, undefined);

  fixed.sections.push({
    sectionId: "randomized",
    title: "Randomized",
    orderPolicy: { type: "seededShuffle" },
    trials: [{ trialId: "one", label: "One", blocks: [{ type: "break", blockId: "break-one", content: "Break", minimumDurationMs: 0 }] }],
  });
  fixed.sections.push({
    sectionId: "balanced",
    title: "Balanced",
    orderPolicy: { type: "williamsBalancedLatinSquare" },
    trials: [{ trialId: "two", label: "Two", blocks: [{ type: "break", blockId: "break-two", content: "Break", minimumDurationMs: 0 }] }],
  });
  const ordered = createRunConfiguration(fixed, {
    runId: "run-ordered",
    platform: "webXr",
    randomSeed: "00112233445566778899aabbccddeeff",
    counterbalanceGroup: 1,
  });
  assert.equal(ordered.randomSeed, "00112233445566778899aabbccddeeff");
  assert.equal(ordered.counterbalanceGroup, 1);
  assert.ok(ordered.platform.capabilities.includes("immersivePanels"));
});

test("secure run seeds contain exactly 128 lowercase hexadecimal bits", () => {
  assert.match(randomRunSeed(), /^[0-9a-f]{32}$/);
});

test("block lookup traverses every section and trial", () => {
  const study = createDefaultStudy({ studyId: "runner-lookup" });
  assert.equal(findStudyBlock(study, "pre-run-questionnaire")?.type, "questionnaire");
  assert.equal(findStudyBlock(study, "absent"), undefined);
});

test("long CSV keeps typed payload JSON in one escaped cell", () => {
  const csv = eventsToLongCsv([{
    sequence: 1,
    authorityGeneration: 2,
    revision: 1,
    runId: "run-one",
    sectionId: "main",
    trialId: "trial-one",
    blockId: "questionnaire",
    monotonicMs: 25,
    wallTimeUtc: "2026-09-03T12:00:00.000Z",
    payload: { type: "questionnaireSubmitted", answers: [{ itemId: "choice", optionId: "a,b" }] },
  }]);
  assert.match(csv, /^sequence,authority_generation,/);
  assert.match(csv, /questionnaireSubmitted/);
  assert.match(csv, /""a,b""/);
  assert.ok(csv.endsWith("\r\n"));
});

test("an interrupted journal commit locks the authority and retries without skipping a block", async () => {
  class FailOutcomeCommitBackend extends MemoryJournalBackend {
    constructor() {
      super();
      this.commitCount = 0;
    }

    async commitBatch(input) {
      this.commitCount += 1;
      if (this.commitCount === 2) throw new Error("simulated journal interruption");
      return super.commitBatch(input);
    }
  }

  const backend = new FailOutcomeCommitBackend();
  let clock = 0;
  const journal = new StudyRunJournal({
    backend,
    now: () => new Date(1_700_000_000_000 + clock++ * 1000),
  });
  const study = {
    studyId: "journal-lock-study",
    revision: 1,
    protocolHash: "d".repeat(64),
    pinnedSettings: { portableSettingsSha256: "e".repeat(64) },
    media: [],
    sections: [{
      sectionId: "main",
      trials: [{
        trialId: "trial",
        blocks: [
          { type: "instruction", blockId: "first", content: "First", presentation: "standard" },
          { type: "instruction", blockId: "second", content: "Second", presentation: "standard" },
        ],
      }],
    }],
  };
  const configuration = { runId: "journal-lock-run", platform: { platform: "pages2d" } };
  await journal.createRun({
    runId: configuration.runId,
    studyId: study.studyId,
    protocolHash: study.protocolHash,
  });
  let applyCount = 0;
  let authorityState = {
    runId: configuration.runId,
    authorityGeneration: 1,
    revision: 0,
    phase: "running",
    currentSectionId: "main",
    currentTrialId: "trial",
    currentBlockId: "first",
    lastEventSequence: 0,
    lastEventMonotonicMs: 0,
  };
  const authority = {
    stateJson: () => JSON.stringify(authorityState),
    applyJson: async (actionJson) => {
      applyCount += 1;
      const action = JSON.parse(actionJson);
      authorityState = {
        ...authorityState,
        revision: 1,
        currentBlockId: "second",
        lastEventSequence: 1,
        lastEventMonotonicMs: action.clock.monotonicMs,
      };
      return JSON.stringify({
        state: authorityState,
        events: [{
          schema: "affect-tracker-run-event",
          version: 1,
          sequence: 1,
          runId: configuration.runId,
          payload: { type: "blockAdvanced" },
        }],
      });
    },
  };
  const session = new BrowserStudySession({
    core: { createAuthority: async () => authority },
    study,
    configuration,
    journal,
    runOwnership: createTestRunOwnership(),
    monotonicNow: () => 10,
    now: () => new Date("2026-09-03T12:00:00Z"),
    randomUuid: () => "journal-action",
  });
  session.authority = authority;

  await assert.rejects(session.advance(), /run is locked against further actions/);
  assert.equal(session.state().currentBlockId, "second");
  assert.equal((await journal.getRun(configuration.runId)).pendingAction.action.actionId, "action-journal-action");
  assert.equal(applyCount, 1);

  const retried = await session.advance();
  assert.equal(retried.state.currentBlockId, "second");
  assert.equal(applyCount, 1, "retry must commit the accepted outcome without applying advance again");
  assert.equal((await journal.getRun(configuration.runId)).pendingAction, null);
  assert.deepEqual((await journal.readEvents(configuration.runId)).map(({ sequence }) => sequence), [1]);
});

test("explicit partial retention abandons only the rejected staged outcome and releases recovery ownership", async () => {
  class FailSelectedEventCommitBackend extends MemoryJournalBackend {
    constructor() {
      super();
      this.failEventCommit = false;
      this.failClose = false;
    }

    async commitBatch(input) {
      if (this.failEventCommit && input.events.length > 0) {
        throw new Error("permanent evidence quota failure");
      }
      return super.commitBatch(input);
    }

    async close() {
      if (this.failClose) throw new Error("injected backend close warning");
      return super.close();
    }
  }

  const backend = new FailSelectedEventCommitBackend();
  const journal = new StudyRunJournal({ backend });
  const locks = new FakeWebLocks();
  const runOwnership = createTestRunOwnership(locks);
  const study = {
    studyId: "partial-retention-study",
    revision: 1,
    protocolHash: "a".repeat(64),
    pinnedSettings: { portableSettingsSha256: "b".repeat(64) },
    media: [],
    sections: [{
      sectionId: "main",
      trials: [{
        trialId: "trial",
        blocks: [{ type: "instruction", blockId: "first", content: "First", presentation: "standard" }],
      }],
    }],
  };
  const configuration = { runId: "partial-retention-run", platform: { platform: "pages2d" } };
  await journal.createRun({
    runId: configuration.runId,
    studyId: study.studyId,
    protocolHash: study.protocolHash,
  });
  let applyCount = 0;
  let authorityState = {
    runId: configuration.runId,
    authorityGeneration: 1,
    revision: 0,
    phase: "running",
    currentSectionId: "main",
    currentTrialId: "trial",
    currentBlockId: "first",
    lastEventSequence: 0,
    lastEventMonotonicMs: 0,
  };
  const authority = {
    stateJson: () => JSON.stringify(authorityState),
    applyJson: async (actionJson) => {
      applyCount += 1;
      const action = JSON.parse(actionJson);
      const sequence = authorityState.lastEventSequence + 1;
      authorityState = {
        ...authorityState,
        revision: authorityState.revision + 1,
        lastEventSequence: sequence,
        lastEventMonotonicMs: action.clock.monotonicMs,
      };
      return JSON.stringify({
        state: authorityState,
        events: [{
          schema: "affect-tracker-run-event",
          version: 1,
          sequence,
          runId: configuration.runId,
          payload: { type: action.command.type },
        }],
      });
    },
  };
  let actionSequence = 0;
  const session = new BrowserStudySession({
    core: { implementation: "wasm", createAuthority: async () => authority },
    study,
    configuration,
    journal,
    runOwnership,
    monotonicNow: () => 10 + applyCount,
    now: () => new Date("2026-09-03T12:00:00Z"),
    randomUuid: () => `partial-action-${++actionSequence}`,
  });
  session.authority = authority;

  await session.reportMedia(0, true);
  backend.failEventCommit = true;
  await assert.rejects(
    session.recordAffect({ currentValence: 0.2, currentArousal: -0.1 }),
    /run is locked against further actions/,
  );
  const stagedBefore = await journal.getRun(configuration.runId);
  assert.equal(stagedBefore.pendingAction.action.command.type, "recordAffectSample");
  assert.equal(applyCount, 2);

  const recovery = new PartialRunRecoveryService({
    journal: new StudyRunJournal({ backend }),
    runOwnership: createTestRunOwnership(locks),
  });
  assert.deepEqual(await recovery.list(), [], "an active run lock must hide the journal from recovery");

  backend.failClose = true;
  const retained = await session.abandonPendingJournalOutcome({
    reasonCode: "test-permanent-evidence-failure",
  });
  assert.equal(retained.browserEvidenceStatus, "partial");
  assert.equal(retained.nativeAuthorityTerminated, false);
  assert.equal(retained.stagedAction.commandType, "recordAffectSample");
  assert.equal(retained.dataLossReason, "accepted-action-outcome-not-durably-committed");
  assert.match(retained.teardownWarning, /injected backend close warning/);
  assert.equal(applyCount, 2, "partial retention must never replay or terminate the WASM authority");
  await assert.rejects(session.advance(), /session is closed/);

  backend.failClose = false;
  const listing = await recovery.list();
  assert.equal(listing.length, 1);
  assert.equal(listing[0].status, "partial");
  assert.equal(listing[0].pendingAction.commandType, "recordAffectSample");
  const exported = await recovery.export(configuration.runId);
  const partial = JSON.parse(exported.json.content);
  assert.equal(partial.events.length, 1, "previously committed evidence must remain exportable");
  assert.equal(partial.run.pendingAction.action.command.type, "recordAffectSample");
  assert.deepEqual(
    await session.abandonPendingJournalOutcome({ reasonCode: "ignored-idempotent-repeat" }),
    retained,
  );
  await recovery.close();
});

test("partial retention waits for an unresolved journal transaction before releasing its Web Lock", async () => {
  let rejectCommit;
  const unresolvedCommit = new Promise((resolve, reject) => {
    rejectCommit = reject;
  });
  class HangingEventCommitBackend extends MemoryJournalBackend {
    async commitBatch(input) {
      if (input.events.length > 0) return unresolvedCommit;
      return super.commitBatch(input);
    }
  }

  const backend = new HangingEventCommitBackend();
  const journal = new StudyRunJournal({ backend });
  const locks = new FakeWebLocks();
  const study = {
    studyId: "partial-retention-lock-study",
    revision: 1,
    protocolHash: "c".repeat(64),
    pinnedSettings: { portableSettingsSha256: "d".repeat(64) },
    media: [],
    sections: [{
      sectionId: "main",
      trials: [{
        trialId: "trial",
        blocks: [{ type: "instruction", blockId: "first", content: "First", presentation: "standard" }],
      }],
    }],
  };
  const configuration = { runId: "partial-retention-lock-run", platform: { platform: "pages2d" } };
  await journal.createRun({
    runId: configuration.runId,
    studyId: study.studyId,
    protocolHash: study.protocolHash,
  });
  let authorityState = {
    runId: configuration.runId,
    authorityGeneration: 1,
    revision: 0,
    phase: "running",
    currentSectionId: "main",
    currentTrialId: "trial",
    currentBlockId: "first",
    lastEventSequence: 0,
    lastEventMonotonicMs: 0,
  };
  const authority = {
    stateJson: () => JSON.stringify(authorityState),
    applyJson: async (actionJson) => {
      const action = JSON.parse(actionJson);
      authorityState = {
        ...authorityState,
        revision: 1,
        lastEventSequence: 1,
        lastEventMonotonicMs: action.clock.monotonicMs,
      };
      return JSON.stringify({
        state: authorityState,
        events: [{ sequence: 1, runId: configuration.runId, payload: { type: "recordAffectSample" } }],
      });
    },
  };
  const session = new BrowserStudySession({
    core: { implementation: "wasm", createAuthority: async () => authority },
    study,
    configuration,
    journal,
    runOwnership: createTestRunOwnership(locks),
    randomUuid: () => "hanging-action",
  });
  session.authority = authority;

  const failedWrite = assert.rejects(
    session.recordAffect({ currentValence: 0, currentArousal: 0 }),
    /journal commit was interrupted/,
  );
  for (let attempt = 0; attempt < 20 && !session.pendingJournalCommand(); attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(session.pendingJournalCommand().type, "recordAffectSample");

  let abandonmentSettled = false;
  const abandonment = session.abandonPendingJournalOutcome().finally(() => {
    abandonmentSettled = true;
  });
  await Promise.resolve();
  assert.equal(abandonmentSettled, false);
  await assert.rejects(session.advance(), /retaining its partial evidence/);
  const recovery = new PartialRunRecoveryService({
    journal: new StudyRunJournal({ backend }),
    runOwnership: createTestRunOwnership(locks),
  });
  assert.deepEqual(await recovery.list(), [], "recovery must not race the unresolved transaction");

  rejectCommit(new Error("transaction finally rejected"));
  await failedWrite;
  const retained = await abandonment;
  assert.equal(retained.stagedAction.commandType, "recordAffectSample");
  assert.equal((await recovery.list()).length, 1, "recovery becomes visible only after rejection and lock release");
  await recovery.close();
});

test("storage is established before authority creation and is removed if creation fails", async () => {
  const published = createDefaultStudy({
    studyId: "authority-create-cleanup",
    title: "Authority create cleanup",
  });
  published.protocolHash = "a".repeat(64);
  const backend = new MemoryJournalBackend();
  const journal = new StudyRunJournal({ backend });
  let sawJournalBeforeAuthority = false;
  const session = new BrowserStudySession({
    core: {
      async createAuthority() {
        sawJournalBeforeAuthority = Boolean(await journal.getRun("run-authority-create-cleanup"));
        throw new Error("injected authority creation failure");
      },
    },
    study: published,
    configuration: createRunConfiguration(published, {
      platform: "pages2d",
      runId: "run-authority-create-cleanup",
    }),
    journal,
    runOwnership: createTestRunOwnership(),
  });

  await assert.rejects(session.initialize(), /injected authority creation failure/);
  assert.equal(sawJournalBeforeAuthority, true);
  assert.equal(await journal.getRun("run-authority-create-cleanup"), undefined);
});
