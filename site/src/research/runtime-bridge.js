import { RESEARCH_UI_EVENTS, estimateResearchStorageUse } from "./app.js";
import { IndexedDbResearchJournal } from "./browser-journal.js";
import { participantIds } from "./identity.js";
import { BrowserResearchRunController } from "./run-controller.js";
import { probeBrowserStorage } from "./storage-capability.js";
import { probeVideoFile, sha256Blob } from "./workspace.js";
import {
  YOUTUBE_PREFLIGHT_MAX_AGE_MS,
  YouTubeIframePlayerAdapter,
  isFreshYouTubePreflight,
} from "./youtube-player.js";

const RUNTIME_LOCK_NAME = "affect-research/v1/authoritative-browser-runtime";
const MEDIA_CLOCK_UPDATE_MS = 50;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function once(target, type, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${type}.`));
    }, timeoutMs);
    const success = (event) => {
      cleanup();
      resolve(event);
    };
    const failure = () => {
      cleanup();
      reject(new Error("The complete video could not be decoded for playback."));
    };
    function cleanup() {
      clearTimeout(timeout);
      target.removeEventListener(type, success);
      target.removeEventListener("error", failure);
    }
    target.addEventListener(type, success, { once: true });
    target.addEventListener("error", failure, { once: true });
  });
}

export async function acquireExclusiveRuntimeLease(lockManager = globalThis.navigator?.locks) {
  if (!lockManager || typeof lockManager.request !== "function") {
    throw new Error("Desktop Chrome or Edge Web Locks support is required for authoritative recovery.");
  }
  let report;
  const reported = new Promise((resolve) => { report = resolve; });
  let releaseHold;
  const request = lockManager.request(
    RUNTIME_LOCK_NAME,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) {
        report(null);
        return;
      }
      const hold = new Promise((resolve) => { releaseHold = resolve; });
      report(Object.freeze({
        name: RUNTIME_LOCK_NAME,
        release() { releaseHold?.(); },
      }));
      await hold;
    },
  );
  const lease = await reported;
  if (!lease) {
    await request;
    throw new Error("Affect Research is already open in another browser tab for this origin.");
  }
  request.catch(() => {});
  return lease;
}

export async function probeSamplingWorker(
  workerFactory = () => new Worker(new URL("./sampling-worker.js", import.meta.url), { type: "module" }),
) {
  const worker = workerFactory();
  if (!worker?.postMessage || !worker?.addEventListener || !worker?.terminate) {
    throw new TypeError("Sampling worker probe returned an invalid Worker.");
  }
  try {
    const sessionToken = `probe-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
    const controllerTimeOriginMs = globalThis.performance?.timeOrigin;
    if (!Number.isFinite(controllerTimeOriginMs)) {
      throw new Error("The browser performance clock origin is unavailable.");
    }
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Sampling worker readiness timed out.")), 5_000);
      worker.addEventListener("message", ({ data }) => {
        if (data?.type !== "ready") return;
        if (data.sessionToken !== sessionToken
          || data.clockDomain !== "controller-performance-v1"
          || data.controllerTimeOriginMs !== controllerTimeOriginMs) {
          clearTimeout(timeout);
          reject(new Error("Sampling worker did not prove the shared controller clock domain."));
          return;
        }
        clearTimeout(timeout);
        resolve();
      });
      worker.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Sampling worker failed its readiness probe."));
      }, { once: true });
      worker.postMessage({
        type: "configure",
        samplingFrequencyHz: 130,
        sessionToken,
        controllerTimeOriginMs,
      });
    });
    return true;
  } finally {
    worker.terminate();
  }
}

export function nextAttemptNumber(attempts, participantId, manifests = []) {
  const recordedNumbers = [
    ...attempts
      .filter((attempt) => attempt.participantId === participantId)
      .map((attempt) => attempt.attemptNumber),
    ...manifests
      .filter((manifest) => manifest.participantId === participantId)
      .map((manifest) => manifest.attemptNumber),
  ];
  return recordedNumbers.reduce((maximum, attemptNumber) => Math.max(maximum, attemptNumber), 0) + 1;
}

export function selectCompatibleRecovery(attempts, {
  participantId,
  settingsSha256,
  assignmentPlanSha256,
  workspaceId,
}) {
  return attempts
    .filter((attempt) => attempt.participantId === participantId
      && (workspaceId === undefined || attempt.context?.workspaceId === workspaceId)
      && attempt.status === "partial"
      && attempt.recoverable === true
      && attempt.settingsHash === settingsSha256
      && attempt.planHash === assignmentPlanSha256)
    .sort((left, right) => right.attemptNumber - left.attemptNumber)[0] ?? null;
}

export function participantStateDetail(rows, { recoverableByParticipant = null } = {}) {
  const detail = Object.fromEntries(rows.map(({ participantId, state }) => [
    participantId,
    String(state).toLowerCase(),
  ]));
  if (recoverableByParticipant) {
    detail.__recoverable = Object.freeze(Object.fromEntries(
      Object.entries(recoverableByParticipant).map(([participantId, recoverable]) => [
        participantId,
        recoverable === true,
      ]),
    ));
  }
  return Object.freeze(detail);
}

