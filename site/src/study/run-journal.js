import {
  asStorageError,
  assertIdentifier,
  assertSafeInteger,
  assertSha256,
  cloneJson,
  immutableJson,
  isoTimestamp,
  jsonByteLength,
  StudyStorageConflictError,
  StudyStorageStateError,
  StudyStorageValidationError,
} from "./storage-common.js";

export const RUN_JOURNAL_PROTOCOL = "affect-tracker-run-journal";
export const RUN_CHECKPOINT_PROTOCOL = "affect-tracker-run-checkpoint";
export const PARTIAL_RUN_EXPORT_PROTOCOL = "affect-tracker-partial-run-export";
export const FINALIZED_RUN_EXPORT_PROTOCOL = "affect-tracker-finalized-run-export";
export const RUN_JOURNAL_VERSION = 1;

export const RUN_CHECKPOINT_POSITIONS = Object.freeze([
  "run-start",
  "block-ready",
  "block-active",
  "block-complete",
]);

export const STUDY_BLOCK_KINDS = Object.freeze([
  "instruction",
  "video",
  "questionnaire",
  "break",
  "completion",
]);

export const DEFAULT_JOURNAL_LIMITS = Object.freeze({
  maxBatchEvents: 256,
  maxBatchBytes: 1024 * 1024,
  maxEventBytes: 64 * 1024,
  maxRunEvents: 5_000_000,
  maxRunBytes: 64 * 1024 * 1024,
  maxMetadataBytes: 64 * 1024,
  maxPendingActionBytes: 512 * 1024,
  maxCheckpointBytes: 16 * 1024,
  maxResultManifestBytes: 256 * 1024,
});

function assertBackend(backend) {
  const methods = [
    "createRun",
    "getRun",
    "listRuns",
    "commitBatch",
    "getEvents",
    "finalizeRun",
    "deleteRun",
  ];
  if (!backend || methods.some((method) => typeof backend[method] !== "function")) {
    throw new StudyStorageValidationError(
      `Journal backend must implement ${methods.join(", ")}.`,
    );
  }
  return backend;
}

function assertExactKeys(value, expected, label) {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new StudyStorageValidationError(`${label} has an unsupported record shape.`);
  }
}

function validateLimit(value, name) {
  return assertSafeInteger(value, name, { minimum: 1 });
}

function normalizeLimits(overrides = {}) {
  const unknown = Object.keys(overrides).filter((key) => !(key in DEFAULT_JOURNAL_LIMITS));
  if (unknown.length > 0) {
    throw new StudyStorageValidationError(`Unknown journal limit: ${unknown.join(", ")}.`);
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(DEFAULT_JOURNAL_LIMITS).map(([key, fallback]) => [
      key,
      validateLimit(overrides[key] ?? fallback, key),
    ]),
  ));
}

function normalizeMetadata(metadata, limits) {
  return cloneJson(metadata ?? {}, {
    label: "run metadata",
    maxBytes: limits.maxMetadataBytes,
  });
}

function normalizeCheckpoint(checkpoint, committedSequence, limits, { requireExact = false } = {}) {
  if (checkpoint === null || checkpoint === undefined) return null;
  const normalized = cloneJson(checkpoint, {
    label: "run checkpoint",
    maxBytes: limits.maxCheckpointBytes,
  });
  assertExactKeys(normalized, [
    "protocol", "version", "sequence", "position", "blockId", "blockKind", "phase",
  ], "Run checkpoint");
  if (normalized.protocol !== RUN_CHECKPOINT_PROTOCOL || normalized.version !== RUN_JOURNAL_VERSION) {
    throw new StudyStorageValidationError("Run checkpoint has an unsupported protocol or version.");
  }
  assertSafeInteger(normalized.sequence, "checkpoint sequence", { minimum: -1 });
  if (normalized.sequence > committedSequence
    || (requireExact && normalized.sequence !== committedSequence)) {
    throw new StudyStorageConflictError(
      requireExact
        ? `Checkpoint sequence ${normalized.sequence} does not match committed sequence ${committedSequence}.`
        : `Checkpoint sequence ${normalized.sequence} is newer than committed sequence ${committedSequence}.`,
    );
  }
  if (!RUN_CHECKPOINT_POSITIONS.includes(normalized.position)) {
    throw new StudyStorageValidationError("Checkpoint position is not supported.");
  }
  if (normalized.blockId !== null) assertIdentifier(normalized.blockId, "checkpoint blockId");
  if (normalized.blockKind !== null && !STUDY_BLOCK_KINDS.includes(normalized.blockKind)) {
    throw new StudyStorageValidationError("Checkpoint blockKind is not supported.");
  }
  if (normalized.phase !== null) assertIdentifier(normalized.phase, "checkpoint phase");
  if (["block-ready", "block-active", "block-complete"].includes(normalized.position)
    && (normalized.blockId === null || normalized.blockKind === null)) {
    throw new StudyStorageValidationError("Block checkpoints require blockId and blockKind.");
  }
  if (normalized.position === "run-start"
    && (normalized.blockId !== null || normalized.blockKind !== null)) {
    throw new StudyStorageValidationError("A run-start checkpoint cannot identify a block.");
  }
  return normalized;
}

