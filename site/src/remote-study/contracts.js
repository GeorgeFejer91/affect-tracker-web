import {
  assertBoundedJson,
  assertBoundedText,
  assertExactKeys,
  assertFiniteRange,
  assertPlainRecord,
  assertSafeInteger,
  assertToken,
  cloneBoundedJson,
  failContract,
  utf8ByteLength,
} from "./values.js";

export const REMOTE_STUDY_PROFILE = "affect-tracker-remote-study";
export const REMOTE_STUDY_VERSION = 1;
export const REMOTE_STUDY_BRSP_SOURCE_REVISION = "e6a5eef86d4b3c7422ace08706df5deb82338808";

export const REMOTE_STUDY_AUTHENTICATION_METHODS = Object.freeze([
  "qr-invitation",
  "opaque-password-file",
  "passwordless-local-accept",
]);

export const REMOTE_STUDY_SCOPES = Object.freeze([
  "study.observe",
  "study.control",
  "study.design",
  "asset.catalog.read",
  "settings.read",
  "settings.write",
  "data.read",
  "data.export",
]);

export const REMOTE_STUDY_PHASES = Object.freeze([
  "created",
  "prepared",
  "armed",
  "running",
  "paused",
  "awaitingFinalization",
  "completed",
  "aborted",
]);

export const REMOTE_STUDY_BEACON_PROTOCOL = "affect-tracker-remote-study-beacon";
export const REMOTE_STUDY_BEACON_MAX_BYTES = 2 * 1024;
export const REMOTE_STUDY_COMMAND_PROTOCOL = "affect-tracker-study-command";
export const REMOTE_STUDY_COMMAND_MAX_BYTES = 16 * 1024;

const knownAuthenticationMethods = new Set(REMOTE_STUDY_AUTHENTICATION_METHODS);
const knownScopes = new Set(REMOTE_STUDY_SCOPES);
const knownPhases = new Set(REMOTE_STUDY_PHASES);
const hashPattern = /^[a-f0-9]{64}$/u;

function orderedSubset(values, catalogue, known, name, { allowEmpty = true } = {}) {
  if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype) {
    failContract("invalid_array", `${name} must be an array.`);
  }
  if (!allowEmpty && values.length === 0) {
    failContract("empty_set", `${name} must not be empty.`);
  }
  const found = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !known.has(value)) {
      failContract("unsupported_value", `${name} contains an unsupported value.`);
    }
    if (found.has(value)) failContract("duplicate_value", `${name} must not contain duplicates.`);
    found.add(value);
  }
  return catalogue.filter((value) => found.has(value));
}

export function normalizeRemoteStudyScopes(values, options) {
  return orderedSubset(values, REMOTE_STUDY_SCOPES, knownScopes, "scopes", options);
}

export function normalizeRemoteStudyAuthenticationMethods(values, options) {
  return orderedSubset(
    values,
    REMOTE_STUDY_AUTHENTICATION_METHODS,
    knownAuthenticationMethods,
    "authenticationMethods",
    options,
  );
}

export function createPublicBeacon({
  stationId,
  stationLabel,
  availability = "available",
  authenticationMethods,
}) {
  assertToken(stationId, "stationId", { minimum: 8, maximum: 64 });
  assertBoundedText(stationLabel, "stationLabel", { minimum: 1, maximum: 64 });
  if (availability !== "available" && availability !== "busy") {
    failContract("invalid_availability", "availability must be available or busy.");
  }
  const methods = normalizeRemoteStudyAuthenticationMethods(authenticationMethods, { allowEmpty: false });
  return Object.freeze({
    protocol: REMOTE_STUDY_BEACON_PROTOCOL,
    version: REMOTE_STUDY_VERSION,
    profile: REMOTE_STUDY_PROFILE,
    stationId,
    stationLabel,
    availability,
    authenticationMethods: Object.freeze(methods),
  });
}

