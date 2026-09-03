import test from "node:test";
import assert from "node:assert/strict";
import {
  REMOTE_STUDY_AUTHENTICATION_METHODS,
  REMOTE_STUDY_BEACON_PROTOCOL,
  REMOTE_STUDY_BRSP_SOURCE_REVISION,
  REMOTE_STUDY_COMMAND_ACTIONS,
  REMOTE_STUDY_PHASES,
  REMOTE_STUDY_SCOPES,
  assertRemoteStudyLaneScope,
  createPublicBeacon,
  createStudyCommand,
  decodePublicBeacon,
  encodePublicBeacon,
  normalizeRemoteStudyScopes,
  projectGrant,
  validatePublicBeacon,
  validateStudyCommand,
} from "../site/src/remote-study/index.js";

function startCommand(overrides = {}) {
  return createStudyCommand({
    authorityGeneration: 1,
    principalId: "principal_01",
    commandId: "command_0001",
    expectedRevision: 7,
    runId: "run_01",
    precondition: { phase: "armed", blockId: "block_01" },
    scope: "study.control",
    action: "start",
    payload: {},
    ...overrides,
  });
}

test("remote study exposes only the eight approved scopes", () => {
  assert.equal(
    REMOTE_STUDY_BRSP_SOURCE_REVISION,
    "e6a5eef86d4b3c7422ace08706df5deb82338808",
  );
  assert.deepEqual(REMOTE_STUDY_SCOPES, [
    "study.observe",
    "study.control",
    "study.design",
    "asset.catalog.read",
    "settings.read",
    "settings.write",
    "data.read",
    "data.export",
  ]);
  assert.deepEqual(
    normalizeRemoteStudyScopes(["data.export", "study.observe"]),
    ["study.observe", "data.export"],
  );
  assert.throws(
    () => normalizeRemoteStudyScopes(["study.observe", "asset.upload"]),
    { code: "unsupported_value" },
  );
  assert.throws(
    () => normalizeRemoteStudyScopes(["study.observe", "study.observe"]),
    { code: "duplicate_value" },
  );
  assert.deepEqual(REMOTE_STUDY_PHASES, [
    "created",
    "prepared",
    "armed",
    "running",
    "paused",
    "awaitingFinalization",
    "completed",
    "aborted",
  ]);
});

test("the public beacon is strict and contains no experiment or secret fields", () => {
  const beacon = createPublicBeacon({
    stationId: "station_01",
    stationLabel: "Lab workstation",
    availability: "available",
    authenticationMethods: ["passwordless-local-accept", "qr-invitation"],
  });
  assert.equal(beacon.protocol, REMOTE_STUDY_BEACON_PROTOCOL);
  assert.deepEqual(beacon.authenticationMethods, [
    "qr-invitation",
    "passwordless-local-accept",
  ]);
  assert.deepEqual(decodePublicBeacon(encodePublicBeacon(beacon)), beacon);
  assert.deepEqual(REMOTE_STUDY_AUTHENTICATION_METHODS, [
    "qr-invitation",
    "opaque-password-file",
    "passwordless-local-accept",
  ]);

  for (const forbidden of ["secret", "studyState", "participantCode", "scopes", "assetName"]) {
    assert.throws(() => validatePublicBeacon({ ...beacon, [forbidden]: "leak" }), {
      code: "unexpected_fields",
    });
  }
  assert.throws(() => createPublicBeacon({
    stationId: "station_01",
    stationLabel: "Lab workstation",
    availability: "disabled",
    authenticationMethods: ["qr-invitation"],
  }), { code: "invalid_availability" });

  const accessorBeacon = { ...beacon };
  Object.defineProperty(accessorBeacon, "stationLabel", {
    enumerable: true,
    get() { throw new Error("must not execute untrusted accessors"); },
  });
  assert.throws(() => validatePublicBeacon(accessorBeacon), { code: "invalid_object" });
});

