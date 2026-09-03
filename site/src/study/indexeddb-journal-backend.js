import {
  assertIdentifier,
  assertSafeInteger,
  cloneJson,
  StudyStorageConflictError,
  StudyStorageQuotaError,
  StudyStorageStateError,
  StudyStorageValidationError,
} from "./storage-common.js";

export const DEFAULT_JOURNAL_DATABASE_NAME = "affect-tracker-study-journal";
export const JOURNAL_DATABASE_VERSION = 1;

const RUN_STORE = "runs";
const EVENT_STORE = "events";

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed.")), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted.")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed.")), { once: true });
  });
}

async function abortTransaction(transaction, completion) {
  try {
    transaction.abort();
  } catch {
    // It may already have been aborted by IndexedDB.
  }
  await completion.catch(() => {});
}

export class IndexedDbJournalBackend {
  constructor({
    indexedDB = globalThis.indexedDB,
    keyRange = globalThis.IDBKeyRange,
    databaseName = DEFAULT_JOURNAL_DATABASE_NAME,
    databaseVersion = JOURNAL_DATABASE_VERSION,
  } = {}) {
    if (!indexedDB || typeof indexedDB.open !== "function") {
      throw new StudyStorageValidationError("IndexedDB is not available in this browser.");
    }
    if (!keyRange || typeof keyRange.bound !== "function") {
      throw new StudyStorageValidationError("IDBKeyRange is not available in this browser.");
    }
    if (typeof databaseName !== "string" || databaseName.length < 1 || databaseName.length > 128) {
      throw new StudyStorageValidationError("databaseName must contain 1–128 characters.");
    }
    assertSafeInteger(databaseVersion, "databaseVersion", { minimum: 1 });
    this.indexedDB = indexedDB;
    this.keyRange = keyRange;
    this.databaseName = databaseName;
    this.databaseVersion = databaseVersion;
    this.databasePromise = undefined;
  }

  async open() {
    return this.#database();
  }

  async createRun(record) {
    assertIdentifier(record?.runId, "runId");
    const database = await this.#database();
    const transaction = database.transaction([RUN_STORE], "readwrite");
    const completion = transactionDone(transaction);
    const store = transaction.objectStore(RUN_STORE);
    const existing = await requestValue(store.get(record.runId));
    if (existing !== undefined) {
      await abortTransaction(transaction, completion);
      throw new StudyStorageConflictError(`Run ${record.runId} already exists.`);
    }
    store.add(cloneJson(record));
    await completion;
  }

  async getRun(runId) {
    assertIdentifier(runId, "runId");
    const database = await this.#database();
    const transaction = database.transaction([RUN_STORE], "readonly");
    const completion = transactionDone(transaction);
    const value = await requestValue(transaction.objectStore(RUN_STORE).get(runId));
    await completion;
    return value === undefined ? undefined : cloneJson(value);
  }

