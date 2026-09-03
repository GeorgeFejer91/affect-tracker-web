import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import initStudyCore, {
  publishStudyJsonV1,
  WasmStudyAuthorityV1,
} from "../site/vendor/study-core/affect_tracker_study_core.js";
import { createNativeStudyCore } from "../site/src/study/core-adapter.js";
import { MemoryJournalBackend } from "../site/src/study/memory-journal-backend.js";
import {
  BrowserStudySession,
  createRunConfiguration,
} from "../site/src/study/participant-runner.js";
import { StudyRunJournal } from "../site/src/study/run-journal.js";
import { createDefaultStudy } from "../site/src/study/schema.js";
import { createTestRunOwnership, FakeWebLocks } from "./helpers/fake-web-locks.js";

await initStudyCore({
  module_or_path: await readFile(new URL(
    "../site/vendor/study-core/affect_tracker_study_core_bg.wasm",
    import.meta.url,
  )),
});

function createExternallyControllableAuthority(study, configuration, generation) {
  const authority = new WasmStudyAuthorityV1(
    JSON.stringify(study),
    JSON.stringify(configuration),
    BigInt(generation),
  );
  const listeners = new Set();
  let actionSequence = 0;

  return Object.freeze({
    stateJson: () => authority.stateJson(),
    applyJson: (actionJson) => authority.applyJson(actionJson),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    applyExternal(command) {
      const state = JSON.parse(authority.stateJson());
      actionSequence += 1;
      const action = {
        schema: "affect-tracker-study-action",
        version: 1,
        actionId: `remote-action-${actionSequence}`,
        runId: state.runId,
        authorityGeneration: state.authorityGeneration,
        expectedRevision: state.revision,
        precondition: {
          expectedPhase: state.phase,
          ...(state.currentBlockId ? { expectedBlockId: state.currentBlockId } : {}),
        },
        clock: {
          monotonicMs: state.lastEventMonotonicMs + 1,
          wallTimeUtc: new Date(1_800_000_000_000 + actionSequence * 1_000).toISOString(),
        },
        command,
      };
      const outcome = JSON.parse(authority.applyJson(JSON.stringify(action)));
      for (const listener of listeners) listener({ action, outcome, source: "external" });
      return outcome;
    },
  });
}

function nextExternalOutcome(session) {
  return new Promise((resolve, reject) => {
    const unsubscribe = session.subscribeExternalOutcomes((detail) => {
      unsubscribe();
      if (detail.error) reject(detail.error);
      else resolve(detail);
    });
  });
}

function nextAcceptedExternalOutcome(session) {
  return new Promise((resolve) => {
    const unsubscribe = session.subscribeExternalAcceptedOutcomes((detail) => {
      unsubscribe();
      resolve(detail);
    });
  });
}

test("desktop remote outcomes update the browser mirror only after durable journal commits", async () => {
  const published = JSON.parse(publishStudyJsonV1(JSON.stringify(createDefaultStudy({
    studyId: "native-external-outcomes",
    title: "Native external outcomes",
  }))));
  const configuration = createRunConfiguration(published, {
    platform: "desktop",
    runId: "run-native-external-outcomes",
  });
  const backend = new MemoryJournalBackend();
  const journal = new StudyRunJournal({ backend });
  let nativeAuthority;
  const session = new BrowserStudySession({
    core: {
      implementation: "native-rust",
      createAuthority(study, runConfiguration, generation) {
        nativeAuthority = createExternallyControllableAuthority(study, runConfiguration, generation);
        return nativeAuthority;
      },
    },
    study: published,
    configuration,
    generation: 7,
    journal,
    runOwnership: createTestRunOwnership(),
  });

  try {
    await session.initialize({ autoStart: false });
    assert.equal(session.state().phase, "prepared");

    let observed = nextExternalOutcome(session);
    nativeAuthority.applyExternal({ type: "arm" });
    assert.equal((await observed).outcome.state.phase, "armed");

    observed = nextExternalOutcome(session);
    nativeAuthority.applyExternal({ type: "start" });
    assert.equal((await observed).outcome.state.phase, "running");

    observed = nextExternalOutcome(session);
    nativeAuthority.applyExternal({ type: "stop", reasonCode: "remote-stop" });
    const terminal = await observed;
    assert.equal(terminal.outcome.state.phase, "completed");
    assert.equal(terminal.result.manifest.completionStatus, "stoppedEarly");

    const retained = await journal.getRun(configuration.runId);
    assert.equal(retained.status, "finalized");
    assert.equal(retained.nextSequence - 1, terminal.outcome.state.lastEventSequence);
    assert.deepEqual(
      (await journal.readEvents(configuration.runId)).map(({ sequence }) => sequence),
      Array.from({ length: terminal.outcome.state.lastEventSequence }, (_, index) => index + 1),
    );
  } finally {
    await session.close();
  }
});

