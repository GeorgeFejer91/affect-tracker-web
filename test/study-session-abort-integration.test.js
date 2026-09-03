import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import initStudyCore, {
  publishStudyJsonV1,
  WasmStudyAuthorityV1,
} from "../site/vendor/study-core/affect_tracker_study_core.js";
import {
  BrowserStudySession,
  createRunConfiguration,
} from "../site/src/study/participant-runner.js";
import { MemoryJournalBackend } from "../site/src/study/memory-journal-backend.js";
import { PartialRunRecoveryService } from "../site/src/study/partial-recovery.js";
import { StudyRunJournal } from "../site/src/study/run-journal.js";
import { createDefaultStudy } from "../site/src/study/schema.js";
import { createTestRunOwnership, FakeWebLocks } from "./helpers/fake-web-locks.js";

await initStudyCore({
  module_or_path: await readFile(new URL(
    "../site/vendor/study-core/affect_tracker_study_core_bg.wasm",
    import.meta.url,
  )),
});

test("a partially initialized run is explicitly aborted before its journal is finalized", async () => {
  const study = JSON.parse(publishStudyJsonV1(JSON.stringify(createDefaultStudy({
    studyId: "partial-initialization-abort",
    title: "Partial initialization abort",
  }))));
  let rejectSettingsOnce = true;
  const core = {
    createAuthority(definition, configuration, generation) {
      const authority = new WasmStudyAuthorityV1(
        JSON.stringify(definition),
        JSON.stringify(configuration),
        BigInt(generation),
      );
      return {
        stateJson: () => authority.stateJson(),
        applyJson(actionJson) {
          const action = JSON.parse(actionJson);
          if (action.command.type === "applyPinnedSettings" && rejectSettingsOnce) {
            rejectSettingsOnce = false;
            throw new Error("injected settings adapter failure");
          }
          return authority.applyJson(actionJson);
        },
      };
    },
  };
  const configuration = createRunConfiguration(study, {
    platform: "pages2d",
    runId: "run-partial-initialization-abort",
  });
  const locks = new FakeWebLocks();
  const runOwnership = createTestRunOwnership(locks);
  const journal = new StudyRunJournal({ backend: new MemoryJournalBackend() });
  const recovery = new PartialRunRecoveryService({ journal, runOwnership });
  const session = new BrowserStudySession({
    core,
    study,
    configuration,
    journal,
    runOwnership,
  });

  try {
    await assert.rejects(session.initialize(), /injected settings adapter failure/);
    assert.equal(session.state().phase, "prepared");
    assert.deepEqual(
      await recovery.list(),
      [],
      "recovery must not expose the partially initialized journal before cleanup",
    );

    const result = await session.abort("initialization-failed");
    assert.equal(result.manifest.completionStatus, "aborted");
    assert.equal(session.state().phase, "aborted");
    assert.ok(result.events.some(({ payload }) => payload.type === "runAborted"));
    assert.equal((await recovery.list())[0].status, "finalized");
  } finally {
    await session.close();
    await recovery.close();
  }
});
