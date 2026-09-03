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
  StudyStorageQuotaError,
  StudyStorageStateError,
  StudyStorageValidationError,
} from "./storage-common.js";

export const STUDY_DRAFT_PROTOCOL = "affect-tracker-study-draft";
export const STUDY_PUBLICATION_PROTOCOL = "affect-tracker-study-publication";
export const STUDY_LOCAL_STORAGE_VERSION = 1;
export const DEFAULT_STUDY_DEFINITION_BYTES = 2 * 1024 * 1024;

const DEFAULT_KEY_PREFIX = "affect-tracker.study.v1";

function assertStorage(storage) {
  if (!storage
    || typeof storage.getItem !== "function"
    || typeof storage.setItem !== "function"
    || typeof storage.removeItem !== "function"
    || typeof storage.key !== "function"
    || !Number.isSafeInteger(storage.length)) {
    throw new StudyStorageValidationError("A Web Storage-compatible storage adapter is required.");
  }
  return storage;
}

function exactKeys(value, expected, label) {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new StudyStorageValidationError(`${label} has an unsupported record shape.`);
  }
}

function parseRecord(text, label) {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new StudyStorageValidationError(`${label} contains invalid JSON.`, { cause: error });
  }
}

function compareRevision(left, right) {
  return left.revision - right.revision;
}

export class MemoryKeyValueStorage {
  constructor({ maxBytes = Number.POSITIVE_INFINITY } = {}) {
    if (!(maxBytes === Number.POSITIVE_INFINITY || (Number.isSafeInteger(maxBytes) && maxBytes >= 0))) {
      throw new StudyStorageValidationError("maxBytes must be a non-negative integer or Infinity.");
    }
    this.maxBytes = maxBytes;
    this.values = new Map();
    this.failures = new Map();
  }

  get length() {
    return this.values.size;
  }

  key(index) {
    if (!Number.isSafeInteger(index) || index < 0) return null;
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key) {
    this.#throwFailure("getItem");
    return this.values.get(String(key)) ?? null;
  }

  setItem(key, value) {
    this.#throwFailure("setItem");
    const next = new Map(this.values);
    next.set(String(key), String(value));
    const size = [...next].reduce((total, [entryKey, entryValue]) => (
      total + jsonByteLength(entryKey) + jsonByteLength(entryValue)
    ), 0);
    if (size > this.maxBytes) {
      throw new StudyStorageQuotaError(`Memory storage would exceed its ${this.maxBytes}-byte limit.`);
    }
    this.values = next;
  }

  removeItem(key) {
    this.#throwFailure("removeItem");
    this.values.delete(String(key));
  }

  clear() {
    this.#throwFailure("clear");
    this.values.clear();
  }

  failNext(operation, error = new Error(`Injected ${operation} failure.`)) {
    if (!["getItem", "setItem", "removeItem", "clear"].includes(operation)) {
      throw new StudyStorageValidationError("Unknown memory storage operation.");
    }
    this.failures.set(operation, error);
  }

  #throwFailure(operation) {
    const failure = this.failures.get(operation);
    if (!failure) return;
    this.failures.delete(operation);
    throw failure;
  }
}

export class StudyDraftStore {
  constructor({
    storage = globalThis.localStorage,
    canonicalHash,
    now = () => new Date(),
    keyPrefix = DEFAULT_KEY_PREFIX,
    maxStudyDefinitionBytes = DEFAULT_STUDY_DEFINITION_BYTES,
  } = {}) {
    this.storage = assertStorage(storage);
    if (typeof canonicalHash !== "function") {
      throw new StudyStorageValidationError("canonicalHash must be supplied by the study authority.");
    }
    if (typeof now !== "function") throw new StudyStorageValidationError("now must be a function.");
    if (typeof keyPrefix !== "string" || keyPrefix.length < 1 || keyPrefix.length > 128) {
      throw new StudyStorageValidationError("keyPrefix must contain 1–128 characters.");
    }
    assertSafeInteger(maxStudyDefinitionBytes, "maxStudyDefinitionBytes", { minimum: 1 });
    this.canonicalHash = canonicalHash;
    this.now = now;
    this.keyPrefix = keyPrefix;
    this.maxStudyDefinitionBytes = maxStudyDefinitionBytes;
  }

  saveDraft({ studyId, studyDefinition, expectedRevision } = {}) {
    assertIdentifier(studyId, "studyId");
    const definition = cloneJson(studyDefinition, {
      label: "studyDefinition",
      maxBytes: this.maxStudyDefinitionBytes,
    });
    const current = this.getDraft(studyId);
    const publications = current ? [] : this.listPublications(studyId);
    const currentRevision = current?.revision ?? publications.at(-1)?.revision ?? 0;
    if (expectedRevision !== undefined) {
      assertSafeInteger(expectedRevision, "expectedRevision");
      if (expectedRevision !== currentRevision) {
        throw new StudyStorageConflictError(
          `Draft ${studyId} is at revision ${currentRevision}, not ${expectedRevision}.`,
        );
      }
    }
    const timestamp = isoTimestamp(this.now(), "draft timestamp");
    const record = {
      protocol: STUDY_DRAFT_PROTOCOL,
      version: STUDY_LOCAL_STORAGE_VERSION,
      studyId,
      revision: currentRevision + 1,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
      studyDefinition: definition,
    };
    this.#write(this.#draftKey(studyId), record, "Saving the study draft");
    return immutableJson(record);
  }

