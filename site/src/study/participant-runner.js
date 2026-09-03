import { IndexedDbJournalBackend } from "./indexeddb-journal-backend.js";
import { MemoryJournalBackend } from "./memory-journal-backend.js";
import { createRunCheckpoint, StudyRunJournal } from "./run-journal.js";
import { WebLockRunOwnership } from "./run-ownership.js";

export const RUN_CONFIGURATION_SCHEMA = "affect-tracker-run-configuration";
export const STUDY_ACTION_SCHEMA = "affect-tracker-study-action";
export const RESULT_MANIFEST_SCHEMA = "affect-tracker-result-manifest";
export const STUDY_CONTRACT_VERSION = 1;

const PLATFORM_CAPABILITIES = Object.freeze({
  pages2d: Object.freeze([
    "affectInput",
    "contentAddressedMedia",
    "flatVideo",
    "questionnaires",
    "faceFlubberComparison",
    "youtubeEmbed",
    "durableJournal",
  ]),
  desktop: Object.freeze([
    "affectInput",
    "contentAddressedMedia",
    "flatVideo",
    "questionnaires",
    "faceFlubberComparison",
    "durableJournal",
  ]),
  webXr: Object.freeze([
    "affectInput",
    "contentAddressedMedia",
    "flatVideo",
    "equirectangular180",
    "equirectangular360",
    "sideBySideStereo",
    "topBottomStereo",
    "questionnaires",
    "faceFlubberComparison",
    "immersivePanels",
    "durableJournal",
  ]),
});