  async listRuns() {
    const database = await this.#database();
    const transaction = database.transaction([RUN_STORE], "readonly");
    const completion = transactionDone(transaction);
    const values = await requestValue(transaction.objectStore(RUN_STORE).getAll());
    await completion;
    return values.map((value) => cloneJson(value));
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
    assertIdentifier(runId, "runId");
    assertSafeInteger(expectedNextSequence, "expectedNextSequence");
    assertSafeInteger(nextSequence, "nextSequence");
    assertSafeInteger(eventBytesDelta, "eventBytesDelta");
    assertSafeInteger(maxRunBytes, "maxRunBytes", { minimum: 1 });
    if (!Array.isArray(events) || nextSequence !== expectedNextSequence + events.length) {
      throw new StudyStorageValidationError("Event batch does not match nextSequence.");
    }
    const database = await this.#database();
    const transaction = database.transaction([RUN_STORE, EVENT_STORE], "readwrite");
    const completion = transactionDone(transaction);
    const runStore = transaction.objectStore(RUN_STORE);
    const eventStore = transaction.objectStore(EVENT_STORE);
    const current = await requestValue(runStore.get(runId));
    if (!current) {
      await abortTransaction(transaction, completion);
      throw new StudyStorageStateError(`Run ${runId} does not exist.`);
    }
    if (current.status !== "partial") {
      await abortTransaction(transaction, completion);
      throw new StudyStorageStateError(`Run ${runId} is finalized and cannot be changed.`);
    }
    if (current.nextSequence !== expectedNextSequence) {
      await abortTransaction(transaction, completion);
      throw new StudyStorageConflictError(
        `Run ${runId} expects sequence ${current.nextSequence}, not ${expectedNextSequence}.`,
      );
    }
    if (expectedPendingActionId !== undefined
      && current.pendingAction?.action?.actionId !== expectedPendingActionId) {
      await abortTransaction(transaction, completion);
      throw new StudyStorageConflictError(
        `Run ${runId} does not have staged action ${expectedPendingActionId}.`,
      );
    }

    for (let index = 0; index < events.length; index += 1) {
      const event = cloneJson(events[index]);
      const sequence = expectedNextSequence + index;
      if (event.runId !== runId || event.sequence !== sequence) {
        await abortTransaction(transaction, completion);
        throw new StudyStorageValidationError("Event identity does not match its journal position.");
      }
      eventStore.add({ runId, sequence, event });
    }
    const updated = cloneJson(current);
    const currentEventBytes = current.eventBytes ?? 0;
    assertSafeInteger(currentEventBytes, "current eventBytes");
    if (currentEventBytes + eventBytesDelta > maxRunBytes) {
      await abortTransaction(transaction, completion);
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
    runStore.put(updated);
    await completion;
    return cloneJson(updated);
  }

  async getEvents(runId, { fromSequence, limit }) {
    assertIdentifier(runId, "runId");
    assertSafeInteger(fromSequence, "fromSequence");
    assertSafeInteger(limit, "limit", { minimum: 1 });
    const database = await this.#database();
    const transaction = database.transaction([EVENT_STORE], "readonly");
    const completion = transactionDone(transaction);
    const range = this.keyRange.bound(
      [runId, fromSequence],
      [runId, Number.MAX_SAFE_INTEGER],
    );
    const records = await requestValue(transaction.objectStore(EVENT_STORE).getAll(range, limit));
    await completion;
    return records.map((record) => cloneJson(record.event));
  }

  async finalizeRun({
    runId,
    expectedNextSequence,
    updatedAt,
    finalizedAt,
    checkpoint,
    resultManifest,
  }) {
    assertIdentifier(runId, "runId");
    assertSafeInteger(expectedNextSequence, "expectedNextSequence");
    const database = await this.#database();
    const transaction = database.transaction([RUN_STORE], "readwrite");
    const completion = transactionDone(transaction);
    const store = transaction.objectStore(RUN_STORE);
    const current = await requestValue(store.get(runId));
    if (!current) {
      await abortTransaction(transaction, completion);
      throw new StudyStorageStateError(`Run ${runId} does not exist.`);
    }
    if (current.status !== "partial") {
      await abortTransaction(transaction, completion);
      throw new StudyStorageStateError(`Run ${runId} is already finalized.`);
    }
    if (current.nextSequence !== expectedNextSequence) {
      await abortTransaction(transaction, completion);
      throw new StudyStorageConflictError(
        `Run ${runId} expects sequence ${current.nextSequence}, not ${expectedNextSequence}.`,
      );
    }
    if (current.pendingAction !== null && current.pendingAction !== undefined) {
      await abortTransaction(transaction, completion);
      throw new StudyStorageStateError(`Run ${runId} still has an uncommitted staged action.`);
    }
    const finalized = cloneJson(current);
    finalized.status = "finalized";
    finalized.updatedAt = updatedAt;
    finalized.finalizedAt = finalizedAt;
    finalized.checkpoint = checkpoint === undefined ? finalized.checkpoint : cloneJson(checkpoint);
    finalized.resultManifest = cloneJson(resultManifest);
    store.put(finalized);
    await completion;
    return cloneJson(finalized);
  }

  async deleteRun({
    runId,
    expectedStatus,
    expectedUpdatedAt,
    expectedNextSequence,
  } = {}) {
    assertIdentifier(runId, "runId");
    if (!["partial", "finalized"].includes(expectedStatus)) {
      throw new StudyStorageValidationError("deleteRun requires an expected run status.");
    }
    if (typeof expectedUpdatedAt !== "string" || expectedUpdatedAt.length < 1) {
      throw new StudyStorageValidationError("deleteRun requires expectedUpdatedAt.");
    }
    assertSafeInteger(expectedNextSequence, "expectedNextSequence", { minimum: 1 });
    const database = await this.#database();
    const transaction = database.transaction([RUN_STORE, EVENT_STORE], "readwrite");
    const completion = transactionDone(transaction);
    const runStore = transaction.objectStore(RUN_STORE);
    const current = await requestValue(runStore.get(runId));
    if (!current) {
      await abortTransaction(transaction, completion);
      throw new StudyStorageStateError(`Run ${runId} does not exist.`);
    }
    if (current.status !== expectedStatus
      || current.updatedAt !== expectedUpdatedAt
      || current.nextSequence !== expectedNextSequence) {
      await abortTransaction(transaction, completion);
      throw new StudyStorageConflictError(
        `Run ${runId} changed before it could be discarded.`,
      );
    }
    runStore.delete(runId);
    transaction.objectStore(EVENT_STORE).delete(this.keyRange.bound(
      [runId, 0],
      [runId, Number.MAX_SAFE_INTEGER],
    ));
    await completion;
    return true;
  }

  async close() {
    if (!this.databasePromise) return;
    const database = await this.databasePromise;
    database.close();
    this.databasePromise = undefined;
  }

  #database() {
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        const request = this.indexedDB.open(this.databaseName, this.databaseVersion);
        request.addEventListener("upgradeneeded", () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(RUN_STORE)) {
            database.createObjectStore(RUN_STORE, { keyPath: "runId" });
          }
          if (!database.objectStoreNames.contains(EVENT_STORE)) {
            database.createObjectStore(EVENT_STORE, { keyPath: ["runId", "sequence"] });
          }
        });
        request.addEventListener("blocked", () => {
          reject(new StudyStorageStateError(
            `IndexedDB upgrade for ${this.databaseName} is blocked by another open page.`,
          ));
        }, { once: true });
        request.addEventListener("error", () => {
          reject(request.error ?? new Error("Unable to open IndexedDB."));
        }, { once: true });
        request.addEventListener("success", () => {
          const database = request.result;
          database.addEventListener("versionchange", () => database.close());
          resolve(database);
        }, { once: true });
      }).catch((error) => {
        this.databasePromise = undefined;
        throw error;
      });
    }
    return this.databasePromise;
  }
}