  getDraft(studyId) {
    assertIdentifier(studyId, "studyId");
    let text;
    try {
      text = this.storage.getItem(this.#draftKey(studyId));
    } catch (error) {
      throw asStorageError(error, "Reading the study draft");
    }
    if (text === null) return undefined;
    return immutableJson(this.#validateDraft(parseRecord(text, `Draft ${studyId}`), studyId));
  }

  listDrafts() {
    const drafts = [];
    const prefix = `${this.keyPrefix}:draft:`;
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (typeof key !== "string" || !key.startsWith(prefix)) continue;
      let studyId;
      try {
        studyId = decodeURIComponent(key.slice(prefix.length));
      } catch (error) {
        throw new StudyStorageValidationError("Draft storage key is malformed.", { cause: error });
      }
      const draft = this.getDraft(studyId);
      if (draft) drafts.push(draft);
    }
    return Object.freeze(drafts.sort((left, right) => left.studyId.localeCompare(right.studyId)));
  }

  deleteDraft(studyId, { expectedRevision } = {}) {
    assertIdentifier(studyId, "studyId");
    const current = this.getDraft(studyId);
    if (!current) return false;
    if (expectedRevision !== undefined) {
      assertSafeInteger(expectedRevision, "expectedRevision", { minimum: 1 });
      if (expectedRevision !== current.revision) {
        throw new StudyStorageConflictError(
          `Draft ${studyId} is at revision ${current.revision}, not ${expectedRevision}.`,
        );
      }
    }
    try {
      this.storage.removeItem(this.#draftKey(studyId));
    } catch (error) {
      throw asStorageError(error, "Deleting the study draft");
    }
    return true;
  }

  async publishDraft(studyId, { expectedRevision } = {}) {
    assertIdentifier(studyId, "studyId");
    const draft = this.getDraft(studyId);
    if (!draft) throw new StudyStorageStateError(`Draft ${studyId} does not exist.`);
    if (expectedRevision !== undefined) {
      assertSafeInteger(expectedRevision, "expectedRevision", { minimum: 1 });
      if (expectedRevision !== draft.revision) {
        throw new StudyStorageConflictError(
          `Draft ${studyId} is at revision ${draft.revision}, not ${expectedRevision}.`,
        );
      }
    }

    const protocolHash = assertSha256(
      await this.canonicalHash(immutableJson(draft.studyDefinition)),
      "canonicalHash result",
    );
    const publishedDefinition = cloneJson(draft.studyDefinition, {
      label: "studyDefinition",
      maxBytes: this.maxStudyDefinitionBytes,
    });
    publishedDefinition.protocolHash = protocolHash;
    const existing = this.getPublication(studyId, draft.revision);
    if (existing) {
      if (existing.protocolHash !== protocolHash
        || JSON.stringify(existing.studyDefinition) !== JSON.stringify(publishedDefinition)) {
        throw new StudyStorageConflictError(
          `Published revision ${studyId}/${draft.revision} is immutable and has different content.`,
        );
      }
      return immutableJson(existing);
    }

    const publication = {
      protocol: STUDY_PUBLICATION_PROTOCOL,
      version: STUDY_LOCAL_STORAGE_VERSION,
      studyId,
      revision: draft.revision,
      protocolHash,
      publishedAt: isoTimestamp(this.now(), "publication timestamp"),
      studyDefinition: publishedDefinition,
    };
    this.#write(
      this.#publicationKey(studyId, draft.revision, protocolHash),
      publication,
      "Publishing the study snapshot",
    );
    return immutableJson(publication);
  }

  getPublication(studyId, revision) {
    assertIdentifier(studyId, "studyId");
    assertSafeInteger(revision, "revision", { minimum: 1 });
    const prefix = this.#publicationRevisionPrefix(studyId, revision);
    const matches = [];
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (typeof key !== "string" || !key.startsWith(prefix)) continue;
      const keyHash = key.slice(prefix.length);
      assertSha256(keyHash, "publication storage-key hash");
      let text;
      try {
        text = this.storage.getItem(key);
      } catch (error) {
        throw asStorageError(error, "Reading the published study");
      }
      const publication = this.#validatePublication(
        parseRecord(text, `Publication ${studyId}/${revision}`),
        studyId,
        revision,
      );
      if (publication.protocolHash !== keyHash) {
        throw new StudyStorageValidationError("Publication hash does not match its immutable storage key.");
      }
      matches.push(publication);
    }
    if (matches.length === 0) return undefined;
    if (matches.length > 1) {
      throw new StudyStorageConflictError(
        `Published revision ${studyId}/${revision} has multiple immutable snapshots.`,
      );
    }
    return immutableJson(matches[0]);
  }

  listPublications(studyId) {
    assertIdentifier(studyId, "studyId");
    const publications = [];
    const prefix = `${this.keyPrefix}:publication:${encodeURIComponent(studyId)}:`;
    const revisions = new Set();
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (typeof key !== "string" || !key.startsWith(prefix)) continue;
      const [revisionText, hash, ...extra] = key.slice(prefix.length).split(":");
      const revision = Number(revisionText);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new StudyStorageValidationError(`Publication index for ${studyId} is malformed.`);
      }
      if (extra.length > 0) throw new StudyStorageValidationError(`Publication index for ${studyId} is malformed.`);
      assertSha256(hash, "publication storage-key hash");
      revisions.add(revision);
    }
    for (const revision of revisions) {
      const publication = this.getPublication(studyId, revision);
      if (publication) publications.push(publication);
    }
    return Object.freeze(publications.sort(compareRevision));
  }

  #draftKey(studyId) {
    return `${this.keyPrefix}:draft:${encodeURIComponent(studyId)}`;
  }

  #publicationRevisionPrefix(studyId, revision) {
    return `${this.keyPrefix}:publication:${encodeURIComponent(studyId)}:${revision}:`;
  }

  #publicationKey(studyId, revision, protocolHash) {
    return `${this.#publicationRevisionPrefix(studyId, revision)}${protocolHash}`;
  }

  #write(key, record, operation) {
    try {
      this.storage.setItem(key, JSON.stringify(record));
    } catch (error) {
      throw asStorageError(error, operation);
    }
  }

  #validateDraft(value, expectedStudyId) {
    const draft = cloneJson(value, { label: "draft record", maxBytes: this.maxStudyDefinitionBytes + 4_096 });
    exactKeys(draft, [
      "protocol", "version", "studyId", "revision", "createdAt", "updatedAt", "studyDefinition",
    ], "Draft record");
    if (draft.protocol !== STUDY_DRAFT_PROTOCOL || draft.version !== STUDY_LOCAL_STORAGE_VERSION) {
      throw new StudyStorageValidationError("Draft record has an unsupported protocol or version.");
    }
    if (assertIdentifier(draft.studyId, "draft studyId") !== expectedStudyId) {
      throw new StudyStorageValidationError("Draft record studyId does not match its storage key.");
    }
    assertSafeInteger(draft.revision, "draft revision", { minimum: 1 });
    isoTimestamp(draft.createdAt, "draft createdAt");
    isoTimestamp(draft.updatedAt, "draft updatedAt");
    draft.studyDefinition = cloneJson(draft.studyDefinition, {
      label: "studyDefinition",
      maxBytes: this.maxStudyDefinitionBytes,
    });
    return draft;
  }

  #validatePublication(value, expectedStudyId, expectedRevision) {
    const publication = cloneJson(value, {
      label: "publication record",
      maxBytes: this.maxStudyDefinitionBytes + 4_096,
    });
    exactKeys(publication, [
      "protocol", "version", "studyId", "revision", "protocolHash", "publishedAt", "studyDefinition",
    ], "Publication record");
    if (publication.protocol !== STUDY_PUBLICATION_PROTOCOL
      || publication.version !== STUDY_LOCAL_STORAGE_VERSION) {
      throw new StudyStorageValidationError("Publication record has an unsupported protocol or version.");
    }
    if (assertIdentifier(publication.studyId, "publication studyId") !== expectedStudyId) {
      throw new StudyStorageValidationError("Publication studyId does not match its storage key.");
    }
    assertSafeInteger(publication.revision, "publication revision", { minimum: 1 });
    if (publication.revision !== expectedRevision) {
      throw new StudyStorageValidationError("Publication revision does not match its storage key.");
    }
    assertSha256(publication.protocolHash, "publication protocolHash");
    isoTimestamp(publication.publishedAt, "publication publishedAt");
    publication.studyDefinition = cloneJson(publication.studyDefinition, {
      label: "studyDefinition",
      maxBytes: this.maxStudyDefinitionBytes,
    });
    if (publication.studyDefinition.protocolHash !== publication.protocolHash) {
      throw new StudyStorageValidationError("Published study definition hash does not match its record.");
    }
    if (publication.studyDefinition.studyId !== undefined
      && publication.studyDefinition.studyId !== expectedStudyId) {
      throw new StudyStorageValidationError("Published study definition ID does not match its record.");
    }
    if (publication.studyDefinition.revision !== undefined
      && publication.studyDefinition.revision !== expectedRevision) {
      throw new StudyStorageValidationError("Published study definition revision does not match its record.");
    }
    return publication;
  }
}