function normalizePendingAction(pendingAction, runId, expectedSequence, limits) {
  if (pendingAction === null || pendingAction === undefined) return null;
  const normalized = cloneJson(pendingAction, {
    label: "pending study action",
    maxBytes: limits.maxPendingActionBytes,
  });
  assertExactKeys(normalized, ["action", "expectedNextSequence", "stagedAt"], "Pending study action");
  if (!normalized.action || Array.isArray(normalized.action)) {
    throw new StudyStorageValidationError("Pending study action must contain an action object.");
  }
  assertIdentifier(normalized.action.actionId, "pending actionId");
  if (normalized.action.runId !== runId) {
    throw new StudyStorageValidationError("Pending study action runId does not match the journal run.");
  }
  assertSafeInteger(normalized.expectedNextSequence, "pending expectedNextSequence", { minimum: 1 });
  if (normalized.expectedNextSequence !== expectedSequence) {
    throw new StudyStorageConflictError("Pending study action sequence does not match the journal.");
  }
  isoTimestamp(normalized.stagedAt, "pending action timestamp");
  return normalized;
}

function validateRunRecord(value, limits) {
  const run = cloneJson(value, {
    label: "run journal record",
    maxBytes: limits.maxMetadataBytes + limits.maxPendingActionBytes
      + limits.maxCheckpointBytes + limits.maxResultManifestBytes + 8_192,
  });
  // Early development builds wrote the same internal v1 record without this
  // write-ahead slot. Reading it as empty preserves their partial-export path.
  if (!("pendingAction" in run)) run.pendingAction = null;
  // Early v1 journals did not track an aggregate byte count. Treat their
  // historical bytes as unknown/zero so they remain exportable; every new
  // append is counted and bounded from the first write by this runtime.
  if (!("eventBytes" in run)) run.eventBytes = 0;
  assertExactKeys(run, [
    "protocol",
    "version",
    "runId",
    "studyId",
    "protocolHash",
    "status",
    "createdAt",
    "updatedAt",
    "nextSequence",
    "eventBytes",
    "metadata",
    "pendingAction",
    "checkpoint",
    "finalizedAt",
    "resultManifest",
  ], "Run journal record");
  if (run.protocol !== RUN_JOURNAL_PROTOCOL || run.version !== RUN_JOURNAL_VERSION) {
    throw new StudyStorageValidationError("Run journal record has an unsupported protocol or version.");
  }
  assertIdentifier(run.runId, "runId");
  assertIdentifier(run.studyId, "studyId");
  assertSha256(run.protocolHash, "protocolHash");
  if (!["partial", "finalized"].includes(run.status)) {
    throw new StudyStorageValidationError("Run journal status is not supported.");
  }
  isoTimestamp(run.createdAt, "run createdAt");
  isoTimestamp(run.updatedAt, "run updatedAt");
  assertSafeInteger(run.nextSequence, "run nextSequence", {
    minimum: 1,
    maximum: limits.maxRunEvents + 1,
  });
  assertSafeInteger(run.eventBytes, "run eventBytes", {
    minimum: 0,
    maximum: limits.maxRunBytes,
  });
  run.metadata = normalizeMetadata(run.metadata, limits);
  run.pendingAction = normalizePendingAction(run.pendingAction, run.runId, run.nextSequence, limits);
  run.checkpoint = normalizeCheckpoint(run.checkpoint, run.nextSequence - 1, limits);
  if (run.status === "partial") {
    if (run.finalizedAt !== null || run.resultManifest !== null) {
      throw new StudyStorageValidationError("A partial run cannot have finalization data.");
    }
  } else {
    if (run.pendingAction !== null) {
      throw new StudyStorageValidationError("A finalized run cannot retain a pending action.");
    }
    isoTimestamp(run.finalizedAt, "run finalizedAt");
    run.resultManifest = cloneJson(run.resultManifest, {
      label: "result manifest",
      maxBytes: limits.maxResultManifestBytes,
    });
    if (run.resultManifest?.runId !== run.runId) {
      throw new StudyStorageValidationError("Result manifest runId does not match the journal run.");
    }
  }
  return run;
}

