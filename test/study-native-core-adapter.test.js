import assert from "node:assert/strict";
import test from "node:test";

import { createNativeStudyCore } from "../site/src/study/core-adapter.js";

const HASH = "a".repeat(64);

test("desktop core adapter keeps the native Rust authority behind typed invokes", async () => {
  const calls = [];
  const published = {
    schema: "affect-tracker-study",
    version: 1,
    studyId: "native-study",
    revision: 3,
    protocolHash: HASH,
  };
  const created = {
    runId: "native-run",
    authorityGeneration: 4,
    revision: 0,
    phase: "created",
  };
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "validate_study_json") return { protocolHash: HASH };
    if (command === "publish_study_json") return published;
    if (command === "prepare_study_run") return created;
    if (command === "apply_study_action") {
      return { state: { ...created, revision: 1, phase: "prepared" }, events: [] };
    }
    throw new Error(`Unexpected command ${command}`);
  };
  const core = createNativeStudyCore(invoke);
  const source = { ...published };

  assert.equal(await core.hash(source), HASH);
  assert.equal((await core.validate(source)).valid, true);
  const authority = await core.createAuthority(source, { runId: "native-run" }, 4);
  assert.equal(JSON.parse(authority.stateJson()).phase, "created");
  const action = { schema: "affect-tracker-study-action", command: { type: "prepare" } };
  const outcome = JSON.parse(await authority.applyJson(JSON.stringify(action)));
  assert.equal(outcome.state.phase, "prepared");
  assert.equal(JSON.parse(authority.stateJson()).revision, 1);

  const observed = [];
  const unsubscribe = authority.subscribe((detail) => observed.push(detail));
  const remoteAction = {
    schema: "affect-tracker-study-action",
    runId: "native-run",
    authorityGeneration: 4,
    expectedRevision: 1,
    command: { type: "arm" },
  };
  const remoteOutcome = {
    state: { ...created, revision: 2, phase: "armed" },
    events: [{ sequence: 2, runId: "native-run", payload: { type: "runArmed" } }],
  };
  assert.equal(core.acceptExternalOutcome(remoteAction, remoteOutcome), true);
  assert.equal(JSON.parse(authority.stateJson()).phase, "armed");
  assert.equal(observed.length, 1);
  assert.equal(observed[0].source, "external");
  assert.equal(core.acceptExternalOutcome(remoteAction, remoteOutcome), false, "duplicate remote outcomes are ignored");
  assert.equal(core.acceptExternalOutcome(remoteAction, {
    ...remoteOutcome,
    state: { ...remoteOutcome.state, runId: "another-run", revision: 3 },
  }), false, "another run cannot replace the active adapter state");
  unsubscribe();

  assert.deepEqual(calls.map(({ command }) => command), [
    "validate_study_json",
    "validate_study_json",
    "publish_study_json",
    "prepare_study_run",
    "apply_study_action",
  ]);
  assert.deepEqual(calls[3].payload, {
    studyId: "native-study",
    studyRevision: 3,
    configuration: { runId: "native-run" },
    authorityGeneration: null,
  });
  assert.deepEqual(calls[4].payload.action, action);
});

test("desktop validation projects native failures without throwing", async () => {
  const core = createNativeStudyCore(async () => {
    throw { code: "study_invalid_value", message: "study.title: must not be empty" };
  });
  assert.deepEqual(await core.validate({}), {
    valid: false,
    errors: [{
      code: "study_invalid_value",
      path: "study",
      message: "study.title: must not be empty",
    }],
  });
});