export function assertFreshYouTubePreflights(plan, recordForStimulus, {
  now = Date.now(),
  maximumAgeMs = YOUTUBE_PREFLIGHT_MAX_AGE_MS,
} = {}) {
  const youtubeStimuli = plan?.stimuli?.filter(({ source }) => source.kind === "youtube") ?? [];
  if (youtubeStimuli.length === 0) return true;
  if (typeof recordForStimulus !== "function") {
    throw new Error("Experimental YouTube Start requires fresh visible-player preflight records from this page session.");
  }
  for (const stimulus of youtubeStimuli) {
    const record = recordForStimulus(stimulus.stimulusId);
    if (!isFreshYouTubePreflight(record, stimulus.source, { now, maximumAgeMs })) {
      throw new Error(`Experimental YouTube stimulus ${stimulus.title} needs a fresh successful visible-player preflight before Start.`);
    }
  }
  return true;
}

export function mergeParticipantStateRows(rows, manifests, ids) {
  const priority = Object.freeze({ Available: 0, Complete: 1, Partial: 2, Active: 3 });
  const stateByParticipant = new Map(ids.map((participantId) => [participantId, "Available"]));
  for (const row of rows) {
    if (stateByParticipant.has(row.participantId)
      && priority[row.state] > priority[stateByParticipant.get(row.participantId)]) {
      stateByParticipant.set(row.participantId, row.state);
    }
  }
  for (const manifest of manifests) {
    if (!stateByParticipant.has(manifest.participantId)) continue;
    const state = manifest.completionStatus === "completed" ? "Complete" : "Partial";
    if (priority[state] > priority[stateByParticipant.get(manifest.participantId)]) {
      stateByParticipant.set(manifest.participantId, state);
    }
  }
  return Object.freeze(ids.map((participantId) => Object.freeze({
    participantId,
    state: stateByParticipant.get(participantId),
  })));
}

async function verifyBlobAgainstSource(blob, source) {
  if (blob.size !== source.byteLength) {
    throw new Error("The stimulus byte length changed after settings were frozen.");
  }
  const digest = await sha256Blob(blob);
  if (digest !== source.sha256) {
    throw new Error("The stimulus SHA-256 changed after settings were frozen.");
  }
  const probe = await probeVideoFile(blob);
  if (!probe.decodeVerified) throw new Error("The stimulus no longer passes decode preflight.");
  const observedDurationMs = Math.round(probe.durationSeconds * 1_000);
  if (Math.abs(observedDurationMs - source.durationMs) > Math.max(250, source.durationMs * 0.005)) {
    throw new Error("The stimulus duration changed after settings were frozen.");
  }
  return blob;
}

export class BrowserResearchRuntimeBridge {
  constructor(root, {
    journal = new IndexedDbResearchJournal(),
    controllerFactory = ({ workspace }) => new BrowserResearchRunController({ journal, workspace }),
    workerProbe = probeSamplingWorker,
    storageProbe = probeBrowserStorage,
    storageManager = globalThis.navigator?.storage,
    leaseFactory = acquireExclusiveRuntimeLease,
    fetchObject = globalThis.fetch?.bind(globalThis),
    createObjectURL = globalThis.URL?.createObjectURL?.bind(globalThis.URL),
    revokeObjectURL = globalThis.URL?.revokeObjectURL?.bind(globalThis.URL),
    youtubeAdapterFactory = null,
    now = () => new Date().toISOString(),
    epochNow = () => Date.now(),
    documentObject = globalThis.document,
    windowObject = globalThis.window,
  } = {}) {
    if (!(root instanceof EventTarget)) throw new TypeError("Browser runtime bridge requires the Research root event target.");
    this.root = root;
    this.journal = journal;
    this.controllerFactory = controllerFactory;
    this.workerProbe = workerProbe;
    this.storageProbe = storageProbe;
    this.storageManager = storageManager;
    this.leaseFactory = leaseFactory;
    this.fetchObject = fetchObject;
    this.createObjectURL = createObjectURL;
    this.revokeObjectURL = revokeObjectURL;
    this.youtubeAdapterFactory = youtubeAdapterFactory ?? ((container) => new YouTubeIframePlayerAdapter(container, {
      origin: this.window?.location?.origin ?? globalThis.location?.origin,
    }));
    this.now = now;
    this.epochNow = epochNow;
    this.document = documentObject;
    this.window = windowObject;
    this.lease = null;
    this.controller = null;
    this.run = null;
    this.objectUrl = null;
    this.youtubeAdapter = null;
    this.youtubeListeners = [];
    this.transitionTimer = null;
    this.mediaClockTimer = null;
    this.operation = Promise.resolve();
    this.listeners = [];
    this.ready = false;
    this.journalReady = false;
    this.manifestReady = false;
    this.manifestRefresh = 0;
    this.workspaceManifests = [];
    this.storageReadiness = null;
    this.outputWriteReady = false;
  }