function normalizeEvent(event, runId, expectedSequence, limits) {
  const normalized = cloneJson(event, {
    label: `run event ${expectedSequence}`,
    maxBytes: limits.maxEventBytes,
  });
  if (!normalized || Array.isArray(normalized)) {
    throw new StudyStorageValidationError("Each run event must be a JSON object.");
  }
  if (normalized.runId !== runId) {
    throw new StudyStorageValidationError(`Event ${expectedSequence} runId does not match ${runId}.`);
  }
  assertSafeInteger(normalized.sequence, `event ${expectedSequence} sequence`);
  if (normalized.sequence !== expectedSequence) {
    throw new StudyStorageConflictError(
      `Event sequence ${normalized.sequence} is not the required sequence ${expectedSequence}.`,
    );
  }
  return normalized;
}

function retainedEvidenceCloneOptions(limits) {
  return {
    maxBytes: limits.maxRunBytes + limits.maxRunEvents + limits.maxMetadataBytes
      + limits.maxPendingActionBytes + limits.maxCheckpointBytes
      + limits.maxResultManifestBytes + 2 * 1024 * 1024,
    // The byte ceiling is the primary resident-size guard. This node ceiling
    // is derived from it so legitimate long 20 Hz runs do not hit cloneJson's
    // general-purpose 100k-node default during terminal finalization.
    maxNodes: Math.ceil(limits.maxRunBytes / 2) + 100_000,
  };
}

export function createRunCheckpoint({ sequence, position, blockId = null, blockKind = null, phase = null } = {}) {
  const checkpoint = {
    protocol: RUN_CHECKPOINT_PROTOCOL,
    version: RUN_JOURNAL_VERSION,
    sequence,
    position,
    blockId,
    blockKind,
    phase,
  };
  return immutableJson(normalizeCheckpoint(checkpoint, sequence, normalizeLimits()));
}

export function recoveryDirectiveFor(checkpoint) {
  const common = { canResumeMidStimulus: false };
  if (!checkpoint || checkpoint.position === "run-start") {
    return immutableJson({
      ...common,
      strategy: "restart-run",
      blockId: null,
      reason: checkpoint ? "run-start-checkpoint" : "no-checkpoint",
    });
  }
  if (checkpoint.position === "block-complete") {
    return immutableJson({
      ...common,
      strategy: "resume-after-block",
      blockId: checkpoint.blockId,
      reason: "completed-block-boundary",
    });
  }
  return immutableJson({
    ...common,
    strategy: "restart-block",
    blockId: checkpoint.blockId,
    reason: checkpoint.position === "block-active" && checkpoint.blockKind === "video"
      ? "mid-stimulus-resume-forbidden"
      : "block-not-complete",
  });
}

export class StudyRunJournal {
  constructor({ backend, now = () => new Date(), limits = {} } = {}) {
    this.backend = assertBackend(backend);
    if (typeof now !== "function") throw new StudyStorageValidationError("now must be a function.");
    this.now = now;
    this.limits = normalizeLimits(limits);
  }

