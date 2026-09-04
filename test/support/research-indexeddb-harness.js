function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function serializedKey(key) {
  return JSON.stringify(key);
}

function compareKeys(left, right) {
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      const compared = compareKeys(left[index], right[index]);
      if (compared !== 0) return compared;
    }
    return Math.sign(left.length - right.length);
  }
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function matchesRange(key, range) {
  if (!range) return true;
  const lower = compareKeys(key, range.lower);
  const upper = compareKeys(key, range.upper);
  return (range.lowerOpen ? lower > 0 : lower >= 0)
    && (range.upperOpen ? upper < 0 : upper <= 0);
}

function makeError(name, message) {
  return new DOMException(message, name);
}

class HarnessRequest extends EventTarget {
  constructor() {
    super();
    this.result = undefined;
    this.error = null;
  }
}

class StoreState {
  constructor({ keyPath = null, autoIncrement = false } = {}) {
    this.keyPath = copy(keyPath);
    this.autoIncrement = autoIncrement;
    this.nextKey = 1;
    this.records = new Map();
    this.indexes = new Map();
  }

  clone() {
    const result = new StoreState({ keyPath: this.keyPath, autoIncrement: this.autoIncrement });
    result.nextKey = this.nextKey;
    result.indexes = new Map(this.indexes);
    result.records = new Map([...this.records].map(([serialized, entry]) => [serialized, copy(entry)]));
    return result;
  }
}

class DatabaseState {
  constructor() {
    this.version = 0;
    this.stores = new Map();
  }
}

function extractKey(state, value, explicitKey) {
  if (explicitKey !== undefined) return copy(explicitKey);
  if (Array.isArray(state.keyPath)) return state.keyPath.map((member) => value?.[member]);
  if (typeof state.keyPath === "string") return value?.[state.keyPath];
  if (state.autoIncrement) {
    const key = state.nextKey;
    state.nextKey += 1;
    return key;
  }
  return undefined;
}

class HarnessIndex {
  constructor(transaction, storeName, keyPath) {
    this.transaction = transaction;
    this.storeName = storeName;
    this.keyPath = keyPath;
  }

  getAll(query) {
    return this.transaction.queue(this.storeName, "index.getAll", (state) => (
      [...state.records.values()]
        .filter(({ value }) => value?.[this.keyPath] === query)
        .sort((left, right) => compareKeys(left.key, right.key))
        .map(({ value }) => copy(value))
    ));
  }
}

class HarnessObjectStore {
  constructor(transaction, storeName) {
    this.transaction = transaction;
    this.storeName = storeName;
  }

  get(key) {
    return this.transaction.queue(this.storeName, "get", (state) => (
      copy(state.records.get(serializedKey(key))?.value)
    ));
  }

  getAll(range = null, limit = undefined) {
    return this.transaction.queue(this.storeName, "getAll", (state) => {
      const values = [...state.records.values()]
        .filter(({ key }) => matchesRange(key, range))
        .sort((left, right) => compareKeys(left.key, right.key))
        .map(({ value }) => copy(value));
      return limit === undefined ? values : values.slice(0, limit);
    });
  }

  count(range = null) {
    return this.transaction.queue(this.storeName, "count", (state) => (
      [...state.records.values()].filter(({ key }) => matchesRange(key, range)).length
    ));
  }

  add(value, explicitKey = undefined) {
    return this.transaction.queue(this.storeName, "add", (state) => {
      const key = extractKey(state, value, explicitKey);
      if (key === undefined || Array.isArray(key) && key.some((member) => member === undefined)) {
        throw makeError("DataError", "The record has no valid key.");
      }
      const serialized = serializedKey(key);
      if (state.records.has(serialized)) {
        throw makeError("ConstraintError", "The record key already exists.");
      }
      state.records.set(serialized, { key: copy(key), value: copy(value) });
      return copy(key);
    });
  }

  put(value, explicitKey = undefined) {
    return this.transaction.queue(this.storeName, "put", (state) => {
      const key = extractKey(state, value, explicitKey);
      if (key === undefined || Array.isArray(key) && key.some((member) => member === undefined)) {
        throw makeError("DataError", "The record has no valid key.");
      }
      state.records.set(serializedKey(key), { key: copy(key), value: copy(value) });
      return copy(key);
    });
  }

  delete(key) {
    return this.transaction.queue(this.storeName, "delete", (state) => {
      state.records.delete(serializedKey(key));
      return undefined;
    });
  }

  index(name) {
    const state = this.transaction.storeState(this.storeName);
    const keyPath = state.indexes.get(name);
    if (!keyPath) throw makeError("NotFoundError", `Index ${name} does not exist.`);
    return new HarnessIndex(this.transaction, this.storeName, keyPath);
  }
}

class HarnessTransaction extends EventTarget {
  constructor(databaseState, storeNames, mode, factory) {
    super();
    this.databaseState = databaseState;
    this.storeNames = new Set(storeNames);
    this.mode = mode;
    this.factory = factory;
    this.error = null;
    this.pending = 0;
    this.settled = false;
    this.completionHandle = null;
    this.workingStores = new Map(storeNames.map((name) => {
      const state = databaseState.stores.get(name);
      if (!state) throw makeError("NotFoundError", `Store ${name} does not exist.`);
      return [name, state.clone()];
    }));
    this.commitFailure = factory.takeCommitFailure(mode);
    this.scheduleCompletion();
  }