test("session close retains run ownership until an in-flight remote mirror commit settles", async () => {
  class GatedJournalBackend extends MemoryJournalBackend {
    constructor() {
      super();
      this.blockNextEventCommit = false;
      this.entered = new Promise((resolve) => { this.markEntered = resolve; });
      this.release = new Promise((resolve) => { this.releaseCommit = resolve; });
    }

    async commitBatch(input) {
      if (this.blockNextEventCommit && input.events.length > 0) {
        this.blockNextEventCommit = false;
        this.markEntered();
        await this.release;
      }
      return super.commitBatch(input);
    }
  }

  const published = JSON.parse(publishStudyJsonV1(JSON.stringify(createDefaultStudy({
    studyId: "native-close-fence",
    title: "Native close fence",
  }))));
  const configuration = createRunConfiguration(published, {
    platform: "desktop",
    runId: "run-native-close-fence",
  });
  const backend = new GatedJournalBackend();
  const locks = new FakeWebLocks();
  let nativeAuthority;
  const session = new BrowserStudySession({
    core: {
      implementation: "native-rust",
      createAuthority(study, runConfiguration, generation) {
        nativeAuthority = createExternallyControllableAuthority(study, runConfiguration, generation);
        return nativeAuthority;
      },
    },
    study: published,
    configuration,
    journal: new StudyRunJournal({ backend }),
    runOwnership: createTestRunOwnership(locks),
  });

  await session.initialize({ autoStart: false });
  backend.blockNextEventCommit = true;
  nativeAuthority.applyExternal({ type: "arm" });
  await backend.entered;

  const closing = session.close();
  assert.equal(locks.held.size, 1, "close must not expose an in-flight journal as abandoned");
  backend.releaseCommit();
  await closing;
  assert.equal(locks.held.size, 0);
});

test("an accepted native pause emits its safety signal before the browser journal commit", async () => {
  class GatedPauseBackend extends MemoryJournalBackend {
    constructor() {
      super();
      this.blockPause = false;
      this.entered = new Promise((resolve) => { this.markEntered = resolve; });
      this.release = new Promise((resolve) => { this.releaseCommit = resolve; });
    }

    async commitBatch(input) {
      if (this.blockPause && input.events.some(({ payload }) => payload.type === "runPaused")) {
        this.blockPause = false;
        this.markEntered();
        await this.release;
      }
      return super.commitBatch(input);
    }
  }

  const published = JSON.parse(publishStudyJsonV1(JSON.stringify(createDefaultStudy({
    studyId: "native-pause-safety-fence",
    title: "Native pause safety fence",
  }))));
  const configuration = createRunConfiguration(published, {
    platform: "desktop",
    runId: "run-native-pause-safety-fence",
  });
  const backend = new GatedPauseBackend();
  let nativeAuthority;
  const session = new BrowserStudySession({
    core: {
      implementation: "native-rust",
      createAuthority(study, runConfiguration, generation) {
        nativeAuthority = createExternallyControllableAuthority(study, runConfiguration, generation);
        return nativeAuthority;
      },
    },
    study: published,
    configuration,
    journal: new StudyRunJournal({ backend }),
    runOwnership: createTestRunOwnership(),
  });

  try {
    await session.initialize();
    backend.blockPause = true;
    const accepted = nextAcceptedExternalOutcome(session);
    const committed = nextExternalOutcome(session);
    nativeAuthority.applyExternal({ type: "pause", reasonCode: "remote-pause" });

    const safety = await accepted;
    assert.equal(safety.outcome.state.phase, "paused");
    await backend.entered;
    let durableNotification = false;
    void committed.then(() => { durableNotification = true; });
    await Promise.resolve();
    assert.equal(durableNotification, false, "state presentation must still wait for durable evidence");

    backend.releaseCommit();
    assert.equal((await committed).outcome.state.phase, "paused");
  } finally {
    backend.releaseCommit?.();
    await session.abort("test-cleanup").catch(() => {});
    await session.close();
  }
});