  async createRun({ runId, studyId, protocolHash, metadata = {} } = {}) {
    assertIdentifier(runId, "runId");
    assertIdentifier(studyId, "studyId");
    assertSha256(protocolHash, "protocolHash");
    const timestamp = isoTimestamp(this.now(), "run timestamp");
    const run = {
      protocol: RUN_JOURNAL_PROTOCOL,
      version: RUN_JOURNAL_VERSION,
      runId,
      studyId,
      protocolHash,
      status: "partial",
      createdAt: timestamp,
      updatedAt: timestamp,
      // RunEventV1 is one-based. Zero in RunStateV1 means that no authority
      // event has been committed yet, so the first accepted event is 1.
      nextSequence: 1,
      eventBytes: 0,
      metadata: normalizeMetadata(metadata, this.limits),
      pendingAction: null,
      checkpoint: null,
      finalizedAt: null,
      resultManifest: null,
    };
    try {
      await this.backend.createRun(run);
    } catch (error) {
      throw asStorageError(error, "Creating the run journal");
    }
    return immutableJson(run);
  }

  async getRun(runId) {
    assertIdentifier(runId, "runId");
    let value;
    try {
      value = await this.backend.getRun(runId);
    } catch (error) {
      throw asStorageError(error, "Reading the run journal");
    }
    if (value === undefined || value === null) return undefined;
    const run = validateRunRecord(value, this.limits);
    if (run.runId !== runId) {
      throw new StudyStorageValidationError("Journal backend returned a different runId.");
    }
    return immutableJson(run);
  }

  async appendEvents(runId, events, {
    expectedNextSequence,
    checkpoint,
    stagedActionId,
  } = {}) {
    assertIdentifier(runId, "runId");
    if (!Array.isArray(events) || events.length < 1) {
      throw new StudyStorageValidationError("appendEvents requires at least one event.");
    }
    if (events.length > this.limits.maxBatchEvents) {
      throw new StudyStorageValidationError(
        `Event batch contains ${events.length} events; the limit is ${this.limits.maxBatchEvents}.`,
      );
    }
    const eventBatch = cloneJson(events, { label: "event batch" });
    const firstSequence = eventBatch[0]?.sequence;
    assertSafeInteger(firstSequence, "first event sequence", { minimum: 1 });
    const expected = expectedNextSequence ?? firstSequence;
    assertSafeInteger(expected, "expectedNextSequence", {
      minimum: 1,
      maximum: this.limits.maxRunEvents + 1,
    });
    if (expected !== firstSequence) {
      throw new StudyStorageConflictError("expectedNextSequence must match the first event sequence.");
    }
    if (expected + events.length - 1 > this.limits.maxRunEvents) {
      throw new StudyStorageValidationError("Run event limit would be exceeded.");
    }
    const normalizedEvents = eventBatch.map((event, index) => (
      normalizeEvent(event, runId, expected + index, this.limits)
    ));
    const batchBytes = normalizedEvents.reduce((total, event) => total + jsonByteLength(event), 0);
    if (batchBytes > this.limits.maxBatchBytes) {
      throw new StudyStorageValidationError(
        `Event batch is ${batchBytes} bytes; the limit is ${this.limits.maxBatchBytes} bytes.`,
      );
    }
    const nextSequence = expected + normalizedEvents.length;
    const normalizedCheckpoint = checkpoint === undefined
      ? undefined
      : normalizeCheckpoint(checkpoint, nextSequence - 1, this.limits, { requireExact: true });
    const updatedAt = isoTimestamp(this.now(), "run update timestamp");
    if (stagedActionId !== undefined) assertIdentifier(stagedActionId, "stagedActionId");
    try {
      const updated = await this.backend.commitBatch({
        runId,
        expectedNextSequence: expected,
        events: normalizedEvents,
        nextSequence,
        eventBytesDelta: batchBytes,
        maxRunBytes: this.limits.maxRunBytes,
        updatedAt,
        checkpoint: normalizedCheckpoint,
        ...(stagedActionId === undefined ? {} : {
          expectedPendingActionId: stagedActionId,
          pendingAction: null,
        }),
      });
      return immutableJson(validateRunRecord(updated, this.limits));
    } catch (error) {
      throw asStorageError(error, "Appending the run event batch");
    }
  }