test("commands bind generation, principal, revision, run and phase/block preconditions", () => {
  const command = startCommand();
  assert.equal(Object.isFrozen(command), true);
  assert.equal(Object.isFrozen(command.precondition), true);
  assert.equal(Object.isFrozen(command.payload), true);
  assert.deepEqual(Object.keys(command), [
    "protocol",
    "version",
    "authorityGeneration",
    "principalId",
    "commandId",
    "expectedRevision",
    "runId",
    "precondition",
    "scope",
    "action",
    "payload",
  ]);
  assert.ok(REMOTE_STUDY_COMMAND_ACTIONS.includes("study.control:start"));
  assert.ok(REMOTE_STUDY_COMMAND_ACTIONS.includes("study.control:stop"));
  assert.ok(REMOTE_STUDY_COMMAND_ACTIONS.includes("study.control:finalize"));
  assert.equal(REMOTE_STUDY_COMMAND_ACTIONS.includes("study.control:stop-finalize"), false);
  assert.ok(REMOTE_STUDY_COMMAND_ACTIONS.includes("data.export:request-record-export"));
  assert.equal(validateStudyCommand(command).expectedRevision, 7);

  const prepare = createStudyCommand({
    authorityGeneration: 1,
    principalId: "principal_01",
    commandId: "command_0002",
    expectedRevision: 0,
    runId: null,
    precondition: { phase: "created", blockId: null },
    scope: "study.control",
    action: "prepare",
    payload: {
      studyId: "study-1",
      protocolHash: "a".repeat(64),
    },
  });
  assert.equal(prepare.payload.protocolHash, "a".repeat(64));

  assert.throws(() => startCommand({ expectedRevision: null }), { code: "invalid_integer" });
  assert.throws(() => startCommand({ authorityGeneration: "generation_01" }), {
    code: "invalid_integer",
  });
  assert.throws(() => startCommand({ authorityGeneration: 0 }), { code: "invalid_integer" });
  assert.throws(() => startCommand({ precondition: { phase: "running", blockId: null, extra: true } }), {
    code: "unexpected_fields",
  });
  assert.throws(() => startCommand({ scope: "study.control", action: "invoke-native" }), {
    code: "unsupported_command",
  });
  assert.throws(() => startCommand({ payload: { nativeCommand: "set_target" } }), {
    code: "unexpected_fields",
  });
  assert.throws(() => createStudyCommand({
    ...command,
    action: "calibrate-affect",
    payload: { x: Number.NaN, y: 0 },
  }), { code: "invalid_number" });

  for (const action of ["pause", "retry-block", "stop", "abort"]) {
    assert.equal(createStudyCommand({
      ...command,
      action,
      payload: { reasonCode: "researcher-request" },
    }).payload.reasonCode, "researcher-request");
    assert.throws(() => createStudyCommand({ ...command, action, payload: {} }), {
      code: "unexpected_fields",
    });
  }
  assert.deepEqual(createStudyCommand({
    ...command,
    action: "finalize",
    precondition: { phase: "awaitingFinalization", blockId: null },
    payload: {},
  }).payload, {});
});

test("grant projection is scope-bounded and redacts internal material", () => {
  const projected = projectGrant({
    grantId: "grant_0001",
    authorityGeneration: 1,
    principalId: "principal_01",
    principalLabel: "Research tablet",
    authenticationMethod: "opaque-password-file",
    scopes: ["study.observe", "study.control", "data.read"],
    issuedAtMs: 1_000,
    expiresAtMs: 20_000,
    revoked: false,
    pairingSecret: "must-not-project",
    nativePath: "C:\\private\\record.csv",
    opaqueRecord: "must-not-project",
  });
  assert.equal(projected.mutable, true);
  assert.deepEqual(Object.keys(projected), [
    "grantId",
    "authorityGeneration",
    "principalId",
    "principalLabel",
    "authenticationMethod",
    "scopes",
    "issuedAtMs",
    "expiresAtMs",
    "revoked",
    "mutable",
  ]);
  assert.equal("pairingSecret" in projected, false);
  assert.equal("nativePath" in projected, false);
  assertRemoteStudyLaneScope("state", projected.scopes);
  assertRemoteStudyLaneScope("control", projected.scopes);
  assertRemoteStudyLaneScope("record", projected.scopes);
  assert.throws(() => assertRemoteStudyLaneScope("export", projected.scopes), { code: "scope_denied" });
  assert.throws(() => assertRemoteStudyLaneScope("control", ["study.observe"]), {
    code: "scope_denied",
  });
});
