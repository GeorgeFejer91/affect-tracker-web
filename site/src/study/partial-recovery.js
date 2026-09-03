import { eventsToLongCsv, sha256TextHex } from "./participant-runner.js";
import {
  FINALIZED_RUN_EXPORT_PROTOCOL,
  PARTIAL_RUN_EXPORT_PROTOCOL,
  StudyRunJournal,
} from "./run-journal.js";
import { WebLockRunOwnership } from "./run-ownership.js";
import {
  StudyStorageConflictError,
  StudyStorageStateError,
} from "./storage-common.js";

function cloneJson(value) {
  return globalThis.structuredClone
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function safeFilePart(value) {
  return String(value ?? "run")
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "run";
}

function recoveryCloneOptions(value) {
  const eventCount = Array.isArray(value?.events) ? value.events.length : 0;
  return {
    maxBytes: 72 * 1024 * 1024,
    maxNodes: Math.max(100_000, eventCount * 128 + 10_000),
  };
}

function assertPartialExport(value) {
  if (!value || Array.isArray(value)
    || value.protocol !== PARTIAL_RUN_EXPORT_PROTOCOL
    || value.version !== 1
    || value.completionStatus !== "partial"
    || !value.run?.runId
    || !Array.isArray(value.events)) {
    throw new TypeError("The journal returned an unsupported partial-run export.");
  }
  return value;
}

export function partialRunArtifacts(value) {
  const exported = assertPartialExport(cloneJson(value, recoveryCloneOptions(value)));
  const stem = `${safeFilePart(exported.run.studyId)}-${safeFilePart(exported.run.runId)}`;
  return Object.freeze({
    evidenceStatus: "partial",
    completionStatus: "partial",
    json: Object.freeze({
      name: `${stem}.partial.json`,
      type: "application/json;charset=utf-8",
      content: `${JSON.stringify(exported, null, 2)}\n`,
    }),
    csv: Object.freeze({
      name: `${stem}.partial.csv`,
      type: "text/csv;charset=utf-8",
      content: eventsToLongCsv(exported.events),
    }),
  });
}

function assertFinalizedExport(value) {
  if (!value || Array.isArray(value)
    || value.protocol !== FINALIZED_RUN_EXPORT_PROTOCOL
    || value.version !== 1
    || value.run?.status !== "finalized"
    || !value.run?.runId
    || value.completionStatus === "partial"
    || value.resultManifest?.completionStatus !== value.completionStatus
    || value.resultManifest?.runId !== value.run.runId
    || !Array.isArray(value.events)) {
    throw new TypeError("The journal returned an unsupported finalized-run export.");
  }
  return value;
}

export async function finalizedRunArtifacts(value) {
  const exported = assertFinalizedExport(cloneJson(value, recoveryCloneOptions(value)));
  const csv = eventsToLongCsv(exported.events);
  const observedDigest = await sha256TextHex(csv);
  if (observedDigest !== exported.resultManifest.csvSha256) {
    throw new StudyStorageStateError(
      `Finalized run ${exported.run.runId} no longer matches its CSV digest.`,
    );
  }
  const stem = `${safeFilePart(exported.run.studyId)}-${safeFilePart(exported.run.runId)}`;
  return Object.freeze({
    evidenceStatus: "finalized",
    completionStatus: exported.completionStatus,
    json: Object.freeze({
      name: `${stem}.manifest.json`,
      type: "application/json;charset=utf-8",
      content: `${JSON.stringify(exported.resultManifest, null, 2)}\n`,
    }),
    csv: Object.freeze({
      name: `${stem}.csv`,
      type: "text/csv;charset=utf-8",
      content: csv,
    }),
  });
}

export class PartialRunRecoveryService {
  constructor({ journal, runOwnership = new WebLockRunOwnership() } = {}) {
    if (!(journal instanceof StudyRunJournal)) {
      throw new TypeError("PartialRunRecoveryService requires a StudyRunJournal.");
    }
    if (!runOwnership
      || typeof runOwnership.isAvailable !== "function"
      || typeof runOwnership.withLockIfAvailable !== "function") {
      throw new TypeError("PartialRunRecoveryService requires a run ownership adapter.");
    }
    this.journal = journal;
    this.runOwnership = runOwnership;
  }

  async list() {
    return (await this.listWithIssues()).runs;
  }

  async listWithIssues() {
    const retained = await this.journal.listRetainedRunsWithIssues();
    const runs = retained.runs;
    const summaries = await Promise.all(runs.map(async (run) => {
      const lockAvailable = await this.runOwnership.isAvailable(run.runId);
      if (lockAvailable === false) return undefined;
      const finalized = run.status === "finalized";
      const allowedActions = [finalized ? "export-finalized" : "export-partial"];
      if (lockAvailable === true) {
        allowedActions.push(finalized ? "discard-finalized" : "discard-and-restart");
      }
      return Object.freeze({
        runId: run.runId,
        studyId: run.studyId,
        protocolHash: run.protocolHash,
        status: run.status,
        completionStatus: finalized ? run.resultManifest.completionStatus : "partial",
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        finalizedAt: run.finalizedAt,
        eventCount: run.nextSequence - 1,
        eventBytes: run.eventBytes,
        checkpoint: cloneJson(run.checkpoint),
        pendingAction: run.pendingAction === null
          ? null
          : Object.freeze({
            actionId: run.pendingAction.action.actionId,
            commandType: run.pendingAction.action.command?.type ?? "unknown",
          }),
        discardAllowed: lockAvailable === true,
        allowedActions: Object.freeze(allowedActions),
      });
    }));
    return Object.freeze({
      runs: Object.freeze(summaries.filter(Boolean)),
      issues: Object.freeze(retained.issues),
    });
  }

  async export(runId) {
    const perform = async () => {
      const run = await this.journal.getRun(runId);
      if (!run) throw new StudyStorageStateError(`Run ${runId} does not exist.`);
      if (run.status === "partial") {
        return partialRunArtifacts(await this.journal.exportPartial(runId));
      }
      return finalizedRunArtifacts(await this.journal.exportFinalized(runId));
    };
    if (!this.runOwnership.supported) return perform();
    const locked = await this.runOwnership.withLockIfAvailable(runId, perform);
    if (!locked.acquired) {
      throw new StudyStorageConflictError(`Run ${runId} is active in another page.`);
    }
    return locked.value;
  }

  async discard(runId) {
    const locked = await this.runOwnership.withLockIfAvailable(runId, async () => {
      const run = await this.journal.getRun(runId);
      if (!run) throw new StudyStorageStateError(`Run ${runId} does not exist.`);
      const expected = {
        expectedUpdatedAt: run.updatedAt,
        expectedNextSequence: run.nextSequence,
      };
      if (run.status === "partial") await this.journal.discardPartial(runId, expected);
      else await this.journal.discardFinalized(runId, expected);
    });
    if (!locked.acquired) {
      throw new StudyStorageConflictError(`Run ${runId} is active in another page.`);
    }
    return this.list();
  }

  async close() {
    await this.journal.close();
  }
}