  async stageAction(runId, action, { expectedNextSequence } = {}) {
    assertIdentifier(runId, "runId");
    const run = await this.#requirePartialRun(runId);
    if (run.pendingAction !== null) {
      throw new StudyStorageConflictError(
        `Run ${runId} already has pending action ${run.pendingAction.action.actionId}.`,
      );
    }
    const expected = expectedNextSequence ?? run.nextSequence;
    assertSafeInteger(expected, "expectedNextSequence", {
      minimum: 1,
      maximum: this.limits.maxRunEvents + 1,
    });
    if (expected !== run.nextSequence) {
      throw new StudyStorageConflictError(
        `Run ${runId} expects sequence ${run.nextSequence}, not ${expected}.`,
      );
    }
    const pendingAction = normalizePendingAction({
      action,
      expectedNextSequence: expected,
      stagedAt: isoTimestamp(this.now(), "pending action timestamp"),
    }, runId, expected, this.limits);
    try {
      const updated = await this.backend.commitBatch({
        runId,
        expectedNextSequence: expected,
        events: [],
        nextSequence: expected,
        updatedAt: isoTimestamp(this.now(), "run update timestamp"),
        pendingAction,
      });
      return immutableJson(validateRunRecord(updated, this.limits));
    } catch (error) {
      throw asStorageError(error, "Staging the study action");
    }
  }

  async clearStagedAction(runId, stagedActionId, { checkpoint } = {}) {
    assertIdentifier(runId, "runId");
    assertIdentifier(stagedActionId, "stagedActionId");
    const run = await this.#requirePartialRun(runId);
    const normalizedCheckpoint = checkpoint === undefined
      ? undefined
      : normalizeCheckpoint(checkpoint, run.nextSequence - 1, this.limits, { requireExact: true });
    try {
      const updated = await this.backend.commitBatch({
        runId,
        expectedNextSequence: run.nextSequence,
        expectedPendingActionId: stagedActionId,
        events: [],
        nextSequence: run.nextSequence,
        updatedAt: isoTimestamp(this.now(), "run update timestamp"),
        checkpoint: normalizedCheckpoint,
        pendingAction: null,
      });
      return immutableJson(validateRunRecord(updated, this.limits));
    } catch (error) {
      throw asStorageError(error, "Clearing the staged study action");
    }
  }

  async replaceMetadata(runId, metadata, { expectedNextSequence } = {}) {
    assertIdentifier(runId, "runId");
    const run = await this.#requirePartialRun(runId);
    const expected = expectedNextSequence ?? run.nextSequence;
    assertSafeInteger(expected, "expectedNextSequence", {
      minimum: 1,
      maximum: this.limits.maxRunEvents + 1,
    });
    const normalizedMetadata = normalizeMetadata(metadata, this.limits);
    try {
      const updated = await this.backend.commitBatch({
        runId,
        expectedNextSequence: expected,
        events: [],
        nextSequence: expected,
        updatedAt: isoTimestamp(this.now(), "run update timestamp"),
        metadata: normalizedMetadata,
      });
      return immutableJson(validateRunRecord(updated, this.limits));
    } catch (error) {
      throw asStorageError(error, "Replacing run metadata");
    }
  }

  async setCheckpoint(runId, checkpoint, { expectedNextSequence } = {}) {
    assertIdentifier(runId, "runId");
    const run = await this.#requirePartialRun(runId);
    const expected = expectedNextSequence ?? run.nextSequence;
    assertSafeInteger(expected, "expectedNextSequence", {
      minimum: 1,
      maximum: this.limits.maxRunEvents + 1,
    });
    const normalizedCheckpoint = normalizeCheckpoint(checkpoint, expected - 1, this.limits, {
      requireExact: true,
    });
    try {
      const updated = await this.backend.commitBatch({
        runId,
        expectedNextSequence: expected,
        events: [],
        nextSequence: expected,
        updatedAt: isoTimestamp(this.now(), "run update timestamp"),
        checkpoint: normalizedCheckpoint,
      });
      return immutableJson(validateRunRecord(updated, this.limits));
    } catch (error) {
      throw asStorageError(error, "Saving the run checkpoint");
    }
  }