test("a newer remote outcome cannot erase an accepted local outcome that is still returning", async () => {
  const published = JSON.parse(publishStudyJsonV1(JSON.stringify(createDefaultStudy({
    studyId: "native-crossed-outcomes",
    title: "Native crossed outcomes",
  }))));
  const configuration = createRunConfiguration(published, {
    platform: "desktop",
    runId: "run-native-crossed-outcomes",
  });
  let nativeAuthority;
  let releaseArm;
  let markArmEntered;
  const armEntered = new Promise((resolve) => { markArmEntered = resolve; });
  const armRelease = new Promise((resolve) => { releaseArm = resolve; });
  const invoke = async (command, args) => {
    if (command === "publish_study_json") return published;
    if (command === "prepare_study_run") {
      nativeAuthority = new WasmStudyAuthorityV1(
        JSON.stringify(published),
        JSON.stringify(args.configuration),
        12n,
      );
      return JSON.parse(nativeAuthority.stateJson());
    }
    if (command === "apply_study_action") {
      const outcome = JSON.parse(nativeAuthority.applyJson(JSON.stringify(args.action)));
      if (args.action.command.type === "arm") {
        markArmEntered();
        await armRelease;
      }
      return outcome;
    }
    throw new Error(`Unexpected native command ${command}.`);
  };
  const core = createNativeStudyCore(invoke);
  const journal = new StudyRunJournal({ backend: new MemoryJournalBackend() });
  const session = new BrowserStudySession({
    core,
    study: published,
    configuration,
    journal,
    runOwnership: createTestRunOwnership(),
  });

  try {
    await session.initialize({ autoStart: false });
    const localArm = session.dispatch({ type: "arm" });
    await armEntered;

    const stateAfterNativeArm = JSON.parse(nativeAuthority.stateJson());
    const remoteAction = {
      schema: "affect-tracker-study-action",
      version: 1,
      actionId: "remote-start-after-local-arm",
      runId: stateAfterNativeArm.runId,
      authorityGeneration: stateAfterNativeArm.authorityGeneration,
      expectedRevision: stateAfterNativeArm.revision,
      precondition: {
        expectedPhase: stateAfterNativeArm.phase,
        ...(stateAfterNativeArm.currentBlockId
          ? { expectedBlockId: stateAfterNativeArm.currentBlockId }
          : {}),
      },
      clock: {
        monotonicMs: stateAfterNativeArm.lastEventMonotonicMs + 1,
        wallTimeUtc: "2027-01-15T08:00:00.000Z",
      },
      command: { type: "start" },
    };
    const remoteOutcome = await invoke("apply_study_action", { action: remoteAction });
    const observedRemote = nextExternalOutcome(session);
    assert.equal(core.acceptExternalOutcome(remoteAction, remoteOutcome), true);
    assert.equal(JSON.parse(nativeAuthority.stateJson()).phase, "running");

    releaseArm();
    const localOutcome = await localArm;
    assert.equal(localOutcome.state.phase, "armed");
    assert.equal((await observedRemote).outcome.state.phase, "running");
    assert.equal(session.state().phase, "running", "cached native state must not regress to armed");

    const events = await journal.readEvents(configuration.runId);
    assert.deepEqual(
      events.map(({ sequence }) => sequence),
      Array.from({ length: session.state().lastEventSequence }, (_, index) => index + 1),
    );
    assert.equal(events.filter(({ payload }) => payload.type === "armed").length, 1);
    assert.equal(events.filter(({ payload }) => payload.type === "runStarted").length, 1);
  } finally {
    releaseArm?.();
    await session.abort("test-cleanup").catch(() => {});
    await session.close();
  }
});

test("desktop retains a native-only abort path when the browser mirror journal fails", async () => {
  class FailNextExternalCommitBackend extends MemoryJournalBackend {
    constructor() {
      super();
      this.failNextEventCommit = false;
    }

    async commitBatch(input) {
      if (this.failNextEventCommit && input.events.length > 0) {
        this.failNextEventCommit = false;
        throw new Error("injected external mirror failure");
      }
      return super.commitBatch(input);
    }
  }

  const published = JSON.parse(publishStudyJsonV1(JSON.stringify(createDefaultStudy({
    studyId: "native-mirror-emergency-stop",
    title: "Native mirror emergency stop",
  }))));
  const configuration = createRunConfiguration(published, {
    platform: "desktop",
    runId: "run-native-mirror-emergency-stop",
  });
  const backend = new FailNextExternalCommitBackend();
  let nativeAuthority;
  const session = new BrowserStudySession({
    core: {
      implementation: "native-rust",
      createAuthority(study, runConfiguration, generation) {
        nativeAuthority = createExternallyControllableAuthority(study, runConfiguration, generation);
        return nativeAuthority;
      },
    },
    study: published,
    configuration,
    journal: new StudyRunJournal({ backend }),
    runOwnership: createTestRunOwnership(),
  });

  try {
    await session.initialize({ autoStart: false });
    backend.failNextEventCommit = true;
    const failedMirror = nextExternalOutcome(session);
    nativeAuthority.applyExternal({ type: "arm" });
    await assert.rejects(failedMirror, /injected external mirror failure/);

    const terminal = await session.stopNativeAfterMirrorFailure("local-emergency-abort");
    assert.equal(terminal.nativeOnly, true);
    assert.equal(terminal.state.phase, "aborted");
    assert.equal(session.state().phase, "aborted");
    assert.equal((await session.journal.getRun(configuration.runId)).status, "partial");
  } finally {
    await session.close();
  }
});

