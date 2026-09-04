import {
  validateResearchEventV1,
  validateResearchRunManifestV2,
  validateResearchSampleV1,
} from "./contracts.js";

export const RESEARCH_JOURNAL_DATABASE = "affect-research/v1";
export const RESEARCH_JOURNAL_VERSION = 2;

const RESEARCH_ATTEMPT_VERSION = 1;

const ATTEMPTS = "attempts";
const SAMPLES = "samples";
const EVENTS = "events";
const LOCKS = "participant-locks";
const QUARANTINE = "quarantine";

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORKSPACE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const TERMINAL_STATUSES = new Set(["partial", "complete"]);

export class ResearchJournalError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ResearchJournalError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new ResearchJournalError(code, message, options);
}

function clone(value) {
  return structuredClone(value);
}

function recoveryContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-record", "Attempt recovery context must be an object.");
  }
  const text = JSON.stringify(value, (key, member) => {
    if (/^(firstName|lastName|selfDescription)$/iu.test(key)) {
      fail("privacy-boundary", "Raw names and self-description must not enter recovery storage.");
    }
    if (typeof member === "number" && !Number.isFinite(member)) {
      fail("invalid-record", "Attempt recovery context must contain finite JSON values.");
    }
    return member;
  });
  if (!text || text.length > 4 * 1024 * 1024) {
    fail("invalid-record", "Attempt recovery context exceeds the 4 MiB limit.");
  }
  return JSON.parse(text);
}

function assignmentFromContext(context, participantId) {
  const assignments = context?.plan?.assignments;
  if (!Array.isArray(assignments)) return null;
  const matches = assignments.filter((assignment) => assignment?.participantId === participantId);
  if (matches.length !== 1 || !Array.isArray(matches[0].slots)) {
    fail("corrupt-record", "Frozen recovery plan does not contain exactly one reserved participant assignment.");
  }
  return matches[0];
}

function rejectDetachedAssignment(context) {
  if (Object.hasOwn(context, "assignment")) {
    fail("invalid-record", "Recovery context must derive its assignment from the frozen plan, not store a detached copy.");
  }
}

function immutable(value) {
  const result = clone(value);
  const freeze = (current) => {
    if (current && typeof current === "object" && !Object.isFrozen(current)) {
      Object.freeze(current);
      for (const child of Object.values(current)) freeze(child);
    }
    return current;
  };
  return freeze(result);
}

function identifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail("invalid-record", `${label} must be a safe identifier.`);
  }
  return value;
}