export function validatePublicBeacon(value) {
  assertExactKeys(value, [
    "protocol",
    "version",
    "profile",
    "stationId",
    "stationLabel",
    "availability",
    "authenticationMethods",
  ], "beacon");
  if (value.protocol !== REMOTE_STUDY_BEACON_PROTOCOL
    || value.version !== REMOTE_STUDY_VERSION
    || value.profile !== REMOTE_STUDY_PROFILE) {
    failContract("unsupported_beacon", "The remote-study beacon profile is unsupported.");
  }
  return createPublicBeacon(value);
}

export function encodePublicBeacon(value) {
  const beacon = validatePublicBeacon(value);
  const encoded = JSON.stringify(beacon);
  if (utf8ByteLength(encoded) > REMOTE_STUDY_BEACON_MAX_BYTES) {
    failContract("beacon_too_large", "The public beacon exceeds its byte limit.");
  }
  return encoded;
}

export function decodePublicBeacon(value) {
  if (typeof value !== "string" || utf8ByteLength(value) > REMOTE_STUDY_BEACON_MAX_BYTES) {
    failContract("invalid_beacon", "The public beacon is missing or too large.");
  }
  let decoded;
  try {
    decoded = JSON.parse(value);
  } catch {
    failContract("invalid_beacon", "The public beacon is not valid JSON.");
  }
  return validatePublicBeacon(decoded);
}

function requireHash(value, name) {
  if (typeof value !== "string" || !hashPattern.test(value)) {
    failContract("invalid_hash", `${name} must be a lowercase SHA-256 hex digest.`);
  }
  return value;
}

function validateEmptyPayload(payload) {
  return assertExactKeys(payload, [], "payload");
}

function validatePreparePayload(payload) {
  assertExactKeys(payload, ["studyId", "protocolHash"], "payload");
  assertToken(payload.studyId, "payload.studyId", { minimum: 1, maximum: 96 });
  requireHash(payload.protocolHash, "payload.protocolHash");
  return payload;
}

function validateSettingsPayload(payload) {
  assertExactKeys(payload, ["settingsHash"], "payload");
  requireHash(payload.settingsHash, "payload.settingsHash");
  return payload;
}

function validateCalibrationPayload(payload) {
  assertExactKeys(payload, ["x", "y"], "payload");
  assertFiniteRange(payload.x, "payload.x", -1, 1);
  assertFiniteRange(payload.y, "payload.y", -1, 1);
  return payload;
}

function validateReasonPayload(payload) {
  assertExactKeys(payload, ["reasonCode"], "payload");
  assertToken(payload.reasonCode, "payload.reasonCode", { minimum: 1, maximum: 64 });
  return payload;
}

function validateExportPayload(payload) {
  assertExactKeys(payload, ["recordId", "recordStatus"], "payload");
  assertToken(payload.recordId, "payload.recordId", { minimum: 1, maximum: 96 });
  if (!new Set(["partial", "final", "either"]).has(payload.recordStatus)) {
    failContract("invalid_record_status", "payload.recordStatus is unsupported.");
  }
  return payload;
}

const commandProfile = Object.freeze({
  "study.control:prepare": validatePreparePayload,
  "study.control:arm": validateEmptyPayload,
  "study.control:start": validateEmptyPayload,
  "study.control:pause": validateReasonPayload,
  "study.control:resume": validateEmptyPayload,
  "study.control:advance": validateEmptyPayload,
  "study.control:retry-block": validateReasonPayload,
  "study.control:stop": validateReasonPayload,
  "study.control:finalize": validateEmptyPayload,
  "study.control:abort": validateReasonPayload,
  "settings.write:apply-settings": validateSettingsPayload,
  "study.control:calibrate-affect": validateCalibrationPayload,
  "study.control:reset-affect": validateEmptyPayload,
  "data.export:request-record-export": validateExportPayload,
});

export const REMOTE_STUDY_COMMAND_ACTIONS = Object.freeze(Object.keys(commandProfile));

function validatePrecondition(value) {
  assertExactKeys(value, ["phase", "blockId"], "precondition");
  if (!knownPhases.has(value.phase)) {
    failContract("invalid_phase", "precondition.phase is unsupported.");
  }
  if (value.blockId !== null) {
    assertToken(value.blockId, "precondition.blockId", { minimum: 1, maximum: 96 });
  }
  return { phase: value.phase, blockId: value.blockId };
}

