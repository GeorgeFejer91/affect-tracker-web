import {
  assertIdentifier,
  assertSafeInteger,
  cloneJson,
  jsonByteLength,
  StudyStorageConflictError,
  StudyStorageQuotaError,
  StudyStorageStateError,
  StudyStorageValidationError,
} from "./storage-common.js";

function cloneMap(source) {
  return new Map([...source].map(([key, value]) => [key, cloneJson(value)]));
}

export class MemoryJournalBackend {
  constructor({ maxBytes = Number.POSITIVE_INFINITY } = {}) {
    if (!(maxBytes === Number.POSITIVE_INFINITY || (Number.isSafeInteger(maxBytes) && maxBytes >= 0))) {
      throw new StudyStorageValidationError("maxBytes must be a non-negative integer or Infinity.");
    }
    this.maxBytes = maxBytes;
    this.runs = new Map();
    this.events = new Map();
    this.failures = new Map();
  }

  failNext(operation, error = new Error(`Injected ${operation} interruption.`)) {
    if (!["createRun", "getRun", "listRuns", "commitBatch", "getEvents", "finalizeRun", "deleteRun"].includes(operation)) {
      throw new StudyStorageValidationError("Unknown journal backend operation.");
    }
    this.failures.set(operation, error);
  }

  async createRun(record) {
    this.#throwFailure("createRun");
    assertIdentifier(record?.runId, "runId");
    if (this.runs.has(record.runId)) {
      throw new StudyStorageConflictError(`Run ${record.runId} already exists.`);
    }
    const nextRuns = cloneMap(this.runs);
    const nextEvents = this.#cloneEvents();
    nextRuns.set(record.runId, cloneJson(record));
    nextEvents.set(record.runId, new Map());
    this.#commitState(nextRuns, nextEvents);
  }

  async getRun(runId) {
    this.#throwFailure("getRun");
    assertIdentifier(runId, "runId");
    const run = this.runs.get(runId);
    return run ? cloneJson(run) : undefined;
  }

  async listRuns() {
    this.#throwFailure("listRuns");
    return [...this.runs.values()].map((run) => cloneJson(run));
  }

  async commitBatch({
    runId,
    expectedNextSequence,
    events,
    nextSequence,
    eventBytesDelta = 0,
    maxRunBytes = Number.MAX_SAFE_INTEGER,
    updatedAt,
    checkpoint,
    metadata,
    pendingAction,
    expectedPendingActionId,
  }) {
    this.#throwFailure("commitBatch");
    assertIdentifier(runId, "runId");
    assertSafeInteger(expectedNextSequence, "expectedNextSequence");
    assertSafeInteger(nextSequence, "nextSequence");
    assertSafeInteger(eventBytesDelta, "eventBytesDelta");
    assertSafeInteger(maxRunBytes, "maxRunBytes", { minimum: 1 });
    if (!Array.isArray(events)) throw new StudyStorageValidationError("events must be an array.");
    if (nextSequence !== expectedNextSequence + events.length) {
      throw new StudyStorageValidationError("nextSequence does not match the committed event batch.");
    }
    const current = this.runs.get(runId);
    if (!current) throw new StudyStorageStateError(`Run ${runId} does not exist.`);
    if (current.status !== "partial") {
      throw new StudyStorageStateError(`Run ${runId} is finalized and cannot be changed.`);
    }
    if (current.nextSequence !== expectedNextSequence) {
      throw new StudyStorageConflictError(
        `Run ${runId} expects sequence ${current.nextSequence}, not ${expectedNextSequence}.`,
      );
    }
    if (expectedPendingActionId !== undefined
      && current.pendingAction?.action?.actionId !== expectedPendingActionId) {
      throw new StudyStorageConflictError(
        `Run ${runId} does not have staged action ${expectedPendingActionId}.`,
      );
    }

    const nextRuns = cloneMap(this.runs);
    const nextEvents = this.#cloneEvents();
    const runEvents = nextEvents.get(runId) ?? new Map();
    for (let index = 0; index < events.length; index += 1) {
      const event = cloneJson(events[index]);
      const sequence = expectedNextSequence + index;
      if (event.runId !== runId || event.sequence !== sequence) {
        throw new StudyStorageValidationError("Event identity does not match its journal position.");
      }
      if (runEvents.has(sequence)) {
        throw new StudyStorageConflictError(`Run ${runId} already contains event ${sequence}.`);
      }
      runEvents.set(sequence, event);
    }
    nextEvents.set(runId, runEvents);

    const updated = cloneJson(current);
    const currentEventBytes = current.eventBytes ?? 0;
    assertSafeInteger(currentEventBytes, "current eventBytes");
    if (currentEventBytes + eventBytesDelta > maxRunBytes) {
      throw new StudyStorageQuotaError(
        `Run ${runId} would exceed the ${maxRunBytes}-byte event evidence limit.`,
      );
    }
    updated.nextSequence = nextSequence;
    updated.eventBytes = currentEventBytes + eventBytesDelta;
    updated.updatedAt = updatedAt;
    if (checkpoint !== undefined) updated.checkpoint = cloneJson(checkpoint);
    if (metadata !== undefined) updated.metadata = cloneJson(metadata);
    if (pendingAction !== undefined) updated.pendingAction = cloneJson(pendingAction);
    nextRuns.set(runId, updated);
    this.#commitState(nextRuns, nextEvents);
    return cloneJson(updated);
  }