function sessionStem(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 240
    || value === "." || value === ".." || /[<>:"/\\|?*\u0000-\u001f]/u.test(value)) {
    fail("invalid-record", "sessionStem must be a filename-safe basename.");
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("invalid-record", `${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail("invalid-record", `${label} must be an integer of at least ${minimum}.`);
  }
  return value;
}

function isoTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail("invalid-record", `${label} must be an ISO timestamp.`);
  }
  return value;
}

function lockKey(experimentId, participantId, workspaceId = "legacy-unbound") {
  return `${identifier(workspaceId, "workspaceId")}::${identifier(experimentId, "experimentId")}::${identifier(participantId, "participantId")}`;
}

function validateReservation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("invalid-record", "Attempt reservation must be an object.");
  }
  const allowed = [
    "runId", "experimentId", "participantId", "attemptNumber", "sessionStem",
    "settingsHash", "planHash", "createdAt", "ownerId", "context",
  ];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0 || allowed.some((key) => !(key in input))) {
    fail("invalid-record", "Attempt reservation has an unsupported shape.");
  }
  const context = recoveryContext(input.context);
  rejectDetachedAssignment(context);
  if (typeof context.workspaceId !== "string" || !WORKSPACE_ID.test(context.workspaceId)) {
    fail("invalid-record", "Attempt recovery context requires the selected workspace UUID.");
  }
  return Object.freeze({
    runId: identifier(input.runId, "runId"),
    experimentId: identifier(input.experimentId, "experimentId"),
    participantId: identifier(input.participantId, "participantId"),
    attemptNumber: integer(input.attemptNumber, "attemptNumber", 1),
    sessionStem: sessionStem(input.sessionStem),
    settingsHash: hash(input.settingsHash, "settingsHash"),
    planHash: hash(input.planHash, "planHash"),
    createdAt: isoTimestamp(input.createdAt, "createdAt"),
    ownerId: identifier(input.ownerId, "ownerId"),
    context,
  });
}

function validateSequencedRecords(records, runId, expectedStart, kind, attempt) {
  const label = kind === "sample" ? "samples" : "events";
  if (!Array.isArray(records)) fail("invalid-record", `${label} must be an array.`);
  return records.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      fail("invalid-record", `${label}[${index}] must be an object.`);
    }
    if (record.runId !== runId || record.sequence !== expectedStart + index) {
      fail("sequence-conflict", `${label}[${index}] does not match the journal sequence.`);
    }
    let normalized;
    try {
      normalized = kind === "sample"
        ? validateResearchSampleV1(record)
        : validateResearchEventV1(record);
    } catch (error) {
      fail("corrupt-record", `${label}[${index}] violates its strict Research contract.`, { cause: error });
    }
    if (normalized.participantId !== attempt.participantId
      || normalized.attemptNumber !== attempt.attemptNumber
      || normalized.settingsSha256 !== attempt.settingsHash
      || normalized.assignmentPlanSha256 !== attempt.planHash) {
      fail("corrupt-record", `${label}[${index}] does not bind the reserved attempt.`);
    }
    const assignment = assignmentFromContext(attempt.context, attempt.participantId);
    if (assignment && normalized.stimulusIdentity !== null) {
      const position = normalized.stimulusPosition;
      const slot = assignment.slots[position - 1];
      const stimulus = attempt.context.plan.stimuli?.find(({ stimulusId }) => stimulusId === slot?.stimulusId);
      if (!slot || slot.position !== position || normalized.stimulusIdentity.stimulusId !== slot.stimulusId || !stimulus) {
        fail("corrupt-record", `${label}[${index}] does not bind the resolved assignment position.`);
      }
      const source = stimulus.source;
      const sourceDuration = source.kind === "youtube" ? source.observedDurationMs : source.durationMs;
      if (normalized.stimulusIdentity.kind !== source.kind
        || normalized.stimulusIdentity.durationMs !== sourceDuration
        || (source.kind === "youtube"
          ? normalized.stimulusIdentity.videoId !== source.videoId || normalized.stimulusIdentity.url !== source.url
          : normalized.stimulusIdentity.sha256 !== source.sha256 || normalized.stimulusIdentity.byteLength !== source.byteLength)) {
        fail("corrupt-record", `${label}[${index}] stimulus identity differs from the frozen plan.`);
      }
    }
    return clone(normalized);
  });
}

function validateRecordTimeline(records, kind, previous = null) {
  let prior = previous;
  for (const record of records) {
    if (prior) {
      if (BigInt(record.monotonicTimeNs) < BigInt(prior.monotonicTimeNs)) {
        fail("corrupt-record", `${kind} monotonic timestamps move backward.`);
      }
      if (kind === "sample") {
        if (record.scheduledElapsedMs <= prior.scheduledElapsedMs
          || record.observedElapsedMs < prior.observedElapsedMs) {
          fail("corrupt-record", "Sample deadline or observation time is not monotonically increasing.");
        }
        if (record.sampleRateHz !== prior.sampleRateHz) {
          fail("corrupt-record", "Sample rate changed within one attempt.");
        }
      }
    }
    prior = record;
  }
  return records;
}

function validateStimulusState(stimulusState, attempt) {
  if (stimulusState === null || stimulusState === undefined) return null;
  if (!stimulusState || typeof stimulusState !== "object" || Array.isArray(stimulusState)
    || Object.keys(stimulusState).sort().join(",") !== "activeStimulusIndex,safeStimulusIndex") {
    fail("invalid-record", "Stimulus state transition has an unsupported shape.");
  }
  const safeStimulusIndex = integer(stimulusState.safeStimulusIndex, "safeStimulusIndex");
  const activeStimulusIndex = stimulusState.activeStimulusIndex === null
    ? null
    : integer(stimulusState.activeStimulusIndex, "activeStimulusIndex");
  if (safeStimulusIndex < attempt.safeStimulusIndex) {
    fail("unsafe-recovery", "Safe stimulus boundary cannot move backward.");
  }
  if (activeStimulusIndex !== null && activeStimulusIndex !== safeStimulusIndex) {
    fail("unsafe-recovery", "An active stimulus must start at the recorded safe boundary.");
  }
  const assignment = assignmentFromContext(attempt.context, attempt.participantId);
  if (assignment && (safeStimulusIndex > assignment.slots.length
    || activeStimulusIndex !== null && activeStimulusIndex >= assignment.slots.length)) {
    fail("unsafe-recovery", "Stimulus state exceeds the frozen assignment.");
  }
  return { activeStimulusIndex, safeStimulusIndex };
}

function validatePendingFinalization(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "completionStatus,finalizedAt,recovery") {
    fail("corrupt-attempt", "Pending finalization has an unsupported shape.");
  }
  if (!["completed", "partial"].includes(value.completionStatus)) {
    fail("corrupt-attempt", "Pending finalization has an invalid completion status.");
  }
  isoTimestamp(value.finalizedAt, "pending finalization time");
  const recovery = value.recovery;
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)
    || Object.keys(recovery).sort().join(",") !== "restartedStimulusIds,resumed,sourceRunId"
    || typeof recovery.resumed !== "boolean"
    || recovery.resumed !== (recovery.sourceRunId !== null)
    || !Array.isArray(recovery.restartedStimulusIds)) {
    fail("corrupt-attempt", "Pending finalization recovery metadata is invalid.");
  }
  if (recovery.sourceRunId !== null) identifier(recovery.sourceRunId, "pending sourceRunId");
  recovery.restartedStimulusIds.forEach((id) => identifier(id, "pending restarted stimulus ID"));
  return value;
}

function validateManifestForAttempt(manifest, attempt) {
  let normalized;
  try {
    normalized = validateResearchRunManifestV2(manifest);
  } catch (error) {
    fail("corrupt-record", "Run manifest violates ResearchRunManifestV2.", { cause: error });
  }
  if (normalized.runId !== attempt.runId
    || normalized.experimentId !== attempt.experimentId
    || normalized.participantId !== attempt.participantId
    || normalized.attemptNumber !== attempt.attemptNumber
    || normalized.settingsSha256 !== attempt.settingsHash
    || normalized.assignmentPlanSha256 !== attempt.planHash) {
    fail("corrupt-record", "Run manifest does not bind the reserved attempt.");
  }
  const assignment = assignmentFromContext(attempt.context, attempt.participantId);
  if (assignment) {
    if (normalized.stimuli.length !== assignment.slots.length) {
      fail("corrupt-record", "Run manifest stimulus list does not cover the frozen assignment.");
    }
    normalized.stimuli.forEach((identity, index) => {
      const slot = assignment.slots[index];
      const stimulus = attempt.context.plan.stimuli?.find(({ stimulusId }) => stimulusId === slot?.stimulusId);
      const source = stimulus?.source;
      const durationMs = source?.kind === "youtube" ? source.observedDurationMs : source?.durationMs;
      if (!stimulus || identity.stimulusId !== slot.stimulusId || identity.kind !== source.kind
        || identity.durationMs !== durationMs
        || (source.kind === "youtube"
          ? identity.url !== source.url || identity.videoId !== source.videoId
          : identity.sha256 !== source.sha256 || identity.byteLength !== source.byteLength)) {
        fail("corrupt-record", `Run manifest stimulus ${index + 1} differs from the frozen assignment.`);
      }
    });
  }
  return normalized;
}

function initialAttempt(reservation) {
  return {
    protocol: "affect-research-browser-journal",
    version: RESEARCH_ATTEMPT_VERSION,
    ...reservation,
    status: "active",
    updatedAt: reservation.createdAt,
    safeStimulusIndex: 0,
    activeStimulusIndex: null,
    nextSampleSequence: 1,
    nextEventSequence: 1,
    finalizedAt: null,
    manifest: null,
    interruption: null,
    recoverable: false,
    pendingFinalization: null,
  };
}

function validateStoredAttempt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("corrupt-attempt", "Stored attempt must be an object.");
  }
  const allowed = [
    "protocol", "version", "runId", "experimentId", "participantId", "attemptNumber",
    "sessionStem", "settingsHash", "planHash", "createdAt", "ownerId", "context",
    "status", "updatedAt", "safeStimulusIndex", "activeStimulusIndex",
    "nextSampleSequence", "nextEventSequence", "finalizedAt", "manifest",
    "interruption", "recoverable", "pendingFinalization",
  ];
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
    fail("corrupt-attempt", "Stored attempt has an unsupported shape.");
  }
  if (value.protocol !== "affect-research-browser-journal" || value.version !== RESEARCH_ATTEMPT_VERSION) {
    fail("corrupt-attempt", "Stored attempt has an unsupported protocol version.");
  }
  const reservation = validateReservation(Object.fromEntries([
    "runId", "experimentId", "participantId", "attemptNumber", "sessionStem",
    "settingsHash", "planHash", "createdAt", "ownerId", "context",
  ].map((key) => [key, value[key]])));
  if (!["active", "partial", "complete"].includes(value.status)) {
    fail("corrupt-attempt", "Stored attempt has an invalid status.");
  }
  isoTimestamp(value.updatedAt, "updatedAt");
  integer(value.safeStimulusIndex, "safeStimulusIndex");
  if (value.activeStimulusIndex !== null) integer(value.activeStimulusIndex, "activeStimulusIndex");
  integer(value.nextSampleSequence, "nextSampleSequence", 1);
  integer(value.nextEventSequence, "nextEventSequence", 1);
  if (value.finalizedAt !== null) isoTimestamp(value.finalizedAt, "finalizedAt");
  if (typeof value.recoverable !== "boolean") fail("corrupt-attempt", "Stored attempt recoverable must be boolean.");
  if (value.interruption !== null) {
    if (!value.interruption || typeof value.interruption !== "object" || Array.isArray(value.interruption)
      || Object.keys(value.interruption).sort().join(",") !== "at,interruptedStimulusIndex,reason,restartStimulusIndex") {
      fail("corrupt-attempt", "Stored interruption has an unsupported shape.");
    }
    identifier(value.interruption.reason, "interruption reason");
    isoTimestamp(value.interruption.at, "interruption time");
    integer(value.interruption.restartStimulusIndex, "restartStimulusIndex");
    if (value.interruption.interruptedStimulusIndex !== null) {
      integer(value.interruption.interruptedStimulusIndex, "interruptedStimulusIndex");
    }
  }
  if (value.manifest !== null) validateManifestForAttempt(value.manifest, value);
  validatePendingFinalization(value.pendingFinalization);
  if (value.status === "active" && (value.finalizedAt !== null || value.manifest !== null || value.recoverable)) {
    fail("corrupt-attempt", "An active attempt cannot be finalized, manifested, or marked recoverable.");
  }
  if (value.status === "complete" && (value.finalizedAt === null || value.manifest === null || value.recoverable)) {
    fail("corrupt-attempt", "A complete attempt requires a terminal manifest and cannot be recoverable.");
  }
  if (value.status === "partial" && value.recoverable && (value.finalizedAt !== null || value.manifest !== null)) {
    fail("corrupt-attempt", "A recoverable partial cannot already have terminal artifacts.");
  }
  if (value.status === "partial" && !value.recoverable && (value.finalizedAt === null || value.manifest === null)) {
    fail("corrupt-attempt", "A terminal partial requires its final manifest.");
  }
  if (value.manifest !== null && (value.pendingFinalization === null
    || value.pendingFinalization.completionStatus !== value.manifest.completionStatus
    || value.pendingFinalization.finalizedAt !== value.manifest.timing.finalizedAt)) {
    fail("corrupt-attempt", "Terminal manifest does not bind its prepared finalization descriptor.");
  }
  return Object.freeze({ ...value, ...reservation });
}

function validateStoredEvidence(rawAttempt, sampleEntries, eventEntries) {
  const attempt = validateStoredAttempt(rawAttempt);
  const normalizeEntries = (entries, kind) => {
    const records = entries.map((entry, index) => {
      if (!entry || entry.runId !== attempt.runId || entry.sequence !== entry.value?.sequence) {
        fail("corrupt-record", `${kind}[${index}] has a corrupt storage key.`);
      }
      return entry.value;
    });
    const watermark = kind === "samples" ? attempt.nextSampleSequence : attempt.nextEventSequence;
    if (records.length !== watermark - 1) {
      fail("corrupt-record", `${kind} storage count does not match its authoritative journal watermark.`);
    }
    const normalized = validateSequencedRecords(
      records,
      attempt.runId,
      1,
      kind === "samples" ? "sample" : "event",
      attempt,
    );
    validateRecordTimeline(normalized, kind === "samples" ? "sample" : "event");
    return normalized;
  };
  const samples = normalizeEntries(sampleEntries, "samples");
  const events = normalizeEntries(eventEntries, "events");
  if (attempt.manifest) {
    const gapEvents = events.filter(({ type }) => type === "timingGap");
    const missedSlots = gapEvents.reduce((sum, event) => sum + event.missedSlotCount, 0);
    if (attempt.manifest.timing.sampleCount !== samples.length
      || attempt.manifest.timing.eventCount !== events.length
      || attempt.manifest.timing.gapEventCount !== gapEvents.length
      || attempt.manifest.timing.missedSlotCount !== missedSlots) {
      fail("corrupt-record", "Terminal manifest timing totals differ from preserved journal evidence.");
    }
  }
  return attempt;
}

function interruptAttempt(attempt, reason, updatedAt) {
  if (attempt.status !== "active") return attempt;
  attempt.status = "partial";
  attempt.interruption = {
    reason,
    at: updatedAt,
    restartStimulusIndex: attempt.safeStimulusIndex,
    interruptedStimulusIndex: attempt.activeStimulusIndex,
  };
  attempt.recoverable = true;
  attempt.activeStimulusIndex = null;
  attempt.updatedAt = updatedAt;
  return attempt;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed.")), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted.")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed.")), { once: true });
  });
}

async function abort(transaction, completion, error) {
  try {
    transaction.abort();
  } catch {
    // The transaction may already be settled.
  }
  await completion.catch(() => {});
  throw error;
}

export class IndexedDbResearchJournal {
  constructor({
    indexedDB = globalThis.indexedDB,
    keyRange = globalThis.IDBKeyRange,
    databaseName = RESEARCH_JOURNAL_DATABASE,
  } = {}) {
    if (!indexedDB?.open || !keyRange?.bound) {
      fail("indexeddb-unavailable", "IndexedDB is required; Research does not fall back to volatile storage.");
    }
    this.indexedDB = indexedDB;
    this.keyRange = keyRange;
    this.databaseName = databaseName;
    this.databasePromise = null;
  }

  async open() {
    return this.#database();
  }

  async reserveAttempt(input) {
    const reservation = validateReservation(input);
    const database = await this.#database();
    const transaction = database.transaction([ATTEMPTS, LOCKS], "readwrite");
    const completion = transactionDone(transaction);
    const attempts = transaction.objectStore(ATTEMPTS);
    const locks = transaction.objectStore(LOCKS);
    const key = lockKey(reservation.experimentId, reservation.participantId, reservation.context.workspaceId);
    const [existingRun, existingLock, existingAttempts] = await Promise.all([
      requestResult(attempts.get(reservation.runId)),
      requestResult(locks.get(key)),
      requestResult(attempts.getAll()),
    ]);
    if (existingRun) return abort(transaction, completion, new ResearchJournalError(
      "attempt-exists",
      `Run ${reservation.runId} already exists.`,
    ));
    if (existingLock) return abort(transaction, completion, new ResearchJournalError(
      "participant-locked",
      `Participant ${reservation.participantId} already has an active attempt.`,
    ));
    const attemptCollision = existingAttempts.some((attempt) => (
      attempt.context?.workspaceId === reservation.context.workspaceId
      && attempt.experimentId === reservation.experimentId
      && attempt.participantId === reservation.participantId
      && (attempt.attemptNumber === reservation.attemptNumber || attempt.sessionStem === reservation.sessionStem)
    ));
    if (attemptCollision) return abort(transaction, completion, new ResearchJournalError(
      "attempt-exists",
      `Attempt ${reservation.attemptNumber} already exists for ${reservation.participantId} in this workspace.`,
    ));

    const attempt = initialAttempt(reservation);
    attempts.add(attempt);
    locks.add({ key, runId: reservation.runId, ownerId: reservation.ownerId, acquiredAt: reservation.createdAt });
    await completion;
    return immutable(attempt);
  }

  async appendBatch({
    runId,
    expectedSampleSequence,
    expectedEventSequence,
    samples = [],
    events = [],
    stimulusState = null,
    updatedAt,
  }) {
    identifier(runId, "runId");
    integer(expectedSampleSequence, "expectedSampleSequence");
    integer(expectedEventSequence, "expectedEventSequence");
    isoTimestamp(updatedAt, "updatedAt");
    const database = await this.#database();
    const transaction = database.transaction([ATTEMPTS, SAMPLES, EVENTS], "readwrite");
    const completion = transactionDone(transaction);
    const attempts = transaction.objectStore(ATTEMPTS);
    const attempt = await requestResult(attempts.get(runId));
    if (!attempt) return abort(transaction, completion, new ResearchJournalError("missing-attempt", `Run ${runId} does not exist.`));
    if (attempt.status !== "active") return abort(transaction, completion, new ResearchJournalError("attempt-final", `Run ${runId} is not active.`));
    if (attempt.nextSampleSequence !== expectedSampleSequence || attempt.nextEventSequence !== expectedEventSequence) {
      return abort(transaction, completion, new ResearchJournalError("sequence-conflict", "Journal sequence changed before the batch committed."));
    }
    const sampleStore = transaction.objectStore(SAMPLES);
    const eventStore = transaction.objectStore(EVENTS);
    const evidenceRange = this.keyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER]);
    const [previousSampleEntry, previousEventEntry, storedSampleCount, storedEventCount] = await Promise.all([
      expectedSampleSequence > 1 ? requestResult(sampleStore.get([runId, expectedSampleSequence - 1])) : null,
      expectedEventSequence > 1 ? requestResult(eventStore.get([runId, expectedEventSequence - 1])) : null,
      requestResult(sampleStore.count(evidenceRange)),
      requestResult(eventStore.count(evidenceRange)),
    ]);
    let normalizedSamples;
    let normalizedEvents;
    let normalizedStimulusState;
    try {
      if (storedSampleCount !== expectedSampleSequence - 1 || storedEventCount !== expectedEventSequence - 1) {
        fail("corrupt-record", "Journal storage count differs from its append watermark.");
      }
      normalizedSamples = validateSequencedRecords(samples, runId, expectedSampleSequence, "sample", attempt);
      normalizedEvents = validateSequencedRecords(events, runId, expectedEventSequence, "event", attempt);
      const previousSample = previousSampleEntry
        ? validateSequencedRecords([previousSampleEntry.value], runId, expectedSampleSequence - 1, "sample", attempt)[0]
        : null;
      const previousEvent = previousEventEntry
        ? validateSequencedRecords([previousEventEntry.value], runId, expectedEventSequence - 1, "event", attempt)[0]
        : null;
      validateRecordTimeline(normalizedSamples, "sample", previousSample);
      validateRecordTimeline(normalizedEvents, "event", previousEvent);
      normalizedStimulusState = validateStimulusState(stimulusState, attempt);
      if (normalizedSamples.length === 0 && normalizedEvents.length === 0 && !normalizedStimulusState) {
        fail("empty-batch", "Journal batches must contain evidence or a stimulus-state transition.");
      }
    } catch (error) {
      return abort(transaction, completion, error);
    }

    for (const sample of normalizedSamples) sampleStore.add({ runId, sequence: sample.sequence, value: sample });
    for (const event of normalizedEvents) eventStore.add({ runId, sequence: event.sequence, value: event });
    attempt.nextSampleSequence += normalizedSamples.length;
    attempt.nextEventSequence += normalizedEvents.length;
    if (normalizedStimulusState) {
      attempt.activeStimulusIndex = normalizedStimulusState.activeStimulusIndex;
      attempt.safeStimulusIndex = normalizedStimulusState.safeStimulusIndex;
    }
    attempt.updatedAt = updatedAt;
    attempts.put(attempt);
    await completion;
    return immutable(attempt);
  }

  async setStimulusState({ runId, activeStimulusIndex, safeStimulusIndex, updatedAt }) {
    identifier(runId, "runId");
    isoTimestamp(updatedAt, "updatedAt");
    return this.#mutateAttempt(runId, (attempt) => {
      if (attempt.status !== "active") fail("attempt-final", "Only active attempts can change stimulus state.");
      const state = validateStimulusState({ activeStimulusIndex, safeStimulusIndex }, attempt);
      attempt.activeStimulusIndex = state.activeStimulusIndex;
      attempt.safeStimulusIndex = state.safeStimulusIndex;
      attempt.updatedAt = updatedAt;
    });
  }

  async markInterrupted({ runId, reason, updatedAt }) {
    identifier(runId, "runId");
    identifier(reason, "interruption reason");
    isoTimestamp(updatedAt, "updatedAt");
    const database = await this.#database();
    const transaction = database.transaction([ATTEMPTS, LOCKS], "readwrite");
    const completion = transactionDone(transaction);
    const attempts = transaction.objectStore(ATTEMPTS);
    const attempt = await requestResult(attempts.get(runId));
    if (!attempt) return abort(transaction, completion, new ResearchJournalError("missing-attempt", `Run ${runId} does not exist.`));
    if (attempt.status !== "active") return immutable(attempt);
    interruptAttempt(attempt, reason, updatedAt);
    attempts.put(attempt);
    transaction.objectStore(LOCKS).delete(lockKey(attempt.experimentId, attempt.participantId, attempt.context.workspaceId));
    await completion;
    return immutable(attempt);
  }

  async reconcileAbandonedAttempts({ reason = "exclusive-runtime-recovery", updatedAt }) {
    identifier(reason, "interruption reason");
    isoTimestamp(updatedAt, "updatedAt");
    await this.auditAndQuarantine({ quarantinedAt: updatedAt });
    const database = await this.#database();
    const transaction = database.transaction([ATTEMPTS, LOCKS], "readwrite");
    const completion = transactionDone(transaction);
    const attempts = transaction.objectStore(ATTEMPTS);
    const locks = transaction.objectStore(LOCKS);
    const values = await requestResult(attempts.getAll());
    const changed = [];
    for (const attempt of values) {
      if (attempt.status !== "active") continue;
      interruptAttempt(attempt, reason, updatedAt);
      attempts.put(attempt);
      locks.delete(lockKey(attempt.experimentId, attempt.participantId, attempt.context.workspaceId));
      changed.push(immutable(attempt));
    }
    await completion;
    return Object.freeze(changed);
  }

  async prepareFinalization({ runId, completionStatus, finalizedAt, recovery }) {
    identifier(runId, "runId");
    const descriptor = clone(validatePendingFinalization({ completionStatus, finalizedAt, recovery }));
    return this.#mutateAttempt(runId, (attempt) => {
      if (attempt.status !== "active") fail("attempt-final", "Only active attempts can prepare finalization.");
      const assignment = assignmentFromContext(attempt.context, attempt.participantId);
      if (descriptor.completionStatus === "completed" && assignment
        && attempt.safeStimulusIndex !== assignment.slots.length) {
        fail("unsafe-recovery", "A completed finalization requires the final safe stimulus boundary.");
      }
      if (attempt.pendingFinalization !== null
        && JSON.stringify(attempt.pendingFinalization) !== JSON.stringify(descriptor)) {
        fail("finalization-conflict", "Prepared finalization metadata cannot change across retries.");
      }
      attempt.pendingFinalization = descriptor;
      attempt.updatedAt = descriptor.finalizedAt;
    });
  }

  async finalize({ runId, status, manifest, finalizedAt }) {
    identifier(runId, "runId");
    if (!TERMINAL_STATUSES.has(status)) fail("invalid-record", "Final status must be partial or complete.");
    isoTimestamp(finalizedAt, "finalizedAt");
    const database = await this.#database();
    const transaction = database.transaction([ATTEMPTS, LOCKS, SAMPLES, EVENTS], "readwrite");
    const completion = transactionDone(transaction);
    const attempts = transaction.objectStore(ATTEMPTS);
    const attempt = await requestResult(attempts.get(runId));
    if (!attempt) return abort(transaction, completion, new ResearchJournalError("missing-attempt", `Run ${runId} does not exist.`));
    if (attempt.status !== "active") return abort(transaction, completion, new ResearchJournalError("attempt-final", `Run ${runId} is already terminal.`));
    const range = this.keyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER]);
    const [sampleCount, eventCount] = await Promise.all([
      requestResult(transaction.objectStore(SAMPLES).count(range)),
      requestResult(transaction.objectStore(EVENTS).count(range)),
    ]);
    let normalizedManifest;
    try {
      normalizedManifest = validateManifestForAttempt(manifest, attempt);
      if ((status === "complete") !== (normalizedManifest.completionStatus === "completed")) {
        fail("finalization-conflict", "Journal terminal status differs from the run manifest completion status.");
      }
      if (sampleCount !== attempt.nextSampleSequence - 1
        || eventCount !== attempt.nextEventSequence - 1
        || normalizedManifest.timing.sampleCount !== sampleCount
        || normalizedManifest.timing.eventCount !== eventCount) {
        fail("corrupt-record", "Final manifest counts do not match journal watermarks and stored evidence.");
      }
      const descriptor = attempt.pendingFinalization ?? {
        completionStatus: normalizedManifest.completionStatus,
        finalizedAt: normalizedManifest.timing.finalizedAt,
        recovery: normalizedManifest.recovery,
      };
      validatePendingFinalization(descriptor);
      if (descriptor.completionStatus !== normalizedManifest.completionStatus
        || descriptor.finalizedAt !== normalizedManifest.timing.finalizedAt
        || JSON.stringify(descriptor.recovery) !== JSON.stringify(normalizedManifest.recovery)) {
        fail("finalization-conflict", "Manifest differs from its prepared finalization metadata.");
      }
      attempt.pendingFinalization = clone(descriptor);
    } catch (error) {
      return abort(transaction, completion, error);
    }
    attempt.status = status;
    attempt.updatedAt = finalizedAt;
    attempt.finalizedAt = finalizedAt;
    attempt.activeStimulusIndex = null;
    attempt.manifest = clone(normalizedManifest);
    attempt.recoverable = false;
    attempts.put(attempt);
    transaction.objectStore(LOCKS).delete(lockKey(attempt.experimentId, attempt.participantId, attempt.context.workspaceId));
    await completion;
    return immutable(attempt);
  }

  async resumeAttempt({ runId, ownerId, resumedAt }) {
    identifier(runId, "runId");
    identifier(ownerId, "ownerId");
    isoTimestamp(resumedAt, "resumedAt");
    const database = await this.#database();
    const transaction = database.transaction([ATTEMPTS, LOCKS], "readwrite");
    const completion = transactionDone(transaction);
    const attempts = transaction.objectStore(ATTEMPTS);
    const locks = transaction.objectStore(LOCKS);
    const attempt = await requestResult(attempts.get(runId));
    if (!attempt) return abort(transaction, completion, new ResearchJournalError("missing-attempt", `Run ${runId} does not exist.`));
    if (attempt.status !== "partial" || !attempt.recoverable) {
      return abort(transaction, completion, new ResearchJournalError("not-recoverable", `Run ${runId} is not recoverable.`));
    }
    const key = lockKey(attempt.experimentId, attempt.participantId, attempt.context.workspaceId);
    if (await requestResult(locks.get(key))) {
      return abort(transaction, completion, new ResearchJournalError("participant-locked", `Participant ${attempt.participantId} already has an active attempt.`));
    }
    attempt.status = "active";
    attempt.recoverable = false;
    attempt.ownerId = ownerId;
    attempt.updatedAt = resumedAt;
    attempt.activeStimulusIndex = null;
    const interruptedIndex = attempt.interruption?.interruptedStimulusIndex;
    if (attempt.pendingFinalization === null) {
      const assignment = assignmentFromContext(attempt.context, attempt.participantId);
      attempt.context.resumed = true;
      attempt.context.sourceRunId = runId;
      attempt.context.restartedStimulusIds = Number.isSafeInteger(interruptedIndex) && assignment
        ? [assignment.slots[interruptedIndex]?.stimulusId].filter(Boolean)
        : [];
    }
    attempts.put(attempt);
    locks.add({ key, runId, ownerId, acquiredAt: resumedAt });
    await completion;
    return immutable(attempt);
  }

  async getAttempt(runId) {
    identifier(runId, "runId");
    await this.auditAndQuarantine();
    const database = await this.#database();
    const transaction = database.transaction([ATTEMPTS], "readonly");
    const completion = transactionDone(transaction);
    const value = await requestResult(transaction.objectStore(ATTEMPTS).get(runId));
    await completion;
    return value ? immutable(value) : undefined;
  }

  async readRecords(runId, { kind, fromSequence = 0, limit = 10_000 } = {}) {
    identifier(runId, "runId");
    const storeName = kind === "samples" ? SAMPLES : kind === "events" ? EVENTS : null;
    if (!storeName) fail("invalid-record", "Record kind must be samples or events.");
    integer(fromSequence, "fromSequence");
    integer(limit, "limit", 1);
    const database = await this.#database();
    const transaction = database.transaction([ATTEMPTS, storeName], "readonly");
    const completion = transactionDone(transaction);
    const store = transaction.objectStore(storeName);
    const startSequence = Math.max(1, fromSequence);
    const range = this.keyRange.bound([runId, startSequence], [runId, Number.MAX_SAFE_INTEGER]);
    const allRange = this.keyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER]);
    const [attempt, values, totalCount, previousEntry] = await Promise.all([
      requestResult(transaction.objectStore(ATTEMPTS).get(runId)),
      requestResult(store.getAll(range, limit)),
      requestResult(store.count(allRange)),
      startSequence > 1 ? requestResult(store.get([runId, startSequence - 1])) : null,
    ]);
    await completion;
    if (!attempt) fail("missing-attempt", `Run ${runId} does not exist.`);
    validateStoredAttempt(attempt);
    const watermark = kind === "samples" ? attempt.nextSampleSequence : attempt.nextEventSequence;
    const expectedTotal = watermark - 1;
    const expectedPageLength = Math.min(limit, Math.max(0, watermark - startSequence));
    if (totalCount !== expectedTotal || values.length !== expectedPageLength) {
      fail("corrupt-record", `${kind} storage count does not match its authoritative journal watermark.`);
    }
    let expectedSequence = startSequence;
    const normalized = values.map((entry, index) => {
      if (entry.sequence !== entry.value?.sequence || entry.runId !== runId) {
        fail("corrupt-record", `${kind}[${index}] has a corrupt storage key.`);
      }
      if (entry.sequence !== expectedSequence) {
        fail("corrupt-record", `${kind}[${index}] reveals a silent journal sequence gap.`);
      }
      expectedSequence += 1;
      return validateSequencedRecords(
        [entry.value],
        runId,
        entry.sequence,
        kind === "samples" ? "sample" : "event",
        attempt,
      )[0];
    });
    const previous = previousEntry
      ? validateSequencedRecords(
        [previousEntry.value],
        runId,
        startSequence - 1,
        kind === "samples" ? "sample" : "event",
        attempt,
      )[0]
      : null;
    validateRecordTimeline(normalized, kind === "samples" ? "sample" : "event", previous);
    return Object.freeze(normalized.map(immutable));
  }

  async listAttempts({ experimentId } = {}) {
    await this.auditAndQuarantine();
    const database = await this.#database();
    const transaction = database.transaction([ATTEMPTS], "readonly");
    const completion = transactionDone(transaction);
    const store = transaction.objectStore(ATTEMPTS);
    const values = experimentId
      ? await requestResult(store.index("experimentId").getAll(identifier(experimentId, "experimentId")))
      : await requestResult(store.getAll());
    await completion;
    return Object.freeze(values.map(immutable));
  }

  async auditAndQuarantine({ quarantinedAt = new Date().toISOString() } = {}) {
    isoTimestamp(quarantinedAt, "quarantinedAt");
    const database = await this.#database();
    const transaction = database.transaction(
      [ATTEMPTS, SAMPLES, EVENTS, LOCKS, QUARANTINE],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    const attempts = transaction.objectStore(ATTEMPTS);
    const samples = transaction.objectStore(SAMPLES);
    const events = transaction.objectStore(EVENTS);
    const locks = transaction.objectStore(LOCKS);
    const quarantine = transaction.objectStore(QUARANTINE);
    const [values, lockValues, sampleValues, eventValues] = await Promise.all([
      requestResult(attempts.getAll()),
      requestResult(locks.getAll()),
      requestResult(samples.getAll()),
      requestResult(events.getAll()),
    ]);
    const groupByRun = (entries) => {
      const grouped = new Map();
      for (const entry of entries) {
        const key = typeof entry?.runId === "string" ? entry.runId : "<invalid-run-id>";
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(entry);
      }
      return grouped;
    };
    const samplesByRun = groupByRun(sampleValues);
    const eventsByRun = groupByRun(eventValues);
    const issues = [];
    for (const raw of values) {
      try {
        validateStoredEvidence(
          raw,
          samplesByRun.get(raw?.runId) ?? [],
          eventsByRun.get(raw?.runId) ?? [],
        );
      } catch (error) {
        const runId = typeof raw?.runId === "string" ? raw.runId : null;
        const issue = Object.freeze({
          recordType: "attempt",
          runId,
          reasonCode: error?.code ?? "corrupt-attempt",
          reason: error instanceof Error ? error.message : String(error),
          quarantinedAt,
        });
        const rawSamples = samplesByRun.get(raw?.runId) ?? [];
        const rawEvents = eventsByRun.get(raw?.runId) ?? [];
        quarantine.add({
          ...issue,
          raw: clone(raw),
          evidence: {
            attempt: clone(raw),
            samples: clone(rawSamples),
            events: clone(rawEvents),
          },
        });
        attempts.delete(raw?.runId);
        for (const lock of lockValues) {
          if (lock?.runId === raw?.runId) locks.delete(lock.key);
        }
        for (const entry of rawSamples) samples.delete([entry.runId, entry.sequence]);
        for (const entry of rawEvents) events.delete([entry.runId, entry.sequence]);
        issues.push(issue);
      }
    }
    const attemptRunIds = new Set(values.map((raw) => raw?.runId).filter((runId) => typeof runId === "string"));
    const evidenceRunIds = new Set([...samplesByRun.keys(), ...eventsByRun.keys()]);
    for (const orphanRunId of evidenceRunIds) {
      if (attemptRunIds.has(orphanRunId)) continue;
      const rawSamples = samplesByRun.get(orphanRunId) ?? [];
      const rawEvents = eventsByRun.get(orphanRunId) ?? [];
      const issue = Object.freeze({
        recordType: "evidence",
        runId: orphanRunId === "<invalid-run-id>" ? null : orphanRunId,
        reasonCode: "orphan-evidence",
        reason: "Sample or event evidence has no attempt header.",
        quarantinedAt,
      });
      quarantine.add({
        ...issue,
        raw: null,
        evidence: { attempt: null, samples: clone(rawSamples), events: clone(rawEvents) },
      });
      for (const entry of rawSamples) samples.delete([entry.runId, entry.sequence]);
      for (const entry of rawEvents) events.delete([entry.runId, entry.sequence]);
      issues.push(issue);
    }
    await completion;
    return Object.freeze(issues);
  }

  async listQuarantinedRecords() {
    const database = await this.#database();
    const transaction = database.transaction([QUARANTINE], "readonly");
    const completion = transactionDone(transaction);
    const values = await requestResult(transaction.objectStore(QUARANTINE).getAll());
    await completion;
    return Object.freeze(values.map(immutable));
  }

  async participantStates(experimentId, participantIds, { workspaceId } = {}) {
    const listed = await this.listAttempts({ experimentId });
    const attempts = workspaceId === undefined
      ? listed
      : listed.filter((attempt) => attempt.context?.workspaceId === workspaceId);
    const database = await this.#database();
    const transaction = database.transaction([LOCKS], "readonly");
    const completion = transactionDone(transaction);
    const locks = await requestResult(transaction.objectStore(LOCKS).getAll());
    await completion;
    const locked = new Set(locks.map((entry) => entry.key));
    return Object.freeze(participantIds.map((participantId) => {
      identifier(participantId, "participantId");
      const own = attempts.filter((attempt) => attempt.participantId === participantId);
      let state = "Available";
      const participantSuffix = `::${experimentId}::${participantId}`;
      const isLocked = workspaceId === undefined
        ? [...locked].some((key) => key.endsWith(participantSuffix))
        : locked.has(lockKey(experimentId, participantId, workspaceId));
      if (isLocked) state = "Active";
      else if (own.some((attempt) => attempt.status === "partial")) state = "Partial";
      else if (own.some((attempt) => attempt.status === "complete")) state = "Complete";
      return Object.freeze({ participantId, state, attempts: own.length });
    }));
  }

  async close() {
    if (!this.databasePromise) return;
    const database = await this.databasePromise;
    database.close();
    this.databasePromise = null;
  }

  async #mutateAttempt(runId, mutate) {
    const database = await this.#database();
    const transaction = database.transaction([ATTEMPTS], "readwrite");
    const completion = transactionDone(transaction);
    const store = transaction.objectStore(ATTEMPTS);
    const attempt = await requestResult(store.get(runId));
    if (!attempt) return abort(transaction, completion, new ResearchJournalError("missing-attempt", `Run ${runId} does not exist.`));
    try {
      mutate(attempt);
    } catch (error) {
      return abort(transaction, completion, error);
    }
    store.put(attempt);
    await completion;
    return immutable(attempt);
  }

  #database() {
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        const request = this.indexedDB.open(this.databaseName, RESEARCH_JOURNAL_VERSION);
        request.addEventListener("upgradeneeded", () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(ATTEMPTS)) {
            const attempts = database.createObjectStore(ATTEMPTS, { keyPath: "runId" });
            attempts.createIndex("experimentId", "experimentId", { unique: false });
          }
          if (!database.objectStoreNames.contains(SAMPLES)) {
            database.createObjectStore(SAMPLES, { keyPath: ["runId", "sequence"] });
          }
          if (!database.objectStoreNames.contains(EVENTS)) {
            database.createObjectStore(EVENTS, { keyPath: ["runId", "sequence"] });
          }
          if (!database.objectStoreNames.contains(LOCKS)) {
            database.createObjectStore(LOCKS, { keyPath: "key" });
          }
          if (!database.objectStoreNames.contains(QUARANTINE)) {
            database.createObjectStore(QUARANTINE, { autoIncrement: true });
          }
        });
        request.addEventListener("blocked", () => reject(new ResearchJournalError(
          "indexeddb-blocked",
          "Close other Affect Research tabs so the journal can open.",
        )), { once: true });
        request.addEventListener("error", () => reject(request.error ?? new ResearchJournalError(
          "indexeddb-open",
          "The Research journal could not be opened.",
        )), { once: true });
        request.addEventListener("success", () => {
          request.result.addEventListener("versionchange", () => request.result.close());
          resolve(request.result);
        }, { once: true });
      }).catch((error) => {
        this.databasePromise = null;
        throw error;
      });
    }
    return this.databasePromise;
  }
}

// Explicit test/harness backend. Production construction never selects this
// when IndexedDB is missing.
export class MemoryResearchJournal {
  constructor() {
    this.attempts = new Map();
    this.samples = new Map();
    this.events = new Map();
    this.locks = new Map();
    this.quarantine = [];
  }

  async open() { return this; }

  async reserveAttempt(input) {
    const reservation = validateReservation(input);
    const key = lockKey(reservation.experimentId, reservation.participantId, reservation.context.workspaceId);
    if (this.attempts.has(reservation.runId)) fail("attempt-exists", `Run ${reservation.runId} already exists.`);
    if (this.locks.has(key)) fail("participant-locked", `Participant ${reservation.participantId} already has an active attempt.`);
    if ([...this.attempts.values()].some((attempt) => (
      attempt.context?.workspaceId === reservation.context.workspaceId
      && attempt.experimentId === reservation.experimentId
      && attempt.participantId === reservation.participantId
      && (attempt.attemptNumber === reservation.attemptNumber || attempt.sessionStem === reservation.sessionStem)
    ))) {
      fail("attempt-exists", `Attempt ${reservation.attemptNumber} already exists for ${reservation.participantId} in this workspace.`);
    }
    const attempt = initialAttempt(reservation);
    this.attempts.set(attempt.runId, clone(attempt));
    this.samples.set(attempt.runId, []);
    this.events.set(attempt.runId, []);
    this.locks.set(key, { runId: attempt.runId, ownerId: attempt.ownerId });
    return immutable(attempt);
  }

  async appendBatch(input) {
    const attempt = this.#active(input.runId);
    if (attempt.nextSampleSequence !== input.expectedSampleSequence
      || attempt.nextEventSequence !== input.expectedEventSequence) {
      fail("sequence-conflict", "Journal sequence changed before the batch committed.");
    }
    if ((this.samples.get(input.runId) ?? []).length !== input.expectedSampleSequence - 1
      || (this.events.get(input.runId) ?? []).length !== input.expectedEventSequence - 1) {
      fail("corrupt-record", "Journal storage count differs from its append watermark.");
    }
    const samples = validateSequencedRecords(input.samples ?? [], input.runId, input.expectedSampleSequence, "sample", attempt);
    const events = validateSequencedRecords(input.events ?? [], input.runId, input.expectedEventSequence, "event", attempt);
    const previousSample = this.samples.get(input.runId).at(-1) ?? null;
    const previousEvent = this.events.get(input.runId).at(-1) ?? null;
    if (previousSample) validateSequencedRecords([previousSample], input.runId, input.expectedSampleSequence - 1, "sample", attempt);
    if (previousEvent) validateSequencedRecords([previousEvent], input.runId, input.expectedEventSequence - 1, "event", attempt);
    validateRecordTimeline(samples, "sample", previousSample);
    validateRecordTimeline(events, "event", previousEvent);
    const stimulusState = validateStimulusState(input.stimulusState ?? null, attempt);
    if (samples.length === 0 && events.length === 0 && !stimulusState) fail("empty-batch", "Journal batches must not be empty.");
    this.samples.get(input.runId).push(...samples);
    this.events.get(input.runId).push(...events);
    attempt.nextSampleSequence += samples.length;
    attempt.nextEventSequence += events.length;
    if (stimulusState) {
      attempt.activeStimulusIndex = stimulusState.activeStimulusIndex;
      attempt.safeStimulusIndex = stimulusState.safeStimulusIndex;
    }
    attempt.updatedAt = isoTimestamp(input.updatedAt, "updatedAt");
    return immutable(attempt);
  }

  async setStimulusState({ runId, activeStimulusIndex, safeStimulusIndex, updatedAt }) {
    const attempt = this.#active(runId);
    const state = validateStimulusState({ activeStimulusIndex, safeStimulusIndex }, attempt);
    attempt.activeStimulusIndex = state.activeStimulusIndex;
    attempt.safeStimulusIndex = state.safeStimulusIndex;
    attempt.updatedAt = isoTimestamp(updatedAt, "updatedAt");
    return immutable(attempt);
  }

  async markInterrupted({ runId, reason, updatedAt }) {
    const attempt = this.#attempt(runId);
    if (attempt.status !== "active") return immutable(attempt);
    interruptAttempt(
      attempt,
      identifier(reason, "interruption reason"),
      isoTimestamp(updatedAt, "updatedAt"),
    );
    this.locks.delete(lockKey(attempt.experimentId, attempt.participantId, attempt.context.workspaceId));
    return immutable(attempt);
  }

  async reconcileAbandonedAttempts({ reason = "exclusive-runtime-recovery", updatedAt }) {
    reason = identifier(reason, "interruption reason");
    updatedAt = isoTimestamp(updatedAt, "updatedAt");
    await this.auditAndQuarantine({ quarantinedAt: updatedAt });
    const changed = [];
    for (const attempt of this.attempts.values()) {
      if (attempt.status !== "active") continue;
      interruptAttempt(attempt, reason, updatedAt);
      this.locks.delete(lockKey(attempt.experimentId, attempt.participantId, attempt.context.workspaceId));
      changed.push(immutable(attempt));
    }
    return Object.freeze(changed);
  }

  async prepareFinalization({ runId, completionStatus, finalizedAt, recovery }) {
    const attempt = this.#active(runId);
    const descriptor = clone(validatePendingFinalization({ completionStatus, finalizedAt, recovery }));
    const assignment = assignmentFromContext(attempt.context, attempt.participantId);
    if (descriptor.completionStatus === "completed" && assignment
      && attempt.safeStimulusIndex !== assignment.slots.length) {
      fail("unsafe-recovery", "A completed finalization requires the final safe stimulus boundary.");
    }
    if (attempt.pendingFinalization !== null
      && JSON.stringify(attempt.pendingFinalization) !== JSON.stringify(descriptor)) {
      fail("finalization-conflict", "Prepared finalization metadata cannot change across retries.");
    }
    attempt.pendingFinalization = descriptor;
    attempt.updatedAt = descriptor.finalizedAt;
    return immutable(attempt);
  }

  async finalize({ runId, status, manifest, finalizedAt }) {
    const attempt = this.#active(runId);
    if (!TERMINAL_STATUSES.has(status)) fail("invalid-record", "Final status must be partial or complete.");
    const normalizedManifest = validateManifestForAttempt(manifest, attempt);
    if ((status === "complete") !== (normalizedManifest.completionStatus === "completed")) {
      fail("finalization-conflict", "Journal terminal status differs from the run manifest completion status.");
    }
    const samples = this.samples.get(runId) ?? [];
    const events = this.events.get(runId) ?? [];
    if (samples.length !== attempt.nextSampleSequence - 1
      || events.length !== attempt.nextEventSequence - 1
      || normalizedManifest.timing.sampleCount !== samples.length
      || normalizedManifest.timing.eventCount !== events.length) {
      fail("corrupt-record", "Final manifest counts do not match journal watermarks and stored evidence.");
    }
    const descriptor = attempt.pendingFinalization ?? {
      completionStatus: normalizedManifest.completionStatus,
      finalizedAt: normalizedManifest.timing.finalizedAt,
      recovery: normalizedManifest.recovery,
    };
    validatePendingFinalization(descriptor);
    if (descriptor.completionStatus !== normalizedManifest.completionStatus
      || descriptor.finalizedAt !== normalizedManifest.timing.finalizedAt
      || JSON.stringify(descriptor.recovery) !== JSON.stringify(normalizedManifest.recovery)) {
      fail("finalization-conflict", "Manifest differs from its prepared finalization metadata.");
    }
    attempt.pendingFinalization = clone(descriptor);
    attempt.status = status;
    attempt.finalizedAt = isoTimestamp(finalizedAt, "finalizedAt");
    attempt.updatedAt = finalizedAt;
    attempt.activeStimulusIndex = null;
    attempt.manifest = clone(normalizedManifest);
    attempt.recoverable = false;
    this.locks.delete(lockKey(attempt.experimentId, attempt.participantId, attempt.context.workspaceId));
    return immutable(attempt);
  }

  async resumeAttempt({ runId, ownerId, resumedAt }) {
    const attempt = this.#attempt(runId);
    if (attempt.status !== "partial" || !attempt.recoverable) {
      fail("not-recoverable", `Run ${runId} is not recoverable.`);
    }
    const key = lockKey(attempt.experimentId, attempt.participantId, attempt.context.workspaceId);
    if (this.locks.has(key)) fail("participant-locked", `Participant ${attempt.participantId} already has an active attempt.`);
    attempt.status = "active";
    attempt.recoverable = false;
    attempt.ownerId = identifier(ownerId, "ownerId");
    attempt.updatedAt = isoTimestamp(resumedAt, "resumedAt");
    attempt.activeStimulusIndex = null;
    const interruptedIndex = attempt.interruption?.interruptedStimulusIndex;
    if (attempt.pendingFinalization === null) {
      const assignment = assignmentFromContext(attempt.context, attempt.participantId);
      attempt.context.resumed = true;
      attempt.context.sourceRunId = runId;
      attempt.context.restartedStimulusIds = Number.isSafeInteger(interruptedIndex) && assignment
        ? [assignment.slots[interruptedIndex]?.stimulusId].filter(Boolean)
        : [];
    }
    this.locks.set(key, { runId, ownerId: attempt.ownerId });
    return immutable(attempt);
  }

  async getAttempt(runId) {
    await this.auditAndQuarantine();
    const attempt = this.attempts.get(identifier(runId, "runId"));
    return attempt ? immutable(attempt) : undefined;
  }

  async readRecords(runId, { kind, fromSequence = 0, limit = 10_000 } = {}) {
    const source = kind === "samples" ? this.samples : kind === "events" ? this.events : null;
    if (!source) fail("invalid-record", "Record kind must be samples or events.");
    integer(fromSequence, "fromSequence");
    integer(limit, "limit", 1);
    const attempt = this.#attempt(identifier(runId, "runId"));
    validateStoredAttempt(attempt);
    const all = source.get(runId) ?? [];
    const watermark = kind === "samples" ? attempt.nextSampleSequence : attempt.nextEventSequence;
    if (all.length !== watermark - 1) {
      fail("corrupt-record", `${kind} storage count does not match its authoritative journal watermark.`);
    }
    const startSequence = Math.max(1, fromSequence);
    const values = all
      .filter((record) => record.sequence >= startSequence)
      .slice(0, limit);
    const expectedPageLength = Math.min(limit, Math.max(0, watermark - startSequence));
    if (values.length !== expectedPageLength) {
      fail("corrupt-record", `${kind} page does not reach its authoritative journal watermark.`);
    }
    let expectedSequence = startSequence;
    const normalized = values.map((record, index) => {
      if (record.sequence !== expectedSequence) {
        fail("corrupt-record", `${kind}[${index}] reveals a silent journal sequence gap.`);
      }
      expectedSequence += 1;
      return validateSequencedRecords(
        [record],
        runId,
        record.sequence,
        kind === "samples" ? "sample" : "event",
        attempt,
      )[0];
    });
    const previous = startSequence > 1 ? all[startSequence - 2] ?? null : null;
    if (previous && previous.sequence !== startSequence - 1) {
      fail("corrupt-record", `${kind} predecessor does not match the requested page.`);
    }
    validateRecordTimeline(normalized, kind === "samples" ? "sample" : "event", previous);
    return Object.freeze(normalized.map(immutable));
  }

  async listAttempts({ experimentId } = {}) {
    if (experimentId !== undefined) identifier(experimentId, "experimentId");
    await this.auditAndQuarantine();
    return Object.freeze([...this.attempts.values()]
      .filter((attempt) => experimentId === undefined || attempt.experimentId === experimentId)
      .map(immutable));
  }

  async auditAndQuarantine({ quarantinedAt = new Date().toISOString() } = {}) {
    isoTimestamp(quarantinedAt, "quarantinedAt");
    const issues = [];
    for (const [storedKey, raw] of this.attempts.entries()) {
      try {
        validateStoredEvidence(
          raw,
          (this.samples.get(storedKey) ?? []).map((value) => ({ runId: storedKey, sequence: value.sequence, value })),
          (this.events.get(storedKey) ?? []).map((value) => ({ runId: storedKey, sequence: value.sequence, value })),
        );
      } catch (error) {
        const runId = typeof raw?.runId === "string" ? raw.runId : null;
        const issue = Object.freeze({
          recordType: "attempt",
          runId,
          reasonCode: error?.code ?? "corrupt-attempt",
          reason: error instanceof Error ? error.message : String(error),
          quarantinedAt,
        });
        this.quarantine.push({
          ...issue,
          raw: clone(raw),
          evidence: {
            attempt: clone(raw),
            samples: clone(this.samples.get(storedKey) ?? []),
            events: clone(this.events.get(storedKey) ?? []),
          },
        });
        this.attempts.delete(storedKey);
        this.samples.delete(storedKey);
        this.events.delete(storedKey);
        for (const [key, lock] of this.locks.entries()) {
          if (lock?.runId === storedKey || lock?.runId === raw?.runId) this.locks.delete(key);
        }
        issues.push(issue);
      }
    }
    return Object.freeze(issues);
  }

  async listQuarantinedRecords() {
    return Object.freeze(this.quarantine.map(immutable));
  }

  async participantStates(experimentId, participantIds, { workspaceId } = {}) {
    identifier(experimentId, "experimentId");
    const listed = await this.listAttempts({ experimentId });
    const attempts = workspaceId === undefined
      ? listed
      : listed.filter((attempt) => attempt.context?.workspaceId === workspaceId);
    return Object.freeze(participantIds.map((participantId) => {
      const key = lockKey(experimentId, participantId, workspaceId);
      const own = attempts.filter((attempt) => attempt.participantId === participantId);
      let state = "Available";
      const participantSuffix = `::${experimentId}::${participantId}`;
      const isLocked = workspaceId === undefined
        ? [...this.locks.keys()].some((candidate) => candidate.endsWith(participantSuffix))
        : this.locks.has(key);
      if (isLocked) state = "Active";
      else if (own.some((attempt) => attempt.status === "partial")) state = "Partial";
      else if (own.some((attempt) => attempt.status === "complete")) state = "Complete";
      return Object.freeze({ participantId, state, attempts: own.length });
    }));
  }

  async close() {}

  #attempt(runId) {
    const attempt = this.attempts.get(identifier(runId, "runId"));
    if (!attempt) fail("missing-attempt", `Run ${runId} does not exist.`);
    return attempt;
  }

  #active(runId) {
    const attempt = this.#attempt(runId);
    if (attempt.status !== "active") fail("attempt-final", `Run ${runId} is not active.`);
    return attempt;
  }
}