test("an accepted local pause stays paused while the exact pending journal outcome is retried", async () => {
  class FailPauseCommitBackend extends MemoryJournalBackend {
    constructor() {
      super();
      this.failed = false;
    }

    async commitBatch(input) {
      if (!this.failed && input.events.some(({ payload }) => payload.type === "runPaused")) {
        this.failed = true;
        throw new Error("injected pause journal failure");
      }
      return super.commitBatch(input);
    }
  }

  const published = JSON.parse(publishStudyJsonV1(JSON.stringify(createDefaultStudy({
    studyId: "native-pause-journal-retry",
    title: "Native pause journal retry",
  }))));
  const configuration = createRunConfiguration(published, {
    platform: "desktop",
    runId: "run-native-pause-journal-retry",
  });
  const backend = new FailPauseCommitBackend();
  let authority;
  const session = new BrowserStudySession({
    core: {
      implementation: "native-rust",
      createAuthority(study, runConfiguration, generation) {
        authority = createExternallyControllableAuthority(study, runConfiguration, generation);
        return authority;
      },
    },
    study: published,
    configuration,
    journal: new StudyRunJournal({ backend }),
    runOwnership: createTestRunOwnership(),
  });

  try {
    await session.initialize();
    await assert.rejects(
      session.dispatch({ type: "pause", reasonCode: "local-pause" }),
      /journal commit was interrupted/,
    );
    const acceptedRevision = session.state().revision;
    assert.equal(session.state().phase, "paused");
    assert.deepEqual(session.pendingJournalCommand(), { type: "pause", reasonCode: "local-pause" });

    const recovered = await session.retryPendingJournalOutcome();
    assert.equal(recovered.state.phase, "paused");
    assert.equal(session.state().revision, acceptedRevision, "retry must not issue an opposite resume action");
    assert.equal(session.pendingJournalCommand(), undefined);
    const events = await session.journal.readEvents(configuration.runId);
    assert.equal(events.filter(({ payload }) => payload.type === "runPaused").length, 1);
  } finally {
    await session.abort("test-cleanup").catch(() => {});
    await session.close();
  }
});

test("desktop partial retention terminates native authority without finalizing its failed browser mirror", async () => {
  class PermanentlyFailPauseMirrorBackend extends MemoryJournalBackend {
    constructor() {
      super();
      this.failPauseMirror = false;
    }

    async commitBatch(input) {
      if (this.failPauseMirror
        && input.events.some(({ payload }) => payload.type === "runPaused")) {
        throw new Error("permanent desktop mirror failure");
      }
      return super.commitBatch(input);
    }
  }

  const published = JSON.parse(publishStudyJsonV1(JSON.stringify(createDefaultStudy({
    studyId: "native-local-partial-retention",
    title: "Native local partial retention",
  }))));
  const configuration = createRunConfiguration(published, {
    platform: "desktop",
    runId: "run-native-local-partial-retention",
  });
  const backend = new PermanentlyFailPauseMirrorBackend();
  let nativeAuthority;
  const session = new BrowserStudySession({
    core: {
      implementation: "native-rust",
      createAuthority(study, runConfiguration, generation) {
        nativeAuthority = createExternallyControllableAuthority(study, runConfiguration, generation);
        return nativeAuthority;
      },
    },
    study: published,
    configuration,
    journal: new StudyRunJournal({ backend }),
    runOwnership: createTestRunOwnership(),
  });

  await session.initialize();
  backend.failPauseMirror = true;
  await assert.rejects(
    session.dispatch({ type: "pause", reasonCode: "local-pause" }),
    /journal commit was interrupted/,
  );
  const staged = await session.journal.getRun(configuration.runId);
  assert.equal(staged.pendingAction.action.command.type, "pause");
  assert.equal(session.state().phase, "paused");

  const retained = await session.abandonPendingJournalOutcome({
    reasonCode: "local-evidence-write-unrecoverable",
  });
  assert.equal(retained.nativeAuthorityTerminated, true);
  assert.ok(["completed", "aborted"].includes(retained.authorityState.phase));
  assert.equal(JSON.parse(nativeAuthority.stateJson()).phase, retained.authorityState.phase);
  const mirror = await session.journal.getRun(configuration.runId);
  assert.equal(mirror.status, "partial");
  assert.equal(mirror.pendingAction.action.command.type, "pause");
  assert.equal(
    (await session.journal.readEvents(configuration.runId))
      .filter(({ payload }) => payload.type === "runPaused").length,
    0,
    "the failed accepted pause must not be fabricated into the browser mirror",
  );
});