  objectStore(name) {
    this.storeState(name);
    return new HarnessObjectStore(this, name);
  }

  storeState(name) {
    if (!this.storeNames.has(name)) {
      throw makeError("NotFoundError", `Store ${name} is outside this transaction.`);
    }
    return this.workingStores.get(name);
  }

  queue(storeName, operation, action) {
    if (this.settled) throw makeError("TransactionInactiveError", "The transaction is no longer active.");
    if (this.mode === "readonly" && ["add", "put", "delete"].includes(operation)) {
      throw makeError("ReadOnlyError", "The transaction is read-only.");
    }
    const request = new HarnessRequest();
    this.pending += 1;
    if (this.completionHandle !== null) {
      clearImmediate(this.completionHandle);
      this.completionHandle = null;
    }
    queueMicrotask(() => {
      if (this.settled) {
        this.pending -= 1;
        return;
      }
      const failure = this.factory.takeRequestFailure(storeName, operation);
      if (failure) {
        request.error = failure;
        request.dispatchEvent(new Event("error"));
        this.pending -= 1;
        this.fail(failure);
        return;
      }
      try {
        request.result = action(this.storeState(storeName));
        request.dispatchEvent(new Event("success"));
      } catch (error) {
        request.error = error;
        request.dispatchEvent(new Event("error"));
        this.pending -= 1;
        this.fail(error);
        return;
      }
      this.pending -= 1;
      this.scheduleCompletion();
    });
    return request;
  }

  abort() {
    if (this.settled) throw makeError("InvalidStateError", "The transaction has already settled.");
    this.fail(makeError("AbortError", "The transaction was aborted."));
  }

  fail(error) {
    if (this.settled) return;
    this.settled = true;
    this.error = error;
    if (this.completionHandle !== null) clearImmediate(this.completionHandle);
    this.completionHandle = null;
    this.dispatchEvent(new Event("abort"));
  }

  scheduleCompletion() {
    if (this.settled || this.pending !== 0 || this.completionHandle !== null) return;
    this.completionHandle = setImmediate(() => {
      this.completionHandle = null;
      if (this.settled || this.pending !== 0) return;
      if (this.commitFailure) {
        this.fail(this.commitFailure);
        return;
      }
      if (this.mode === "readwrite") {
        for (const [name, state] of this.workingStores) {
          this.databaseState.stores.set(name, state.clone());
        }
      }
      this.settled = true;
      this.dispatchEvent(new Event("complete"));
    });
  }
}

class UpgradeObjectStore {
  constructor(state) {
    this.state = state;
  }

  createIndex(name, keyPath) {
    this.state.indexes.set(name, keyPath);
  }
}

class HarnessDatabase extends EventTarget {
  constructor(state, factory) {
    super();
    this.state = state;
    this.factory = factory;
    this.closed = false;
    this.objectStoreNames = {
      contains: (name) => this.state.stores.has(name),
    };
  }

  createObjectStore(name, options = {}) {
    if (this.state.stores.has(name)) throw makeError("ConstraintError", `Store ${name} already exists.`);
    const state = new StoreState(options);
    this.state.stores.set(name, state);
    return new UpgradeObjectStore(state);
  }

  transaction(storeNames, mode = "readonly") {
    if (this.closed) throw makeError("InvalidStateError", "The database connection is closed.");
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    this.factory.transactionCount += 1;
    return new HarnessTransaction(this.state, names, mode, this.factory);
  }

  close() {
    this.closed = true;
  }
}

export const ResearchIdbKeyRange = Object.freeze({
  bound(lower, upper, lowerOpen = false, upperOpen = false) {
    return { lower: copy(lower), upper: copy(upper), lowerOpen, upperOpen };
  },
});

export class ResearchIndexedDbHarness {
  constructor() {
    this.databases = new Map();
    this.requestFailures = [];
    this.commitFailures = [];
    this.openCount = 0;
    this.transactionCount = 0;
  }

  open(name, version = 1) {
    const request = new HarnessRequest();
    this.openCount += 1;
    queueMicrotask(() => {
      let state = this.databases.get(name);
      if (!state) {
        state = new DatabaseState();
        this.databases.set(name, state);
      }
      if (version < state.version) {
        request.error = makeError("VersionError", "The requested version is older than the database.");
        request.dispatchEvent(new Event("error"));
        return;
      }
      const database = new HarnessDatabase(state, this);
      request.result = database;
      if (version > state.version) {
        request.dispatchEvent(new Event("upgradeneeded"));
        state.version = version;
      }
      queueMicrotask(() => request.dispatchEvent(new Event("success")));
    });
    return request;
  }

  abortNextReadwriteCommit(error = makeError("AbortError", "Injected commit abort.")) {
    this.commitFailures.push({ mode: "readwrite", error });
  }

  rejectNextRequest({ storeName, operation, error }) {
    this.requestFailures.push({ storeName, operation, error });
  }

  takeCommitFailure(mode) {
    const index = this.commitFailures.findIndex((failure) => failure.mode === mode);
    if (index < 0) return null;
    return this.commitFailures.splice(index, 1)[0].error;
  }

  takeRequestFailure(storeName, operation) {
    const index = this.requestFailures.findIndex((failure) => (
      failure.storeName === storeName && failure.operation === operation
    ));
    if (index < 0) return null;
    return this.requestFailures.splice(index, 1)[0].error;
  }
}

export function idbRequestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

export function idbTransactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
  });
}
