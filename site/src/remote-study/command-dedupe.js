import { validateStudyCommand } from "./contracts.js";
import {
  assertBoundedJson,
  assertSafeInteger,
  canonicalStringify,
  cloneBoundedJson,
  failContract,
  utf8ByteLength,
} from "./values.js";

export const COMMAND_DEDUPE_MAX_ENTRIES = 512;
export const COMMAND_DEDUPE_TTL_MS = 30 * 60 * 1000;
export const COMMAND_OUTCOME_MAX_BYTES = 16 * 1024;

function namespace(command) {
  return `${command.authorityGeneration}\u001f${command.principalId}\u001f${command.commandId}`;
}

function logicalFingerprint(command) {
  return canonicalStringify({
    authorityGeneration: command.authorityGeneration,
    principalId: command.principalId,
    commandId: command.commandId,
    expectedRevision: command.expectedRevision,
    runId: command.runId,
    precondition: command.precondition,
    scope: command.scope,
    action: command.action,
    payload: command.payload,
  });
}

function normalizeOutcome(value) {
  assertBoundedJson(value, { name: "command outcome" });
  const copy = cloneBoundedJson(value, { name: "command outcome" });
  if (utf8ByteLength(JSON.stringify(copy)) > COMMAND_OUTCOME_MAX_BYTES) {
    failContract("outcome_too_large", "The command outcome exceeds its byte limit.");
  }
  return copy;
}

export class CommandDedupeCache {
  constructor({
    maximumEntries = COMMAND_DEDUPE_MAX_ENTRIES,
    ttlMs = COMMAND_DEDUPE_TTL_MS,
    now = () => Date.now(),
  } = {}) {
    assertSafeInteger(maximumEntries, "maximumEntries", { minimum: 1, maximum: 10_000 });
    assertSafeInteger(ttlMs, "ttlMs", { minimum: 1, maximum: 24 * 60 * 60 * 1000 });
    if (typeof now !== "function") failContract("invalid_configuration", "now must be a function.");
    this.maximumEntries = maximumEntries;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  prune(nowMs = this.now()) {
    assertSafeInteger(nowMs, "nowMs");
    for (const [key, entry] of this.entries) {
      if (entry.status === "complete" && nowMs >= entry.expiresAtMs) this.entries.delete(key);
    }
  }

  makeRoom() {
    if (this.entries.size < this.maximumEntries) return;
    for (const [key, entry] of this.entries) {
      if (entry.status === "complete") {
        this.entries.delete(key);
        return;
      }
    }
    failContract("dedupe_capacity", "The command dedupe window is full.");
  }

  async execute(commandValue, apply, nowMs = this.now()) {
    if (typeof apply !== "function") failContract("invalid_apply", "apply must be a function.");
    assertSafeInteger(nowMs, "nowMs");
    const command = validateStudyCommand(commandValue);
    const key = namespace(command);
    const fingerprint = logicalFingerprint(command);
    this.prune(nowMs);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        failContract("command_id_conflict", "The command ID was reused with a different logical body.");
      }
      const outcome = await existing.promise;
      return Object.freeze({ duplicate: true, outcome: cloneBoundedJson(outcome) });
    }

    this.makeRoom();
    const entry = {
      fingerprint,
      status: "pending",
      expiresAtMs: nowMs + this.ttlMs,
      promise: undefined,
    };
    entry.promise = Promise.resolve()
      .then(() => apply(command))
      .then((outcome) => {
        const normalized = normalizeOutcome(outcome);
        entry.status = "complete";
        entry.expiresAtMs = this.now() + this.ttlMs;
        return normalized;
      })
      .catch((error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      });
    this.entries.set(key, entry);
    const outcome = await entry.promise;
    return Object.freeze({ duplicate: false, outcome: cloneBoundedJson(outcome) });
  }

  clearAuthorityGeneration(authorityGeneration) {
    assertSafeInteger(authorityGeneration, "authorityGeneration", { minimum: 1 });
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${authorityGeneration}\u001f`)) this.entries.delete(key);
    }
  }

  clear() {
    this.entries.clear();
  }

  snapshot(nowMs = this.now()) {
    this.prune(nowMs);
    let pending = 0;
    for (const entry of this.entries.values()) if (entry.status === "pending") pending += 1;
    return Object.freeze({ entries: this.entries.size, pending, maximumEntries: this.maximumEntries });
  }
}