function cloneJson(value) {
  return globalThis.structuredClone
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function identifier(prefix, randomUuid = () => globalThis.crypto?.randomUUID?.()) {
  const suffix = randomUuid?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${String(suffix).replace(/[^A-Za-z0-9._-]/g, "-")}`.slice(0, 128);
}

export function randomRunSeed(crypto = globalThis.crypto) {
  if (!crypto?.getRandomValues) throw new Error("Secure random generation is unavailable.");
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function usesOrderPolicy(study, policy) {
  return (study.sections ?? []).some((section) => section.orderPolicy?.type === policy);
}

export function createRunConfiguration(study, {
  platform = "pages2d",
  runId = identifier("run"),
  participantCode,
  randomSeed,
  counterbalanceGroup,
  capabilities = PLATFORM_CAPABILITIES[platform],
  storageStatus = "ready",
  inputStatus = "ready",
  lslStatus = "unavailable",
} = {}) {
  if (!capabilities) throw new Error(`Unsupported study platform: ${platform}.`);
  const configuration = {
    schema: RUN_CONFIGURATION_SCHEMA,
    version: STUDY_CONTRACT_VERSION,
    runId,
    platform: { platform, capabilities: [...new Set(capabilities)] },
    initialHealth: {
      storage: { status: storageStatus },
      input: { status: inputStatus },
      lsl: lslStatus === "ready"
        ? { status: "ready" }
        : { status: lslStatus, detailCode: "not-required" },
    },
  };
  if (participantCode) configuration.participantCode = participantCode;
  if (usesOrderPolicy(study, "seededShuffle")) {
    configuration.randomSeed = randomSeed ?? randomRunSeed();
  }
  if (usesOrderPolicy(study, "williamsBalancedLatinSquare")) {
    configuration.counterbalanceGroup = Number(counterbalanceGroup ?? 1);
  }
  return configuration;
}

export function findStudyBlock(study, blockId) {
  if (!blockId) return undefined;
  for (const section of study.sections ?? []) {
    for (const trial of section.trials ?? []) {
      const block = (trial.blocks ?? []).find((candidate) => candidate.blockId === blockId);
      if (block) return block;
    }
  }
  return undefined;
}

export function questionnaireForBlock(study, block) {
  if (block?.type !== "questionnaire") return undefined;
  return (study.questionnaires ?? []).find(({ questionnaireId }) => questionnaireId === block.questionnaireId);
}

function parsed(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function eventsToLongCsv(events) {
  const header = [
    "sequence",
    "authority_generation",
    "revision",
    "run_id",
    "section_id",
    "trial_id",
    "block_id",
    "monotonic_ms",
    "wall_time_utc",
    "event_type",
    "payload_json",
  ];
  const rows = events.map((event) => [
    event.sequence,
    event.authorityGeneration,
    event.revision,
    event.runId,
    event.sectionId,
    event.trialId,
    event.blockId,
    event.monotonicMs,
    event.wallTimeUtc,
    event.payload?.type,
    JSON.stringify(event.payload),
  ]);
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function finalizedResultCloneOptions(result, maxRunBytes = 64 * 1024 * 1024) {
  const eventCount = Array.isArray(result?.events) ? result.events.length : 0;
  return {
    maxBytes: maxRunBytes * 3 + 4 * 1024 * 1024,
    maxNodes: Math.max(100_000, eventCount * 128 + 10_000),
  };
}

export async function sha256TextHex(value) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function journalBackend() {
  if (globalThis.indexedDB && globalThis.IDBKeyRange) return new IndexedDbJournalBackend();
  return new MemoryJournalBackend();
}

function checkpointFor(state, study, command, previousBlock) {
  if (state.lastEventSequence < 1) return undefined;
  const block = findStudyBlock(study, state.currentBlockId);
  if (state.phase === "prepared" && block) {
    return createRunCheckpoint({
      sequence: state.lastEventSequence,
      position: "block-ready",
      blockId: block.blockId,
      blockKind: block.type,
      phase: state.phase,
    });
  }
  if (["running", "paused"].includes(state.phase) && block) {
    return createRunCheckpoint({
      sequence: state.lastEventSequence,
      position: "block-active",
      blockId: block.blockId,
      blockKind: block.type,
      phase: state.phase,
    });
  }
  if (state.phase === "awaitingFinalization" && previousBlock) {
    return createRunCheckpoint({
      sequence: state.lastEventSequence,
      position: "block-complete",
      blockId: previousBlock.blockId,
      blockKind: previousBlock.type,
      phase: state.phase,
    });
  }
  if (command.type === "prepare") {
    return createRunCheckpoint({
      sequence: state.lastEventSequence,
      position: "run-start",
      blockId: null,
      blockKind: null,
      phase: state.phase,
    });
  }
  return undefined;
}

export class BrowserStudySession {
  constructor({
    core,
    study,
    configuration,
    generation = 1,
    journal = new StudyRunJournal({ backend: journalBackend() }),
    runOwnership = new WebLockRunOwnership(),
    assetBindings = new Map(),
    now = () => new Date(),
    monotonicNow = () => globalThis.performance?.now?.() ?? Date.now(),
    randomUuid = () => globalThis.crypto?.randomUUID?.(),
  } = {}) {
    if (!core?.createAuthority) throw new TypeError("A loaded shared study core is required.");
    if (!study?.protocolHash) throw new TypeError("A published study with protocolHash is required.");
    this.core = core;
    this.study = cloneJson(study);
    this.configuration = cloneJson(configuration);
    this.generation = generation;
    this.journal = journal;
    if (!runOwnership
      || typeof runOwnership.acquire !== "function"
      || typeof runOwnership.withLockIfAvailable !== "function") {
      throw new TypeError("BrowserStudySession requires a run ownership adapter.");
    }
    this.runOwnership = runOwnership;
    this.runLock = undefined;
    this.assetBindings = assetBindings;
    this.now = now;
    this.monotonicNow = monotonicNow;
    this.randomUuid = randomUuid;
    this.authority = undefined;
    this.authorityGeneration = undefined;
    this.lastOutcome = undefined;
    this.finalized = undefined;
    this.pendingJournalOutcome = undefined;
    this.externalJournalError = undefined;
    this.externalAcceptedOutcomeListeners = new Set();
    this.externalOutcomeListeners = new Set();
    this.authorityUnsubscribe = undefined;
    this.dispatchTail = Promise.resolve();
    this.closePromise = undefined;
    this.abandonPromise = undefined;
    this.abandonResult = undefined;
    this.abandoning = false;
    this.closed = false;
  }

  state() {
    if (!this.authority) throw new Error("The study session has not been initialized.");
    return parsed(this.authority.stateJson());
  }

  currentBlock() {
    return findStudyBlock(this.study, this.state().currentBlockId);
  }

  pendingJournalCommand() {
    return this.pendingJournalOutcome
      ? cloneJson(JSON.parse(this.pendingJournalOutcome.inputCommandJson))
      : undefined;
  }

  async retryPendingJournalOutcome() {
    const command = this.pendingJournalCommand();
    return command ? this.dispatch(command) : undefined;
  }

  subscribeExternalOutcomes(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("An external study-outcome listener must be a function.");
    }
    this.externalOutcomeListeners.add(listener);
    return () => this.externalOutcomeListeners.delete(listener);
  }

  subscribeExternalAcceptedOutcomes(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("An accepted external study-outcome listener must be a function.");
    }
    this.externalAcceptedOutcomeListeners.add(listener);
    return () => this.externalAcceptedOutcomeListeners.delete(listener);
  }

  async initialize({ calibrationPoint, autoStart = true } = {}) {
    if (typeof autoStart !== "boolean") throw new TypeError("autoStart must be a boolean.");
    await this.#ensureRunLock();
    let runCreated = false;
    try {
      await this.journal.createRun({
        runId: this.configuration.runId,
        studyId: this.study.studyId,
        protocolHash: this.study.protocolHash,
        metadata: {
          platform: this.configuration.platform.platform,
          participantCode: this.configuration.participantCode ?? null,
          protocolRevision: this.study.revision,
        },
      });
      runCreated = true;
      this.authority = await this.core.createAuthority(
        this.study,
        this.configuration,
        this.generation,
      );
      const initialAuthorityState = parsed(this.authority.stateJson());
      if (!Number.isSafeInteger(initialAuthorityState.authorityGeneration)
        || initialAuthorityState.authorityGeneration < 1) {
        throw new Error("The study authority returned an invalid generation.");
      }
      this.authorityGeneration = initialAuthorityState.authorityGeneration;
      if (typeof this.authority.subscribe === "function") {
        this.authorityUnsubscribe = this.authority.subscribe((detail) => {
          if (detail?.source === "external") this.#queueExternalOutcome(detail);
        });
      }
    } catch (error) {
      if (runCreated) await this.journal.discardPartial(this.configuration.runId).catch(() => {});
      await this.#releaseRunLock();
      throw error;
    }
    try {
      await this.dispatch({ type: "prepare" });
      await this.dispatch({
        type: "applyPinnedSettings",
        settingsSha256: this.study.pinnedSettings.portableSettingsSha256,
      });
      if (this.study.pinnedSettings.acquisition.resetPolicy === "requireCalibration") {
        if (!calibrationPoint) throw new Error("This study requires a pre-run affect calibration point.");
        await this.dispatch({ type: "setAffectCalibration", point: calibrationPoint });
      }
      if (autoStart) {
        await this.dispatch({ type: "arm" });
        await this.dispatch({ type: "start" });
      }
      return this.state();
    } catch (error) {
      // The caller may need to abort/finalize a partially prepared native run.
      // Keep the per-run ownership lock through that cleanup so recovery UI in
      // another page cannot export or discard a journal that is still live.
      throw error;
    }
  }

  async dispatch(inputCommand) {
    if (this.closed) throw new Error("The study session is closed.");
    if (this.abandoning) {
      throw new Error("The study session is retaining its partial evidence and accepts no further actions.");
    }
    const pending = this.dispatchTail.then(() => this.#dispatchNow(inputCommand));
    this.dispatchTail = pending.catch(() => {});
    return pending;
  }

  async #dispatchNow(inputCommand) {
    await this.#ensureRunLock();
    if (!this.authority) throw new Error("The study session has not been initialized.");
    if (this.finalized) throw new Error("The study session journal is already finalized.");
    if (this.externalJournalError) {
      throw new Error(
        "A remote study action changed the native authority but could not be mirrored into the browser journal. Local controls are locked; retain the native Rust record and stop the run from the desktop authority.",
        { cause: this.externalJournalError },
      );
    }
    const inputCommandJson = JSON.stringify(inputCommand);
    if (this.pendingJournalOutcome) {
      const pendingCommandJson = this.pendingJournalOutcome.inputCommandJson;
      const recovered = await this.#commitPendingJournalOutcome();
      if (inputCommandJson === pendingCommandJson) return recovered;
    }
    const state = this.state();
    const previousBlock = findStudyBlock(this.study, state.currentBlockId);
    const monotonicMs = Math.max(Math.floor(this.monotonicNow()), state.lastEventMonotonicMs);
    const command = cloneJson(inputCommand);
    if (command.type === "reportMediaTimeline") {
      command.anchor.observedMonotonicMs = monotonicMs;
    }
    const precondition = { expectedPhase: state.phase };
    if (state.currentBlockId) precondition.expectedBlockId = state.currentBlockId;
    const action = {
      schema: STUDY_ACTION_SCHEMA,
      version: STUDY_CONTRACT_VERSION,
      actionId: identifier("action", this.randomUuid),
      runId: state.runId,
      authorityGeneration: state.authorityGeneration,
      expectedRevision: state.revision,
      precondition,
      clock: { monotonicMs, wallTimeUtc: this.now().toISOString() },
      command,
    };
    const expectedNextSequence = state.lastEventSequence + 1;
    await this.journal.stageAction(state.runId, action, { expectedNextSequence });
    let outcome;
    try {
      outcome = parsed(await this.authority.applyJson(JSON.stringify(action)));
    } catch (error) {
      await this.journal.clearStagedAction(state.runId, action.actionId);
      throw error;
    }
    const checkpoint = checkpointFor(outcome.state, this.study, command, previousBlock);
    this.pendingJournalOutcome = {
      runId: state.runId,
      actionId: action.actionId,
      expectedNextSequence,
      inputCommandJson,
      outcome,
      checkpoint,
    };
    try {
      return await this.#commitPendingJournalOutcome();
    } catch (error) {
      throw new Error(
        "The study action was accepted, but its local journal commit was interrupted. The run is locked against further actions; retry the same control to commit it safely.",
        { cause: error },
      );
    }
  }

  async #commitPendingJournalOutcome() {
    const pending = this.pendingJournalOutcome;
    if (!pending) throw new Error("No accepted study action is awaiting journal commit.");
    if (pending.outcome.events.length > 0) {
      await this.journal.appendEvents(pending.runId, pending.outcome.events, {
        expectedNextSequence: pending.expectedNextSequence,
        stagedActionId: pending.actionId,
        ...(pending.checkpoint ? { checkpoint: pending.checkpoint } : {}),
      });
    } else {
      await this.journal.clearStagedAction(pending.runId, pending.actionId, {
        ...(pending.checkpoint ? { checkpoint: pending.checkpoint } : {}),
      });
    }
    this.pendingJournalOutcome = undefined;
    this.lastOutcome = pending.outcome;
    return cloneJson(pending.outcome);
  }

  #queueExternalOutcome(detail) {
    if (this.closed || this.abandoning) return;
    const action = cloneJson(detail.action);
    const outcome = cloneJson(detail.outcome);
    try {
      this.#assertExternalOutcomeEnvelope(action, outcome);
      this.#notifyExternalAcceptedOutcome({ action, outcome });
    } catch {
      // Malformed or foreign native notifications are handled by the durable
      // commit path and must never change the physical participant surface.
    }
    const pending = this.dispatchTail.then(() => this.#commitExternalOutcome(action, outcome));
    this.dispatchTail = pending.catch(() => {});
    void pending.then(
      (committed) => this.#notifyExternalOutcome({
        action,
        outcome: committed.outcome,
        result: committed.result,
      }),
      (error) => {
        this.externalJournalError = error;
        this.#notifyExternalOutcome({ action, outcome, error });
      },
    );
  }

  async #commitExternalOutcome(action, outcome) {
    await this.#ensureRunLock();
    if (!this.authority) throw new Error("The study session has not been initialized.");
    if (this.finalized) throw new Error("The study session journal is already finalized.");
    this.#assertExternalOutcomeEnvelope(action, outcome);
    if (this.pendingJournalOutcome) await this.#commitPendingJournalOutcome();

    const run = await this.journal.getRun(this.configuration.runId);
    if (!run || run.status !== "partial") {
      throw new Error("The external study outcome has no writable browser mirror journal.");
    }
    const previousBlock = findStudyBlock(
      this.study,
      action.precondition?.expectedBlockId ?? this.lastOutcome?.state?.currentBlockId,
    );
    const checkpoint = checkpointFor(outcome.state, this.study, action.command, previousBlock);
    if (outcome.events.length > 0) {
      await this.journal.appendEvents(run.runId, outcome.events, {
        expectedNextSequence: run.nextSequence,
        ...(checkpoint ? { checkpoint } : {}),
      });
    } else if (checkpoint) {
      if (outcome.state.lastEventSequence !== run.nextSequence - 1) {
        throw new Error("The external study outcome sequence does not match the browser mirror journal.");
      }
      await this.journal.setCheckpoint(run.runId, checkpoint, {
        expectedNextSequence: run.nextSequence,
      });
    }
    this.lastOutcome = outcome;
    const terminal = ["completed", "aborted"].includes(outcome.state.phase);
    const result = terminal ? await this.finalizeJournal() : undefined;
    return { outcome: cloneJson(outcome), result };
  }

  #notifyExternalOutcome(detail) {
    const immutableDetail = Object.freeze({
      action: cloneJson(detail.action),
      outcome: cloneJson(detail.outcome),
      ...(detail.result ? { result: cloneJson(detail.result) } : {}),
      ...(detail.error ? { error: detail.error } : {}),
    });
    for (const listener of this.externalOutcomeListeners) {
      try {
        listener(immutableDetail);
      } catch (error) {
        globalThis.console?.error?.("External study-outcome listener failed.", error);
      }
    }
  }

  #assertExternalOutcomeEnvelope(action, outcome) {
    if (!action?.command || !outcome?.state || !Array.isArray(outcome.events)) {
      throw new TypeError("The native authority returned an invalid external study outcome.");
    }
    if (action.runId !== this.configuration.runId
      || outcome.state.runId !== this.configuration.runId
      || action.authorityGeneration !== this.authorityGeneration
      || outcome.state.authorityGeneration !== this.authorityGeneration) {
      throw new Error("The external study outcome does not belong to this browser session.");
    }
  }

  #notifyExternalAcceptedOutcome(detail) {
    const immutableDetail = Object.freeze({
      action: cloneJson(detail.action),
      outcome: cloneJson(detail.outcome),
    });
    for (const listener of this.externalAcceptedOutcomeListeners) {
      try {
        listener(immutableDetail);
      } catch (error) {
        globalThis.console?.error?.("Accepted external study-outcome listener failed.", error);
      }
    }
  }

  async submitQuestionnaire(questionnaireId, answers) {
    return this.dispatch({ type: "submitQuestionnaire", questionnaireId, answers });
  }

  async reportMedia(mediaPositionMs, playing, playbackRate = 1) {
    return this.dispatch({
      type: "reportMediaTimeline",
      anchor: { mediaPositionMs: Math.max(0, Math.round(mediaPositionMs)), observedMonotonicMs: 0, playing, playbackRate },
    });
  }

  async recordAffect({ currentValence, currentArousal, targetValence = currentValence, targetArousal = currentArousal }) {
    return this.dispatch({
      type: "recordAffectSample",
      sample: { currentValence, currentArousal, targetValence, targetArousal },
    });
  }

  async advance() {
    return this.dispatch({ type: "advance" });
  }

  async finalize() {
    await this.retryPendingJournalOutcome();
    if (this.state().phase === "awaitingFinalization") await this.dispatch({ type: "finalize" });
    if (this.state().phase !== "completed") throw new Error("Only a completed or stopped session can be finalized.");
    return this.finalizeJournal();
  }

  async stop(reasonCode = "researcher-stop") {
    await this.retryPendingJournalOutcome();
    const phase = this.state().phase;
    if (["running", "paused"].includes(phase)) {
      await this.dispatch({ type: "stop", reasonCode });
    } else if (phase === "awaitingFinalization") {
      await this.dispatch({ type: "finalize" });
    } else if (["created", "prepared", "armed"].includes(phase)) {
      await this.dispatch({ type: "abort", reasonCode });
    }
    return this.finalizeJournal();
  }

  async abort(reasonCode = "adapter-abort") {
    await this.retryPendingJournalOutcome();
    if (!["completed", "aborted"].includes(this.state().phase)) {
      await this.dispatch({ type: "abort", reasonCode });
    }
    return this.finalizeJournal();
  }

  async stopNativeAfterMirrorFailure(reasonCode = "browser-mirror-failure") {
    if ((!this.externalJournalError && !this.pendingJournalOutcome)
      || this.core.implementation !== "native-rust") {
      throw new Error("Native-only stop is available only after a desktop browser-journal failure.");
    }
    const pending = this.dispatchTail.then(() => this.#applyNativeTerminal(reasonCode));
    this.dispatchTail = pending.catch(() => {});
    return pending;
  }

  async #applyNativeTerminal(reasonCode) {
    await this.#ensureRunLock();
    const applyNative = async (command) => {
      const state = this.state();
      const monotonicMs = Math.max(Math.floor(this.monotonicNow()), state.lastEventMonotonicMs);
      const precondition = { expectedPhase: state.phase };
      if (state.currentBlockId) precondition.expectedBlockId = state.currentBlockId;
      const action = {
        schema: STUDY_ACTION_SCHEMA,
        version: STUDY_CONTRACT_VERSION,
        actionId: identifier("action", this.randomUuid),
        runId: state.runId,
        authorityGeneration: state.authorityGeneration,
        expectedRevision: state.revision,
        precondition,
        clock: { monotonicMs, wallTimeUtc: this.now().toISOString() },
        command,
      };
      return parsed(await this.authority.applyJson(JSON.stringify(action)));
    };

    let state = this.state();
    const events = [];
    if (["running", "paused"].includes(state.phase)) {
      let outcome;
      try {
        outcome = await applyNative({ type: "stop", reasonCode });
      } catch {
        // Some protocols prohibit early Stop. Abort is the explicit native
        // safety terminal and remains distinct from the uncommitted browser
        // action being abandoned.
        outcome = await applyNative({ type: "abort", reasonCode });
      }
      events.push(...outcome.events);
      state = outcome.state;
    } else if (["created", "prepared", "armed"].includes(state.phase)) {
      const outcome = await applyNative({ type: "abort", reasonCode });
      events.push(...outcome.events);
      state = outcome.state;
    }
    if (state.phase === "awaitingFinalization") {
      const outcome = await applyNative({ type: "finalize" });
      events.push(...outcome.events);
      state = outcome.state;
    }
    if (!["completed", "aborted"].includes(state.phase)) {
      throw new Error(`The native authority did not reach a terminal phase; observed ${state.phase}.`);
    }
    return { state: cloneJson(state), events: cloneJson(events), nativeOnly: true };
  }

  async abandonPendingJournalOutcome({ reasonCode = "evidence-write-unrecoverable" } = {}) {
    if (typeof reasonCode !== "string" || !reasonCode.trim()) {
      throw new TypeError("A non-empty partial-evidence reasonCode is required.");
    }
    if (this.abandonResult) return cloneJson(this.abandonResult);
    if (this.abandonPromise) return this.abandonPromise;
    if (this.closed) throw new Error("The study session is closed.");
    if (!this.pendingJournalOutcome) {
      throw new Error("No accepted study action is staged for partial-evidence retention.");
    }

    // Close the enqueue boundary synchronously, but do not release storage
    // ownership until the actual journal transaction has settled. A timeout is
    // therefore never treated as cancellation.
    this.abandoning = true;
    const settledTail = this.dispatchTail.catch(() => {});
    const operation = (async () => {
      await settledTail;
      const pending = this.pendingJournalOutcome;
      if (!pending) {
        throw new Error(
          "The evidence write committed before partial retention began. Resume explicitly or end the run normally.",
        );
      }

      let nativeTerminal;
      if (this.core.implementation === "native-rust") {
        nativeTerminal = await this.#applyNativeTerminal(reasonCode);
      }
      const summary = {
        runId: pending.runId,
        reasonCode: reasonCode.trim(),
        dataLossReason: "accepted-action-outcome-not-durably-committed",
        stagedAction: Object.freeze({
          actionId: pending.actionId,
          commandType: JSON.parse(pending.inputCommandJson).type,
        }),
        browserEvidenceStatus: "partial",
        authorityState: cloneJson(nativeTerminal?.state ?? this.state()),
        nativeAuthorityTerminated: Boolean(nativeTerminal),
      };
      try {
        await this.close();
      } catch (error) {
        // close() releases the Web Lock in its finally block. Preserve the
        // successful partial-retention result while disclosing an adapter-level
        // close warning instead of leaving a now-closed session with no escape.
        summary.teardownWarning = error?.message ?? String(error);
      }
      this.abandonResult = Object.freeze(summary);
      return cloneJson(this.abandonResult);
    })();
    this.abandonPromise = operation.catch((error) => {
      this.abandoning = false;
      this.abandonPromise = undefined;
      throw error;
    });
    return this.abandonPromise;
  }

  async finalizeJournal({ appVersion = "1.0.0", buildCommit = "development" } = {}) {
    const resultCloneOptions = finalizedResultCloneOptions(
      this.finalized,
      this.journal.limits.maxRunBytes,
    );
    if (this.finalized) return cloneJson(this.finalized, resultCloneOptions);
    await this.#ensureRunLock();
    try {
      const recovered = await this.journal.exportPartial(this.configuration.runId);
      const csv = eventsToLongCsv(recovered.events);
      const csvSha256 = await sha256TextHex(csv);
      const state = this.state();
      const manifest = {
        schema: RESULT_MANIFEST_SCHEMA,
        version: STUDY_CONTRACT_VERSION,
        resultId: identifier("result", this.randomUuid),
        runId: state.runId,
        studyId: this.study.studyId,
        protocolHash: this.study.protocolHash,
        settingsSha256: this.study.pinnedSettings.portableSettingsSha256,
        build: { platform: this.configuration.platform.platform, appVersion, buildCommit },
        assetVerification: (this.study.media ?? []).map((asset) => {
          const bound = this.assetBindings.get(asset.assetId);
          const verified = Boolean(bound && bound.size === asset.byteLength);
          return {
            assetId: asset.assetId,
            expectedSha256: asset.sha256,
            expectedByteLength: asset.byteLength,
            verified,
            ...(bound ? { observedSha256: asset.sha256, observedByteLength: bound.size } : {}),
          };
        }),
        ...(this.configuration.randomSeed ? { randomSeed: this.configuration.randomSeed } : {}),
        ...(this.configuration.counterbalanceGroup ? { counterbalanceGroup: this.configuration.counterbalanceGroup } : {}),
        resolvedOrder: state.resolvedOrder,
        completionStatus: state.completionStatus,
        eventCount: state.lastEventSequence,
        csvSha256,
        finalizedWallTimeUtc: this.now().toISOString(),
      };
      if (this.core.implementation === "wasm") {
        await this.core.validateResultManifest(manifest);
      }
      await this.journal.finalizeRun(state.runId, { resultManifest: manifest });
      this.finalized = { manifest, csv, events: recovered.events };
      return cloneJson(
        this.finalized,
        finalizedResultCloneOptions(this.finalized, this.journal.limits.maxRunBytes),
      );
    } finally {
      await this.#releaseRunLock();
    }
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.authorityUnsubscribe?.();
    this.authorityUnsubscribe = undefined;
    const pending = this.dispatchTail.catch(() => {});
    this.closePromise = (async () => {
      await pending;
      try {
        await this.journal.close();
      } finally {
        this.externalAcceptedOutcomeListeners.clear();
        this.externalOutcomeListeners.clear();
        await this.#releaseRunLock();
      }
    })();
    return this.closePromise;
  }

  async #ensureRunLock() {
    if (this.runLock) return this.runLock;
    if (this.closed) throw new Error("The study session is closed.");
    this.runLock = await this.runOwnership.acquire(this.configuration.runId);
    return this.runLock;
  }

  async #releaseRunLock() {
    const lock = this.runLock;
    this.runLock = undefined;
    await lock?.release();
  }
}

export { PLATFORM_CAPABILITIES };