  async readEvents(runId, { fromSequence = 1, limit = this.limits.maxBatchEvents } = {}) {
    assertIdentifier(runId, "runId");
    assertSafeInteger(fromSequence, "fromSequence", {
      minimum: 1,
      maximum: this.limits.maxRunEvents + 1,
    });
    assertSafeInteger(limit, "limit", { minimum: 1, maximum: this.limits.maxBatchEvents });
    await this.#requireRun(runId);
    let values;
    try {
      values = await this.backend.getEvents(runId, { fromSequence, limit });
    } catch (error) {
      throw asStorageError(error, "Reading run events");
    }
    if (!Array.isArray(values)) {
      throw new StudyStorageValidationError("Journal backend returned an invalid event collection.");
    }
    const normalized = values.map((event, index) => (
      normalizeEvent(event, runId, fromSequence + index, this.limits)
    ));
    return immutableJson(normalized);
  }

  async listPartialRuns() {
    return immutableJson((await this.listRetainedRuns()).filter((run) => run.status === "partial"));
  }

  async listFinalizedRuns() {
    return immutableJson((await this.listRetainedRuns()).filter((run) => run.status === "finalized"));
  }

  async listRetainedRuns() {
    return (await this.listRetainedRunsWithIssues()).runs;
  }

  async listRetainedRunsWithIssues() {
    let values;
    try {
      values = await this.backend.listRuns();
    } catch (error) {
      throw asStorageError(error, "Listing retained runs");
    }
    if (!Array.isArray(values)) {
      throw new StudyStorageValidationError("Journal backend returned an invalid run collection.");
    }
    const runs = [];
    const issues = [];
    values.forEach((value, index) => {
      try {
        runs.push(validateRunRecord(value, this.limits));
      } catch (error) {
        const candidateId = typeof value?.runId === "string" && value.runId.length <= 128
          ? value.runId
          : `stored-record-${index + 1}`;
        issues.push({
          recordId: candidateId,
          message: String(error?.message ?? "Stored run metadata is invalid.").slice(0, 240),
        });
      }
    });
    runs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return immutableJson({ runs, issues });
  }

  async recoverPartialRun(runId) {
    const run = await this.#requirePartialRun(runId);
    const events = await this.#readAllEvents(run);
    return immutableJson({
      run,
      events,
      recovery: recoveryDirectiveFor(run.checkpoint),
      allowedActions: ["export-partial", "discard-and-restart"],
    }, retainedEvidenceCloneOptions(this.limits));
  }

  async exportPartial(runId) {
    const recovered = await this.recoverPartialRun(runId);
    return immutableJson({
      protocol: PARTIAL_RUN_EXPORT_PROTOCOL,
      version: RUN_JOURNAL_VERSION,
      exportedAt: isoTimestamp(this.now(), "partial export timestamp"),
      completionStatus: "partial",
      run: recovered.run,
      events: recovered.events,
      recovery: recovered.recovery,
    }, retainedEvidenceCloneOptions(this.limits));
  }

  async recoverFinalizedRun(runId) {
    const run = await this.#requireFinalizedRun(runId);
    const events = await this.#readAllEvents(run);
    return immutableJson({
      run,
      events,
      resultManifest: run.resultManifest,
      allowedActions: ["export-finalized", "discard-finalized"],
    }, retainedEvidenceCloneOptions(this.limits));
  }

  async exportFinalized(runId) {
    const recovered = await this.recoverFinalizedRun(runId);
    const completionStatus = recovered.resultManifest?.completionStatus;
    if (typeof completionStatus !== "string" || completionStatus === "partial") {
      throw new StudyStorageStateError(
        `Finalized run ${runId} does not contain a non-partial completion status.`,
      );
    }
    return immutableJson({
      protocol: FINALIZED_RUN_EXPORT_PROTOCOL,
      version: RUN_JOURNAL_VERSION,
      exportedAt: isoTimestamp(this.now(), "finalized export timestamp"),
      completionStatus,
      run: recovered.run,
      events: recovered.events,
      resultManifest: recovered.resultManifest,
    }, retainedEvidenceCloneOptions(this.limits));
  }