  async initialize() {
    this.#bind();
    let journalReady = false;
    let workerReady = false;
    try {
      this.lease = await this.leaseFactory();
      await this.journal.open();
      const quarantined = await this.journal.auditAndQuarantine?.({ quarantinedAt: this.now() }) ?? [];
      await this.journal.reconcileAbandonedAttempts({ updatedAt: this.now() });
      journalReady = true;
      if (quarantined.length > 0) {
        this.#showSetupError(`${quarantined.length} corrupt recovery record${quarantined.length === 1 ? " was" : "s were"} isolated from usable attempts.`);
      }
    } catch (error) {
      this.#showSetupError(error);
    }
    try {
      workerReady = await this.workerProbe();
    } catch (error) {
      this.#showSetupError(error);
    }
    this.journalReady = journalReady;
    this.ready = journalReady && workerReady;
    await this.refreshStorageReadiness();
    this.#dispatch(RESEARCH_UI_EVENTS.capabilityStatus, {
      indexedDbReady: journalReady,
      timingWorkerReady: workerReady,
      lslReady: false,
      manifestReady: false,
      storageReady: this.storageReadiness?.sufficient === true,
      storageReadiness: this.storageReadiness,
    });
    if (journalReady) await this.refreshParticipantStates();
    return this;
  }

  async refreshParticipantStates(settings = this.root.researchUi?.settings) {
    const generation = ++this.manifestRefresh;
    this.manifestReady = false;
    this.workspaceManifests = [];
    this.#dispatch(RESEARCH_UI_EVENTS.capabilityStatus, { manifestReady: false, manifestError: "" });
    if (!settings || !this.journalReady) return false;
    const ids = [...participantIds(settings.experiment.participantCount)];
    const workspace = this.root.researchUi?.workspace;
    if (!workspace?.listRunManifests) {
      this.#dispatch(RESEARCH_UI_EVENTS.participantStates, participantStateDetail(
        ids.map((participantId) => ({ participantId, state: "Available" })),
      ));
      return false;
    }
    const [journalRows, listedAttempts, manifestAudit] = await Promise.all([
      this.journal.participantStates(settings.experiment.id, ids, {
        workspaceId: workspace.workspaceId,
      }),
      this.journal.listAttempts({ experimentId: settings.experiment.id }),
      workspace.listRunManifests(settings.experiment.id),
    ]);
    if (generation !== this.manifestRefresh) return false;
    const attempts = listedAttempts.filter((attempt) => attempt.context?.workspaceId === workspace.workspaceId);
    const { manifests, issues } = manifestAudit;
    this.workspaceManifests = [...manifests];
    this.manifestReady = issues.length === 0;
    this.#dispatch(RESEARCH_UI_EVENTS.capabilityStatus, {
      manifestReady: this.manifestReady,
      manifestError: issues[0]?.message ?? "",
    });
    if (issues.length > 0) {
      throw new Error(`Workspace output manifest audit failed: ${issues[0].message}`);
    }
    const rows = mergeParticipantStateRows(journalRows, manifests, ids);
    const recoverableByParticipant = Object.fromEntries(ids.map((participantId) => [
      participantId,
      attempts.some((attempt) => attempt.participantId === participantId
        && attempt.status === "partial" && attempt.recoverable === true),
    ]));
    this.#dispatch(RESEARCH_UI_EVENTS.participantStates, participantStateDetail(rows, {
      recoverableByParticipant,
    }));
    return true;
  }

  async refreshStorageReadiness(settings = this.root.researchUi?.settings, plan = this.root.researchUi?.plan, {
    requestPersistence = false,
    verifyWorkspaceWrite = false,
  } = {}) {
    const estimate = estimateResearchStorageUse(settings, plan);
    const requiredBytes = estimate?.requiredBytes ?? 0;
    try {
      const result = await this.storageProbe({
        storageManager: this.storageManager,
        requestPersistence,
        requiredBytes,
      });
      const workspace = this.root.researchUi?.workspace;
      if (!workspace) this.outputWriteReady = false;
      if (verifyWorkspaceWrite) {
        if (typeof workspace?.probeOutputWriteReadiness !== "function") {
          throw new Error("The selected workspace cannot perform the required output write probe.");
        }
        const writeProbe = await workspace.probeOutputWriteReadiness();
        this.outputWriteReady = writeProbe?.writeReady === true;
      }
      this.storageReadiness = Object.freeze({ ...result, writeReady: this.outputWriteReady });
      this.#dispatch(RESEARCH_UI_EVENTS.capabilityStatus, {
        storageReady: result.sufficient && this.outputWriteReady,
        storageReadiness: this.storageReadiness,
      });
      return this.storageReadiness;
    } catch (error) {
      this.storageReadiness = null;
      this.#dispatch(RESEARCH_UI_EVENTS.capabilityStatus, { storageReady: false });
      this.#showSetupError(error);
      return null;
    }
  }

  destroy() {
    for (const [target, type, listener, options] of this.listeners) {
      target.removeEventListener(type, listener, options);
    }
    this.listeners = [];
    this.#clearMedia();
    void this.controller?.interrupt("runtime-destroyed");
    this.lease?.release();
    this.lease = null;
    void this.journal.close?.();
  }

  #bind() {
    this.#listen(this.root, RESEARCH_UI_EVENTS.planReady, (event) => {
      void this.refreshParticipantStates(event.detail?.settings).catch((error) => this.#showSetupError(error));
      void this.refreshStorageReadiness(event.detail?.settings, event.detail?.plan)
        .catch((error) => this.#showSetupError(error));
    });
    this.#listen(this.root, RESEARCH_UI_EVENTS.workspaceReady, () => {
      this.outputWriteReady = false;
      void this.refreshParticipantStates().catch((error) => this.#showSetupError(error));
      void this.refreshStorageReadiness(undefined, undefined, {
        requestPersistence: true,
        verifyWorkspaceWrite: true,
      })
        .catch((error) => this.#showSetupError(error));
    });
    this.#listen(this.root, RESEARCH_UI_EVENTS.startRequest, (event) => {
      event.preventDefault();
      this.#queue(() => this.#start(event.detail));
    });
    this.#listen(this.root, RESEARCH_UI_EVENTS.pauseRequest, () => this.#queue(() => this.#togglePause()));
    this.#listen(this.root, RESEARCH_UI_EVENTS.stopEarlyRequest, () => this.#queue(() => this.#stopEarly()));
    this.#listen(this.root, RESEARCH_UI_EVENTS.continueRequest, () => this.#queue(() => this.#continueTransition({ directGesture: true })));
    this.#listen(this.root, RESEARCH_UI_EVENTS.inputTestState, (event) => this.#acceptAffect(event.detail));
    if (RESEARCH_UI_EVENTS.inputEdge) {
      this.#listen(this.root, RESEARCH_UI_EVENTS.inputEdge, (event) => this.#acceptInputEdge(event.detail));
    }
    const video = this.#video();
    this.#listen(video, "ended", () => this.#queue(() => this.#completeCurrentStimulus()));
    for (const type of ["waiting", "stalled"]) {
      this.#listen(video, type, () => {
        if (this.run?.activeStimulus) this.#queue(() => this.#pauseForBuffering());
      });
    }
    this.#listen(video, "playing", () => {
      if (this.run?.bufferPaused) this.#queue(() => this.#resumeAfterBuffering());
    });
    this.#listen(video, "error", () => {
      if (this.run) this.#queue(() => this.#interrupt("video-playback-failed"));
    });
    if (this.document?.addEventListener) {
      this.#listen(this.document, "visibilitychange", () => {
        if (this.document.visibilityState === "hidden" && this.run && !this.controller?.snapshot().paused) {
          this.#queue(() => this.#pauseForVisibilityLoss());
        }
      });
    }
    if (this.window?.addEventListener) {
      this.#listen(this.window, "pagehide", () => {
        if (this.run) void this.controller?.interrupt("page-hidden");
      });
    }
  }

  #listen(target, type, listener, options) {
    target?.addEventListener(type, listener, options);
    this.listeners.push([target, type, listener, options]);
  }

  #queue(operation) {
    this.operation = this.operation.then(operation, operation).catch((error) => {
      this.#showRuntimeError(error);
    });
    return this.operation;
  }

  async #start(detail) {
    if (!this.ready) throw new Error("The browser recovery journal or timing worker is not ready.");
    if (this.run) throw new Error("A Research attempt is already active.");
    const workspace = this.root.researchUi?.workspace;
    if (!workspace) throw new Error("Select and authorize a workspace before Start.");
    const settings = detail?.settings;
    const plan = detail?.resolvedPlan;
    const participantId = detail?.participantId;
    const manifestReady = await this.refreshParticipantStates(settings);
    if (!manifestReady || !this.manifestReady) {
      throw new Error("Output manifests must pass a fresh audit immediately before Start.");
    }
    const storageReadiness = await this.refreshStorageReadiness(settings, plan, { verifyWorkspaceWrite: true });
    if (!storageReadiness?.sufficient || storageReadiness.writeReady !== true) {
      throw new Error("The browser storage write/quota probe does not cover this resolved plan.");
    }
    const preflight = Object.freeze({ ...detail.preflight, manifestReady: true, storageReady: true });
    assertFreshYouTubePreflights(
      plan,
      (stimulusId) => this.root.researchUi?.getYouTubePreflight?.(stimulusId),
      { now: this.epochNow() },
    );
    const listedAttempts = await this.journal.listAttempts({ experimentId: settings.experiment.id });
    const attempts = listedAttempts.filter((attempt) => attempt.context?.workspaceId === workspace.workspaceId);
    const disposition = detail?.attemptDisposition ?? "resume-compatible";
    if (!["resume-compatible", "new-attempt"].includes(disposition)) {
      throw new TypeError("Start requires an explicit recovery or new-attempt disposition.");
    }
    const recovery = disposition === "resume-compatible" ? selectCompatibleRecovery(attempts, {
      participantId,
      settingsSha256: detail.settingsSha256,
      assignmentPlanSha256: plan.planHashSha256,
      workspaceId: workspace.workspaceId,
    }) : null;
    if (disposition === "resume-compatible" && !recovery
      && (attempts.some((attempt) => attempt.participantId === participantId
        && attempt.status === "partial")
        || this.workspaceManifests.some((manifest) => manifest.participantId === participantId
          && manifest.completionStatus === "partial"))) {
      throw new Error("This participant has no recoverable partial attempt compatible with the current settings and plan. Choose Start a new attempt explicitly.");
    }
    const controller = this.controllerFactory({ workspace });
    await controller.initialize();
    this.controller = controller;
    this.#listen(controller, "statuschange", (event) => this.#projectControllerStatus(event.detail));
    this.#listen(controller, "runtimeerror", (event) => this.#showRuntimeError(
      event.detail?.error ?? new Error(`Runtime failure: ${event.detail?.code ?? "unknown"}.`),
    ));
    let snapshot;
    let frozenSettings = settings;
    let frozenPlan = plan;
    if (recovery) {
      snapshot = await controller.resume({ runId: recovery.runId });
      frozenSettings = recovery.context.settings;
      frozenPlan = recovery.context.plan;
    } else {
      snapshot = await controller.start({
        settings,
        plan,
        participantId,
        participant: detail.participant,
        attemptNumber: nextAttemptNumber(attempts, participantId, this.workspaceManifests),
        preflight,
      });
    }
    const assignment = frozenPlan.assignments.find((candidate) => candidate.participantId === participantId);
    this.run = {
      settings: frozenSettings,
      plan: frozenPlan,
      assignment,
      participantId,
      x: 0,
      y: 0,
      inputActive: false,
      activeStimulus: null,
      transitionPending: false,
      transitionCompleted: false,
      initialReady: false,
      preparedStimulus: null,
      mediaKind: null,
      bufferPaused: false,
      operatorPaused: false,
    };
    if (snapshot.finalizationPending) {
      try {
        const receipt = await controller.finalizePendingOutput();
        await this.#finishUi(receipt);
      } catch (error) {
        await this.#recoverFromFinalizationFailure(error);
      }
      return;
    }
    this.root.researchUi?.resetAffect?.("attempt-start");
    try {
      await this.#prepareStimulus(snapshot.safeStimulusIndex);
    } catch (error) {
      this.#clearMedia();
      await this.controller.interrupt("stimulus-preparation-failed");
      this.run = null;
      this.controller = null;
      await this.refreshParticipantStates(settings);
      throw new Error("The first stimulus could not be prepared; the attempt remains recoverable.", { cause: error });
    }
    this.#dispatch(RESEARCH_UI_EVENTS.runStarted, snapshot);
    this.run.initialReady = true;
    this.run.transitionPending = true;
    this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
      stimulus: "Ready to begin",
      timing: "Stopped",
      write: "Attempt frozen · journal active",
      lsl: "Off · browser",
      transitionActive: true,
      transitionMode: "continueWhenReady",
      transitionMessage: recovery
        ? "Recovery is ready at the last safe boundary. Begin the restarted video from its beginning."
        : "The attempt is frozen and the first complete video is ready. Begin when ready.",
      x: 0,
      y: 0,
    });
  }

  async #playStimulus(index) {
    if (!this.run) return;
    await this.#prepareStimulus(index);
    await this.#beginPreparedStimulus();
  }

  async #prepareStimulus(index) {
    if (!this.run) return;
    const slot = this.run.assignment.slots[index];
    if (!slot) throw new RangeError("The resolved assignment has no stimulus at this position.");
    const stimulus = this.run.plan.stimuli.find((candidate) => candidate.stimulusId === slot.stimulusId);
    if (stimulus.source.kind === "youtube") {
      this.#releaseObjectUrl();
      this.#clearYouTubePlayer();
      const video = this.#video();
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.hidden = true;
      const placeholder = this.root.querySelector?.("#run-stimulus-placeholder");
      if (placeholder) placeholder.hidden = true;
      const host = this.#youtubeHost();
      host.hidden = false;
      host.inert = true;
      host.dataset.prepared = "true";
      this.youtubeAdapter = this.youtubeAdapterFactory(host);
      if (!(this.youtubeAdapter instanceof EventTarget)
        || typeof this.youtubeAdapter.prepare !== "function"
        || typeof this.youtubeAdapter.playFromGesture !== "function") {
        throw new TypeError("The experimental YouTube player adapter is invalid.");
      }
      this.#listenToYouTubePlayer(this.youtubeAdapter);
      const observed = await this.youtubeAdapter.prepare(stimulus.source.videoId);
      if (observed.videoId !== stimulus.source.videoId
        || observed.observedTitle !== stimulus.source.observedTitle
        || observed.observedDurationMs !== stimulus.source.observedDurationMs) {
        this.#clearYouTubePlayer();
        throw new Error("The YouTube title, duration, or video ID changed after the successful preflight. Preflight the source again before Start.");
      }
      this.run.mediaKind = "youtube";
      this.run.preparedStimulus = { index, stimulus };
      this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
        stimulus: `${index + 1}/${this.run.assignment.slots.length} · ${stimulus.title} · ready (experimental YouTube; unverified and qualification excluded)`,
        timing: "Stopped",
      });
      return;
    }
    const playable = await this.#resolvePlayable(stimulus);
    this.#clearYouTubePlayer();
    this.#releaseObjectUrl();
    this.objectUrl = playable.revoke ? playable.url : null;
    const video = this.#video();
    video.pause();
    video.src = playable.url;
    video.hidden = false;
    const placeholder = this.root.querySelector?.("#run-stimulus-placeholder");
    if (placeholder) placeholder.hidden = true;
    video.load();
    if (video.readyState < 1) await once(video, "loadedmetadata");
    this.run.mediaKind = "local";
    this.run.preparedStimulus = { index, stimulus };
    this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
      stimulus: `${index + 1}/${this.run.assignment.slots.length} · ${stimulus.title} · ready`,
      timing: "Stopped",
    });
  }

  async #beginPreparedStimulus({ playbackPromise = null } = {}) {
    if (!this.run?.preparedStimulus) return false;
    const prepared = this.run.preparedStimulus;
    if (this.run.mediaKind === "youtube") {
      const host = this.#youtubeHost();
      host.inert = false;
      delete host.dataset.prepared;
    }
    try {
      await (playbackPromise ?? this.#startPreparedPlayback());
    } catch (error) {
      if (this.run?.mediaKind === "youtube") {
        const host = this.#youtubeHost();
        host.inert = true;
        host.dataset.prepared = "true";
      }
      if (error?.name === "NotAllowedError" || error?.code === "youtube-state-timeout") {
        this.run.transitionPending = true;
        this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
          timing: "Stopped",
          transitionActive: true,
          transitionMode: "continueWhenReady",
          transitionMessage: "Browser playback needs a direct gesture. Begin this video when ready.",
        });
        return false;
      }
      await this.#interrupt("playback-start-failed");
      throw new Error("Video playback could not start; the partial attempt remains recoverable.", { cause: error });
    }
    try {
      await this.controller.startStimulus(prepared.index);
    } catch (error) {
      this.#pauseCurrentMedia();
      if (this.run?.mediaKind === "youtube") {
        const host = this.#youtubeHost();
        host.inert = true;
        host.dataset.prepared = "true";
      }
      await this.#interrupt("authoritative-stimulus-start-failed");
      throw new Error("Authoritative stimulus start failed; playback was stopped and the partial remains recoverable.", { cause: error });
    }
    this.run.preparedStimulus = null;
    this.run.bufferPaused = false;
    this.run.operatorPaused = false;
    this.run.transitionPending = false;
    this.run.transitionCompleted = false;
    this.run.initialReady = false;
    this.run.activeStimulus = prepared;
    this.#updateAuthoritativeState();
    this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
      stimulus: `${prepared.index + 1}/${this.run.assignment.slots.length} · ${prepared.stimulus.title}`,
      timing: `${this.run.settings.experiment.samplingFrequencyHz} Hz sampling`,
      write: "Authoritative journal active",
      lsl: "Off · browser",
      transitionActive: false,
      x: this.run.x,
      y: this.run.y,
    });
    this.#startMediaClock();
    return true;
  }

  #startPreparedPlayback() {
    if (this.run?.mediaKind === "youtube") return this.youtubeAdapter.playFromGesture();
    return this.#video().play();
  }

  async #resolvePlayable(stimulus) {
    const source = stimulus.source;
    if (source.kind === "youtube") throw new TypeError("YouTube sources use the isolated IFrame player adapter.");
    let blob;
    if (source.kind === "workspaceFile") {
      blob = await this.root.researchUi.workspace.openStimulusFile(source.relativePath);
    } else {
      if (!this.fetchObject) throw new Error("Repository stimulus fetch is unavailable.");
      const response = await this.fetchObject(new URL(source.relativePath, this.document.baseURI), { cache: "no-store" });
      if (!response.ok) throw new Error(`Repository stimulus returned HTTP ${response.status}.`);
      blob = await response.blob();
    }
    await verifyBlobAgainstSource(blob, source);
    if (!this.createObjectURL) throw new Error("Local media object URLs are unavailable.");
    return { url: this.createObjectURL(blob), revoke: true };
  }

  #acceptAffect(detail = {}) {
    if (!this.run || !this.controller) return;
    this.run.x = Number(detail.x) || 0;
    this.run.y = Number(detail.y) || 0;
    this.run.inputActive = detail.inputActive === true;
    try {
      this.#updateAuthoritativeState();
      this.#dispatch(RESEARCH_UI_EVENTS.runStatus, { x: this.run.x, y: this.run.y });
    } catch {
      // A terminal transition can race one final input release; no sample is fabricated.
    }
  }

  #acceptInputEdge(detail = {}) {
    if (!this.run || !this.controller || detail.mode !== "run") return;
    try {
      this.controller.queueInputEdge(detail);
    } catch {
      // The run may have crossed a terminal boundary before this browser event arrived.
    }
  }

  #updateAuthoritativeState() {
    if (!this.run || !this.controller) return;
    this.controller.updateAffect({
      currentValence: this.run.x,
      currentArousal: this.run.y,
      targetValence: this.run.x,
      targetArousal: this.run.y,
      inputActive: this.run.inputActive,
      mediaTimeMs: this.#currentMediaTimeMs(),
    });
  }

  #startMediaClock() {
    this.#stopMediaClock();
    this.mediaClockTimer = setInterval(() => {
      try { this.#updateAuthoritativeState(); } catch { /* Terminal boundary. */ }
    }, MEDIA_CLOCK_UPDATE_MS);
  }

  #stopMediaClock() {
    if (this.mediaClockTimer !== null) clearInterval(this.mediaClockTimer);
    this.mediaClockTimer = null;
  }

  async #togglePause() {
    if (!this.run?.activeStimulus) return;
    if (this.controller.snapshot().paused) {
      if (this.run.mediaKind === "youtube") await this.youtubeAdapter.playFromGesture();
      else await this.#video().play();
      await this.controller.resumeStimulus(this.#currentMediaTimeMs());
      this.run.operatorPaused = false;
      this.run.bufferPaused = false;
      this.#startMediaClock();
      this.#dispatch(RESEARCH_UI_EVENTS.runStatus, { paused: false, timing: `${this.run.settings.experiment.samplingFrequencyHz} Hz sampling` });
    } else {
      this.#pauseCurrentMedia();
      this.#stopMediaClock();
      await this.controller.pause(this.#currentMediaTimeMs());
      this.run.operatorPaused = true;
      this.#dispatch(RESEARCH_UI_EVENTS.runStatus, { paused: true, timing: "Paused" });
    }
  }

  async #pauseForVisibilityLoss() {
    if (!this.run?.activeStimulus || this.controller.snapshot().paused) return;
    this.#pauseCurrentMedia();
    this.#stopMediaClock();
    await this.controller.pause(this.#currentMediaTimeMs());
    this.run.operatorPaused = true;
    this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
      paused: true,
      timing: "Paused · browser hidden",
      write: "Journal safe; resume explicitly",
    });
  }

  async #pauseForBuffering() {
    if (!this.run?.activeStimulus || this.run.operatorPaused || this.controller.snapshot().paused) return;
    this.#stopMediaClock();
    await this.controller.pause(this.#currentMediaTimeMs());
    this.run.bufferPaused = true;
    this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
      paused: true,
      timing: "Stopped · buffering",
      write: "Journal active; no buffering samples",
    });
  }

  async #resumeAfterBuffering() {
    if (!this.run?.activeStimulus || !this.run.bufferPaused || this.run.operatorPaused) return;
    await this.controller.resumeStimulus(this.#currentMediaTimeMs());
    this.run.bufferPaused = false;
    this.#startMediaClock();
    this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
      paused: false,
      timing: `${this.run.settings.experiment.samplingFrequencyHz} Hz sampling`,
    });
  }

  async #pauseForPlayerState() {
    if (!this.run?.activeStimulus || this.controller.snapshot().paused) return;
    this.#stopMediaClock();
    await this.controller.pause(this.#currentMediaTimeMs());
    this.run.operatorPaused = true;
    this.run.bufferPaused = false;
    this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
      paused: true,
      timing: "Paused · player control",
      write: "Journal active; no paused-player samples",
    });
  }

  async #resumeAfterPlayerPlaying() {
    if (!this.run?.activeStimulus || !this.controller.snapshot().paused) return;
    await this.controller.resumeStimulus(this.#currentMediaTimeMs());
    this.run.operatorPaused = false;
    this.run.bufferPaused = false;
    this.#startMediaClock();
    this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
      paused: false,
      timing: `${this.run.settings.experiment.samplingFrequencyHz} Hz sampling`,
    });
  }

  #listenToYouTubePlayer(adapter) {
    const stateListener = ({ detail }) => {
      if (this.youtubeAdapter !== adapter || !this.run?.activeStimulus) return;
      if (detail?.state === "buffering") this.#queue(() => this.#pauseForBuffering());
      else if (detail?.state === "playing") this.#queue(() => this.#resumeAfterPlayerPlaying());
      else if (detail?.state === "paused") this.#queue(() => this.#pauseForPlayerState());
      else if (detail?.state === "ended") this.#queue(() => this.#completeCurrentStimulus());
    };
    const errorListener = ({ detail }) => {
      if (this.youtubeAdapter !== adapter) return;
      this.#showRuntimeError(detail?.error ?? new Error("The YouTube player failed."));
      if (this.run) this.#queue(() => this.#interrupt("video-playback-failed"));
    };
    adapter.addEventListener("statechange", stateListener);
    adapter.addEventListener("runtimeerror", errorListener);
    this.youtubeListeners.push([adapter, "statechange", stateListener], [adapter, "runtimeerror", errorListener]);
  }

  async #completeCurrentStimulus() {
    if (!this.run?.activeStimulus) return;
    this.#stopMediaClock();
    const completed = this.run.activeStimulus;
    await this.controller.completeStimulus(this.#currentMediaTimeMs());
    this.run.activeStimulus = null;
    this.run.bufferPaused = false;
    this.run.operatorPaused = false;
    this.#releaseObjectUrl();
    if (this.run.mediaKind === "youtube") this.#clearYouTubePlayer();
    else {
      const video = this.#video();
      video.removeAttribute("src");
      video.load();
      video.hidden = true;
    }
    this.run.mediaKind = null;
    if (completed.index + 1 >= this.run.assignment.slots.length) {
      try {
        const receipt = await this.controller.complete();
        await this.#finishUi(receipt);
      } catch (error) {
        await this.#recoverFromFinalizationFailure(error);
      }
      return;
    }
    const transitionStartedAt = this.epochNow();
    const transition = await this.controller.beginTransition();
    this.run.transitionPending = true;
    this.run.transitionCompleted = false;
    if (this.root.researchUi?.resetAffect) this.root.researchUi.resetAffect("safe-boundary");
    else this.root.researchUi?.setAffect(0, 0, "Neutral between videos.");
    await this.#prepareStimulus(completed.index + 1);
    const message = transition.mode === "continueWhenReady"
      ? "Sampling is stopped and the rating is neutral. Continue when ready."
      : `Sampling is stopped and the rating is neutral. Next video in ${(transition.durationMs / 1_000).toFixed(1)} seconds.`;
    this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
      stimulus: "Between videos",
      timing: "Stopped",
      transitionActive: true,
      transitionMode: transition.mode,
      transitionMessage: message,
      x: 0,
      y: 0,
    });
    if (transition.durationMs !== null) {
      const elapsedMs = Math.max(0, this.epochNow() - transitionStartedAt);
      const remainingMs = Math.max(0, transition.durationMs - elapsedMs);
      this.transitionTimer = setTimeout(() => this.#queue(() => this.#continueTransition()), remainingMs);
    }
  }

  async #continueTransition({ directGesture = false } = {}) {
    if (!this.run?.transitionPending) return;
    if (this.transitionTimer !== null) clearTimeout(this.transitionTimer);
    this.transitionTimer = null;
    if (this.run.initialReady) {
      if (!directGesture) return;
      this.run.transitionPending = false;
      await this.#beginPreparedStimulus();
      return;
    }
    if (!this.run.transitionCompleted) {
      if (this.run.mediaKind === "youtube" && !directGesture) {
        await this.controller.completeTransition();
        this.run.transitionCompleted = true;
        this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
          stimulus: "Next experimental YouTube video ready",
          timing: "Stopped",
          transitionActive: true,
          transitionMode: "continueWhenReady",
          transitionMessage: "The configured interval is complete. Begin the prepared YouTube video when ready.",
        });
        return;
      }
      const playbackPromise = directGesture ? this.#startPreparedPlayback() : null;
      await this.controller.completeTransition();
      this.run.transitionCompleted = true;
      this.run.transitionPending = false;
      await this.#beginPreparedStimulus({ playbackPromise });
      return;
    }
    if (!directGesture) return;
    this.run.transitionPending = false;
    await this.#beginPreparedStimulus();
  }

  async #stopEarly() {
    if (!this.run) return;
    this.#clearMedia();
    try {
      const receipt = await this.controller.stopEarly();
      await this.#finishUi(receipt);
    } catch (error) {
      await this.#recoverFromFinalizationFailure(error);
    }
  }

  async #recoverFromFinalizationFailure(error) {
    if (!this.run) throw error;
    const settings = this.run.settings;
    const participantId = this.run.participantId;
    this.#clearMedia();
    this.run = null;
    this.controller = null;
    await this.refreshParticipantStates(settings);
    const message = error instanceof Error ? error.message : String(error);
    this.#dispatch(RESEARCH_UI_EVENTS.runComplete, {
      result: "output recovery required",
      participant: participantId,
      output: "No terminal receipt was committed.",
      recovery: "Select the recoverable Partial tile and Resume compatible partial to retry finalization.",
      error: message,
    });
  }

  async #interrupt(reason) {
    if (!this.run) return;
    this.#clearMedia();
    await this.controller.interrupt(reason);
    const settings = this.run.settings;
    this.run = null;
    this.controller = null;
    await this.refreshParticipantStates(settings);
  }

  async #finishUi(receipt) {
    const settings = this.run.settings;
    this.#clearMedia();
    this.run = null;
    this.controller = null;
    this.#dispatch(RESEARCH_UI_EVENTS.runComplete, {
      result: receipt.completionStatus,
      output: receipt.logicalPath,
      files: receipt.files.join(", "),
      samples: receipt.sampleCount,
      events: receipt.eventCount,
      settingsHash: receipt.settingsSha256,
      planHash: receipt.assignmentPlanSha256,
    });
    await this.refreshParticipantStates(settings);
  }

  #projectControllerStatus(snapshot) {
    if (!this.run) return;
    this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
      write: `Journal · ${snapshot.persistedSamples} samples · ${snapshot.persistedEvents} events`,
      paused: snapshot.paused,
    });
  }

  #clearMedia() {
    if (this.transitionTimer !== null) clearTimeout(this.transitionTimer);
    this.transitionTimer = null;
    this.#stopMediaClock();
    const video = this.#video();
    video.pause?.();
    video.removeAttribute?.("src");
    video.load?.();
    video.hidden = true;
    this.#clearYouTubePlayer();
    this.#releaseObjectUrl();
  }

  #currentMediaTimeMs() {
    if (this.run?.mediaKind === "youtube") return this.youtubeAdapter?.currentTimeMs?.() ?? 0;
    const currentTime = Number(this.#video().currentTime);
    return Number.isFinite(currentTime) && currentTime >= 0 ? currentTime * 1_000 : 0;
  }

  #pauseCurrentMedia() {
    if (this.run?.mediaKind === "youtube") this.youtubeAdapter?.pause?.();
    else this.#video().pause?.();
  }

  #clearYouTubePlayer() {
    for (const [target, type, listener] of this.youtubeListeners) {
      target.removeEventListener(type, listener);
    }
    this.youtubeListeners = [];
    this.youtubeAdapter?.destroy?.();
    this.youtubeAdapter = null;
    const host = this.root.querySelector?.("#run-youtube-player");
    host?.replaceChildren?.();
    if (host) {
      host.hidden = true;
      host.inert = false;
      delete host.dataset?.prepared;
    }
  }

  #releaseObjectUrl() {
    if (this.objectUrl && this.revokeObjectURL) this.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  #video() {
    const video = this.root.querySelector?.("#run-video");
    if (!video) throw new Error("Research run video element is missing.");
    return video;
  }

  #youtubeHost() {
    const host = this.root.querySelector?.("#run-youtube-player");
    if (!host) throw new Error("Research run YouTube player host is missing.");
    return host;
  }

  #dispatch(type, detail) {
    this.root.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #showSetupError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = this.root.querySelector?.("#start-status");
    if (status) status.textContent = message;
  }

  #showRuntimeError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (this.run) {
      this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
        stimulus: "Stopped by error",
        timing: "Stopped",
        write: message,
      });
    } else this.#showSetupError(error);
  }
}

async function bootRuntimeBridge() {
  const root = document.querySelector("#research-app[data-research-surface=\"browser\"]");
  if (!root) return;
  if (!root.researchUi) await delay(0);
  const bridge = new BrowserResearchRuntimeBridge(root);
  root.researchRuntime = bridge;
  await bridge.initialize();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void bootRuntimeBridge(), { once: true });
  } else {
    void bootRuntimeBridge();
  }
}

export { RUNTIME_LOCK_NAME };