  async getEvents(runId, { fromSequence, limit }) {
    this.#throwFailure("getEvents");
    assertIdentifier(runId, "runId");
    assertSafeInteger(fromSequence, "fromSequence");
    assertSafeInteger(limit, "limit", { minimum: 1 });
    if (!this.runs.has(runId)) throw new StudyStorageStateError(`Run ${runId} does not exist.`);
    const runEvents = this.events.get(runId) ?? new Map();
    return [...runEvents]
      .filter(([sequence]) => sequence >= fromSequence)
      .sort(([left], [right]) => left - right)
      .slice(0, limit)
      .map(([, event]) => cloneJson(event));
  }

  async finalizeRun({
    runId,
    expectedNextSequence,
    updatedAt,
    finalizedAt,
    checkpoint,
    resultManifest,
  }) {
    this.#throwFailure("finalizeRun");
    assertIdentifier(runId, "runId");
    assertSafeInteger(expectedNextSequence, "expectedNextSequence");
    const current = this.runs.get(runId);
    if (!current) throw new StudyStorageStateError(`Run ${runId} does not exist.`);
    if (current.status !== "partial") {
      throw new StudyStorageStateError(`Run ${runId} is already finalized.`);
    }
    if (current.nextSequence !== expectedNextSequence) {
      throw new StudyStorageConflictError(
        `Run ${runId} expects sequence ${current.nextSequence}, not ${expectedNextSequence}.`,
      );
    }
    if (current.pendingAction !== null && current.pendingAction !== undefined) {
      throw new StudyStorageStateError(`Run ${runId} still has an uncommitted staged action.`);
    }
    const nextRuns = cloneMap(this.runs);
    const nextEvents = this.#cloneEvents();
    const finalized = cloneJson(current);
    finalized.status = "finalized";
    finalized.updatedAt = updatedAt;
    finalized.finalizedAt = finalizedAt;
    finalized.checkpoint = checkpoint === undefined ? finalized.checkpoint : cloneJson(checkpoint);
    finalized.resultManifest = cloneJson(resultManifest);
    nextRuns.set(runId, finalized);
    this.#commitState(nextRuns, nextEvents);
    return cloneJson(finalized);
  }

  async deleteRun({
    runId,
    expectedStatus,
    expectedUpdatedAt,
    expectedNextSequence,
  } = {}) {
    this.#throwFailure("deleteRun");
    assertIdentifier(runId, "runId");
    if (!["partial", "finalized"].includes(expectedStatus)) {
      throw new StudyStorageValidationError("deleteRun requires an expected run status.");
    }
    if (typeof expectedUpdatedAt !== "string" || expectedUpdatedAt.length < 1) {
      throw new StudyStorageValidationError("deleteRun requires expectedUpdatedAt.");
    }
    assertSafeInteger(expectedNextSequence, "expectedNextSequence", { minimum: 1 });
    const current = this.runs.get(runId);
    if (!current) throw new StudyStorageStateError(`Run ${runId} does not exist.`);
    if (current.status !== expectedStatus
      || current.updatedAt !== expectedUpdatedAt
      || current.nextSequence !== expectedNextSequence) {
      throw new StudyStorageConflictError(
        `Run ${runId} changed before it could be discarded.`,
      );
    }
    const nextRuns = cloneMap(this.runs);
    const nextEvents = this.#cloneEvents();
    nextRuns.delete(runId);
    nextEvents.delete(runId);
    this.#commitState(nextRuns, nextEvents);
    return true;
  }

  async close() {}

  snapshot() {
    return cloneJson({
      runs: [...this.runs.values()],
      events: [...this.events].map(([runId, events]) => ({
        runId,
        values: [...events.values()],
      })),
    });
  }

  #cloneEvents() {
    return new Map([...this.events].map(([runId, events]) => [runId, cloneMap(events)]));
  }

  #commitState(runs, events) {
    const persisted = {
      runs: [...runs.values()],
      events: [...events].map(([runId, values]) => ({ runId, values: [...values.values()] })),
    };
    const size = jsonByteLength(persisted);
    if (size > this.maxBytes) {
      throw new StudyStorageQuotaError(`Memory journal would exceed its ${this.maxBytes}-byte limit.`);
    }
    this.runs = runs;
    this.events = events;
  }

  #throwFailure(operation) {
    const failure = this.failures.get(operation);
    if (!failure) return;
    this.failures.delete(operation);
    throw failure;
  }
}