  async discardPartial(runId, { expectedUpdatedAt, expectedNextSequence } = {}) {
    const run = await this.#requirePartialRun(runId);
    return this.#deleteRun(run, {
      expectedStatus: "partial",
      expectedUpdatedAt,
      expectedNextSequence,
      operation: "Discarding the partial run",
    });
  }

  async discardFinalized(runId, { expectedUpdatedAt, expectedNextSequence } = {}) {
    const run = await this.#requireFinalizedRun(runId);
    return this.#deleteRun(run, {
      expectedStatus: "finalized",
      expectedUpdatedAt,
      expectedNextSequence,
      operation: "Discarding the finalized run",
    });
  }

  async #deleteRun(run, {
    expectedStatus,
    expectedUpdatedAt = run.updatedAt,
    expectedNextSequence = run.nextSequence,
    operation,
  }) {
    const normalizedUpdatedAt = isoTimestamp(expectedUpdatedAt, "expected run update timestamp");
    assertSafeInteger(expectedNextSequence, "expectedNextSequence", {
      minimum: 1,
      maximum: this.limits.maxRunEvents + 1,
    });
    if (run.status !== expectedStatus
      || run.updatedAt !== normalizedUpdatedAt
      || run.nextSequence !== expectedNextSequence) {
      throw new StudyStorageConflictError(`Run ${run.runId} changed before discard authorization.`);
    }
    try {
      await this.backend.deleteRun({
        runId: run.runId,
        expectedStatus,
        expectedUpdatedAt: normalizedUpdatedAt,
        expectedNextSequence,
      });
    } catch (error) {
      throw asStorageError(error, operation);
    }
    return true;
  }

  async finalizeRun(runId, { expectedNextSequence, resultManifest, checkpoint } = {}) {
    assertIdentifier(runId, "runId");
    const run = await this.#requirePartialRun(runId);
    const expected = expectedNextSequence ?? run.nextSequence;
    if (run.pendingAction !== null) {
      throw new StudyStorageStateError("A run with an uncommitted staged action cannot be finalized.");
    }
    assertSafeInteger(expected, "expectedNextSequence", {
      minimum: 1,
      maximum: this.limits.maxRunEvents + 1,
    });
    const manifest = cloneJson(resultManifest, {
      label: "result manifest",
      maxBytes: this.limits.maxResultManifestBytes,
    });
    if (!manifest || Array.isArray(manifest) || manifest.runId !== runId) {
      throw new StudyStorageValidationError("Result manifest must be an object with the matching runId.");
    }
    const normalizedCheckpoint = checkpoint === undefined
      ? run.checkpoint
      : normalizeCheckpoint(checkpoint, expected - 1, this.limits, { requireExact: true });
    const finalizedAt = isoTimestamp(this.now(), "run finalization timestamp");
    try {
      const finalized = await this.backend.finalizeRun({
        runId,
        expectedNextSequence: expected,
        updatedAt: finalizedAt,
        finalizedAt,
        checkpoint: normalizedCheckpoint,
        resultManifest: manifest,
      });
      return immutableJson(validateRunRecord(finalized, this.limits));
    } catch (error) {
      throw asStorageError(error, "Finalizing the run journal");
    }
  }

  async close() {
    if (typeof this.backend.close === "function") await this.backend.close();
  }

  async #requireRun(runId) {
    const run = await this.getRun(runId);
    if (!run) throw new StudyStorageStateError(`Run ${runId} does not exist.`);
    return run;
  }

  async #requirePartialRun(runId) {
    const run = await this.#requireRun(runId);
    if (run.status !== "partial") {
      throw new StudyStorageStateError(`Run ${runId} is finalized and cannot be changed.`);
    }
    return run;
  }

  async #requireFinalizedRun(runId) {
    const run = await this.#requireRun(runId);
    if (run.status !== "finalized") {
      throw new StudyStorageStateError(`Run ${runId} is partial and has not been finalized.`);
    }
    return run;
  }

  async #readAllEvents(run) {
    const events = [];
    for (let fromSequence = 1; fromSequence < run.nextSequence;) {
      const batch = await this.readEvents(run.runId, {
        fromSequence,
        limit: Math.min(this.limits.maxBatchEvents, run.nextSequence - fromSequence),
      });
      if (batch.length === 0) {
        throw new StudyStorageStateError(
          `Run ${run.runId} is missing persisted events at sequence ${fromSequence}.`,
        );
      }
      events.push(...batch);
      fromSequence += batch.length;
    }
    return events;
  }
}