export function validateStudyCommand(value) {
  assertExactKeys(value, [
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
  ], "command");
  if (value.protocol !== REMOTE_STUDY_COMMAND_PROTOCOL || value.version !== REMOTE_STUDY_VERSION) {
    failContract("unsupported_command_profile", "The remote-study command profile is unsupported.");
  }
  assertSafeInteger(value.authorityGeneration, "authorityGeneration", { minimum: 1 });
  assertToken(value.principalId, "principalId", { minimum: 8, maximum: 96 });
  assertToken(value.commandId, "commandId", { minimum: 8, maximum: 96 });
  assertSafeInteger(value.expectedRevision, "expectedRevision");
  if (value.runId !== null) assertToken(value.runId, "runId", { minimum: 1, maximum: 96 });
  const precondition = validatePrecondition(value.precondition);
  if (!knownScopes.has(value.scope)) failContract("scope_denied", "The command scope is unsupported.");
  assertToken(value.action, "action", { minimum: 1, maximum: 64 });
  const validator = commandProfile[`${value.scope}:${value.action}`];
  if (!validator) failContract("unsupported_command", "The scope/action pair is not remotely eligible.");
  assertPlainRecord(value.payload, "payload");
  validator(value.payload);
  assertBoundedJson(value.payload, { name: "payload" });

  const command = {
    protocol: REMOTE_STUDY_COMMAND_PROTOCOL,
    version: REMOTE_STUDY_VERSION,
    authorityGeneration: value.authorityGeneration,
    principalId: value.principalId,
    commandId: value.commandId,
    expectedRevision: value.expectedRevision,
    runId: value.runId,
    precondition: Object.freeze(precondition),
    scope: value.scope,
    action: value.action,
    payload: Object.freeze(cloneBoundedJson(value.payload, { name: "payload" })),
  };
  if (utf8ByteLength(JSON.stringify(command)) > REMOTE_STUDY_COMMAND_MAX_BYTES) {
    failContract("command_too_large", "The study command exceeds its byte limit.");
  }
  return Object.freeze(command);
}

export function createStudyCommand(value) {
  return validateStudyCommand({
    protocol: REMOTE_STUDY_COMMAND_PROTOCOL,
    version: REMOTE_STUDY_VERSION,
    ...value,
  });
}

export function projectGrant(value) {
  assertPlainRecord(value, "grant");
  const scopes = normalizeRemoteStudyScopes(value.scopes, { allowEmpty: false });
  assertToken(value.grantId, "grant.grantId", { minimum: 8, maximum: 96 });
  assertSafeInteger(value.authorityGeneration, "grant.authorityGeneration", { minimum: 1 });
  assertToken(value.principalId, "grant.principalId", { minimum: 8, maximum: 96 });
  assertBoundedText(value.principalLabel, "grant.principalLabel", { minimum: 1, maximum: 64 });
  if (!knownAuthenticationMethods.has(value.authenticationMethod)) {
    failContract("invalid_authentication_method", "grant.authenticationMethod is unsupported.");
  }
  assertSafeInteger(value.issuedAtMs, "grant.issuedAtMs");
  assertSafeInteger(value.expiresAtMs, "grant.expiresAtMs", { minimum: value.issuedAtMs });
  if (typeof value.revoked !== "boolean") failContract("invalid_grant", "grant.revoked must be boolean.");
  const mutatingScopes = new Set(["study.control", "study.design", "settings.write", "data.export"]);
  return Object.freeze({
    grantId: value.grantId,
    authorityGeneration: value.authorityGeneration,
    principalId: value.principalId,
    principalLabel: value.principalLabel,
    authenticationMethod: value.authenticationMethod,
    scopes: Object.freeze(scopes),
    issuedAtMs: value.issuedAtMs,
    expiresAtMs: value.expiresAtMs,
    revoked: value.revoked,
    mutable: !value.revoked && scopes.some((scope) => mutatingScopes.has(scope)),
  });
}
