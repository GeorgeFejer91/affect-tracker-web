import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import {
  INPUT_PRESET_OPTIONS,
  RESEARCH_UI_EVENTS,
  estimateResearchStorageUse,
} from "./app.js";

const STATUS_POLL_MS = 100;
const DECODE_PROBE_MS = 80;

export function nativeInputPresetAvailability(capability) {
  const supported = new Set(capability?.supportedPresets ?? []);
  return Object.freeze(Object.fromEntries(INPUT_PRESET_OPTIONS.map(({ id, contractId }) => [
    id,
    capability?.nativeAuthorityReady === true && supported.has(contractId),
  ])));
}

export function nativeInputBindingSupported(binding, capability) {
  if (capability?.nativeAuthorityReady !== true || binding?.kind !== "digital") return false;
  if (!(capability.supportedPresets ?? []).includes(binding.preset)) return false;
  return Object.values(binding.directions ?? {}).every((token) => (
    token?.kind === "keyboard" || token?.kind === "mouseButton" || token?.kind === "wheel"
  ));
}

export function nativeInputRegionRequest(element, purpose, layoutEpoch, windowObject = globalThis.window) {
  const bounds = element?.getBoundingClientRect?.();
  const viewportWidth = Number(windowObject?.innerWidth);
  const viewportHeight = Number(windowObject?.innerHeight);
  if (!bounds || [bounds.left, bounds.top, bounds.right, bounds.bottom, bounds.width, bounds.height]
    .some((value) => !Number.isFinite(value))
    || !Number.isInteger(layoutEpoch) || layoutEpoch < 1
    || bounds.width < 8 || bounds.height < 8
    || !Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)
    || bounds.left < 0 || bounds.top < 0
    || bounds.right > viewportWidth + 0.5 || bounds.bottom > viewportHeight + 0.5) {
    throw new Error("The visible native input allow-region is unavailable.");
  }
  return Object.freeze({
    purpose,
    layoutEpoch,
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
    viewportWidth,
    viewportHeight,
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function messageOf(error) {
  if (error instanceof Error) return error.message;
  if (typeof error?.message === "string") return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

function once(target, type, { timeoutMs = 15_000, failureTypes = ["error"] } = {}) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      target.removeEventListener(type, success);
      for (const failureType of failureTypes) target.removeEventListener(failureType, failure);
    };
    const success = (event) => { cleanup(); resolve(event); };
    const failure = () => { cleanup(); reject(new Error(`Native media failed before ${type}.`)); };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for native media ${type}.`));
    }, timeoutMs);
    target.addEventListener(type, success, { once: true });
    for (const failureType of failureTypes) target.addEventListener(failureType, failure, { once: true });
  });
}

function safeStimulusId(summary) {
  const suffix = String(summary.workspaceFileId ?? "")
    .replace(/[^A-Za-z0-9._-]/gu, "-")
    .slice(0, 110);
  if (!suffix) throw new TypeError("Native stimulus summary has no opaque workspace file ID.");
  return `workspace-${suffix}`;
}

export function participantStateDetail(rows) {
  const detail = Object.fromEntries((rows ?? []).map(({ participantId, state }) => [
    participantId,
    String(state).toLowerCase(),
  ]));
  detail.__recoverable = Object.freeze(Object.fromEntries((rows ?? []).map(({ participantId, recoverable }) => [
    participantId,
    recoverable === true,
  ])));
  return Object.freeze(detail);
}

export function authorizeDesktopPlaybackMode(requestedMode, capability) {
  const playbackMode = requestedMode ?? "nativeLibvlc";
  if (playbackMode === "unqualifiedWebview") return playbackMode;
  if (playbackMode !== "nativeLibvlc") throw new TypeError("Unknown Windows playback mode.");
  if (capability?.qualifiedStartAvailable !== true || capability?.playerActorReady !== true) {
    throw new Error(`Qualified native playback is unavailable (${capability?.reasonCode ?? "capability not reported"}). Select WebView video explicitly only for unqualified testing.`);
  }
  return playbackMode;
}

export function mediaFailureReport({ mediaErrorCode, stimulusId, stimulusPosition, mediaTimeMs }) {
  const reason = ({ 1: "aborted", 2: "network", 3: "decode", 4: "sourceNotSupported" })[mediaErrorCode] ?? "unknown";
  if (!stimulusId || !Number.isInteger(stimulusPosition) || stimulusPosition < 1) {
    throw new TypeError("A media failure must bind the active opaque stimulus position.");
  }
  return Object.freeze({
    reason,
    stimulusId,
    stimulusPosition,
    mediaTimeMs: Math.max(0, Number(mediaTimeMs) || 0),
  });
}

function stimulusUpdate(lifecycle, stimulus, position, mediaTimeMs = 0) {
  return Object.freeze({
    lifecycle,
    stimulusId: stimulus.stimulusId,
    stimulusPosition: position,
    mediaTimeMs: Math.max(0, Number(mediaTimeMs) || 0),
  });
}

export async function probeAndAttestNativeVideo({
  invoke,
  workspaceId,
  summary,
  videoFactory = () => document.createElement("video"),
  performanceNow = () => performance.now(),
} = {}) {
  if (summary.decodeStatus === "verified" && summary.source) return summary;
  const receipt = await invoke("research_workspace_media_url", {
    workspaceId,
    workspaceFileId: summary.workspaceFileId,
    sha256: summary.sha256,
    byteLength: summary.byteLength,
    mimeType: summary.mimeType,
  });
  const video = videoFactory();
  if (!video?.addEventListener || typeof video.play !== "function") {
    throw new TypeError("The native decode probe requires an HTML video element.");
  }
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = receipt.mediaUrl;
  try {
    const metadata = once(video, "loadedmetadata");
    video.load?.();
    await metadata;
    if (!Number.isFinite(video.duration) || video.duration <= 0
      || !Number.isInteger(video.videoWidth) || video.videoWidth <= 0
      || !Number.isInteger(video.videoHeight) || video.videoHeight <= 0) {
      throw new Error("Native media metadata does not prove a decodable complete video.");
    }
    const decodedFrame = typeof video.requestVideoFrameCallback === "function"
      ? new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Native media produced no decoded frame.")), 5_000);
        video.requestVideoFrameCallback(() => { clearTimeout(timeout); resolve(); });
      })
      : null;
    const started = performanceNow();
    await video.play();
    await delay(DECODE_PROBE_MS);
    if (decodedFrame) await decodedFrame;
    const mutedPlaybackMs = Math.max(50, Math.min(5_000, performanceNow() - started));
    return invoke("research_attest_workspace_decode", {
      attestation: {
        workspaceId,
        mediaGrantId: receipt.mediaGrantId,
        workspaceFileId: summary.workspaceFileId,
        sha256: summary.sha256,
        byteLength: summary.byteLength,
        mimeType: summary.mimeType,
        observedDurationMs: video.duration * 1_000,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        mutedPlaybackMs,
      },
    });
  } finally {
    video.pause?.();
    video.removeAttribute?.("src");
    video.load?.();
  }
}

export class NativeResearchRuntimeBridge {
  constructor(root, {
    invoke = tauriInvoke,
    documentObject = globalThis.document,
    windowObject = globalThis.window,
    setIntervalObject = globalThis.setInterval?.bind(globalThis),
    clearIntervalObject = globalThis.clearInterval?.bind(globalThis),
    videoFactory,
  } = {}) {
    if (!(root instanceof EventTarget)) throw new TypeError("Native bridge requires the Research root event target.");
    this.root = root;
    this.invoke = invoke;
    this.document = documentObject;
    this.window = windowObject;
    this.setInterval = setIntervalObject;
    this.clearInterval = clearIntervalObject;
    this.videoFactory = videoFactory;
    this.workspace = null;
    this.sourceCapabilities = null;
    this.nativeMediaCapability = null;
    this.nativeInputCapability = null;
    this.catalog = new Map();
    this.recoveries = [];
    this.participantStateById = new Map();
    this.storageReadiness = null;
    this.run = null;
    this.pollTimer = null;
    this.inputPollTimer = null;
    this.inputLayoutEpoch = 0;
    this.lastCaptureId = null;
    this.listeners = [];
    this.operation = Promise.resolve();
  }

  async initialize() {
    this.#bind();
    try {
      const [workspace, sourceCapabilities, nativeMediaCapability, inputCapability, inputStatus, status] = await Promise.all([
        this.invoke("research_workspace_status"),
        this.invoke("research_source_capabilities"),
        this.invoke("research_native_media_capability"),
        this.invoke("research_input_capability"),
        this.invoke("research_input_status"),
        this.invoke("research_run_status"),
      ]);
      this.sourceCapabilities = sourceCapabilities;
      this.nativeMediaCapability = nativeMediaCapability;
      this.nativeInputCapability = inputCapability;
      this.#applySourceCapabilities();
      this.#applyInputCapability();
      this.root.researchUi?.applyNativeInputStatus?.(inputStatus);
      this.#dispatch(RESEARCH_UI_EVENTS.capabilityStatus, {
        indexedDbReady: true,
        timingWorkerReady: true,
        lslReady: false,
        manifestReady: false,
        storageReady: false,
        repositoryAssetsReady: sourceCapabilities?.repositoryAsset?.supported === true,
        nativePlaybackReady: nativeMediaCapability?.qualifiedStartAvailable === true
          && nativeMediaCapability?.playerActorReady === true,
        nativeMediaCapability,
        nativeInputReady: inputCapability?.nativeAuthorityReady === true,
        nativeInputPresetReady: nativeInputBindingSupported(this.root.researchUi?.inputBinding, inputCapability),
      });
      this.#startInputPolling();
      if (workspace?.selected) await this.#adoptWorkspace(workspace, { rescan: true });
      if (status?.active) {
        this.#showSetupError("A native attempt is already active. Restart Affect Research to reconcile it as a recoverable partial before selecting another participant.");
      }
    } catch (error) {
      this.#showSetupError(error);
      this.#dispatch(RESEARCH_UI_EVENTS.capabilityStatus, {
        timingWorkerReady: false,
        manifestReady: false,
        storageReady: false,
      });
    }
    return this;
  }

  destroy() {
    for (const [target, type, listener, options] of this.listeners) {
      target.removeEventListener(type, listener, options);
    }
    this.listeners = [];
    this.#stopPolling();
    this.#stopInputPolling();
    this.#clearVideo();
  }

  #bind() {
    this.#listen(this.root, RESEARCH_UI_EVENTS.selectWorkspaceRequest, (event) => {
      event.preventDefault();
      this.#queue(() => this.#chooseWorkspace());
    });
    this.#listen(this.root, RESEARCH_UI_EVENTS.rescanWorkspaceRequest, (event) => {
      event.preventDefault();
      this.#queue(() => this.#rescanWorkspace());
    });
    this.#listen(this.root, RESEARCH_UI_EVENTS.importVideosRequest, (event) => {
      event.preventDefault();
      this.#queue(() => this.#importStimuli(event.detail?.recursiveDirectory === true ? "folder" : "videos"));
    });
    this.#listen(this.root, RESEARCH_UI_EVENTS.loadSettingsRequest, (event) => {
      event.preventDefault();
      this.#queue(() => this.#loadSettings());
    });
    this.#listen(this.root, RESEARCH_UI_EVENTS.saveSettingsRequest, (event) => {
      event.preventDefault();
      this.#queue(() => this.#saveSettings(event.detail));
    });
    this.#listen(this.root, RESEARCH_UI_EVENTS.exportPlanRequest, (event) => {
      event.preventDefault();
      this.#queue(() => this.#exportPlan(event.detail));
    });
    this.#listen(this.root, RESEARCH_UI_EVENTS.planReady, (event) => {
      this.#queue(async () => {
        await Promise.all([
          this.#refreshParticipantStates(event.detail?.settings),
          this.#refreshReadiness(event.detail?.settings, event.detail?.plan),
        ]);
      });
    });
    this.#listen(this.root, RESEARCH_UI_EVENTS.workspaceReady, () => {
      if (this.workspace) this.#queue(() => this.#refreshParticipantStates());
    });
    this.#listen(this.root, RESEARCH_UI_EVENTS.startRequest, (event) => {
      event.preventDefault();
      this.#queue(() => this.#start(event.detail));
    });
    this.#listen(this.root, RESEARCH_UI_EVENTS.pauseRequest, () => this.#queue(() => this.#togglePause()));
    this.#listen(this.root, RESEARCH_UI_EVENTS.stopEarlyRequest, () => this.#queue(() => this.#finish("stopEarly")));
    this.#listen(this.root, RESEARCH_UI_EVENTS.continueRequest, () => this.#queue(() => this.#continueRun({ directGesture: true })));
    this.#listen(this.root, RESEARCH_UI_EVENTS.inputBindingChanged, (event) => {
      this.#queue(() => this.#beginNativeInputTest(event.detail?.binding));
    });
    this.#listen(this.root, RESEARCH_UI_EVENTS.inputCaptureRequest, (event) => {
      event.preventDefault();
      this.#queue(() => this.#beginNativeCapture(event.detail));
    });
    this.#listen(this.root, RESEARCH_UI_EVENTS.inputCaptureCancel, () => {
      this.#queue(() => this.invoke("research_input_cancel_setup"));
    });
    this.#listen(this.window, "resize", () => {
      this.#queue(() => this.#refreshNativeInputRegion());
    });
    this.#listen(this.root, "change", (event) => {
      if (event.target?.id === "native-playback-mode" && this.workspace) {
        this.#queue(async () => {
          await this.#rescanWorkspace();
          await this.#refreshParticipantStates();
        });
      }
    });

    const video = this.#video();
    this.#listen(video, "ended", () => this.#queue(() => this.#completeStimulus()));
    for (const type of ["waiting", "stalled"]) {
      this.#listen(video, type, () => this.#queue(() => this.#pauseForBuffering()));
    }
    this.#listen(video, "playing", () => {
      if (this.run?.bufferPaused) this.#queue(() => this.#resumeAfterBuffering());
    });
    this.#listen(video, "error", () => {
      if (this.run) this.#queue(() => this.#interruptForMediaFailure());
    });
  }

  #applySourceCapabilities() {
    const controls = [
      ["#stimulus-add-repository", "repositoryAsset", "repository"],
      ["#stimulus-add-youtube", "youtube", "youtube"],
    ];
    const sourceSelect = this.root.querySelector?.("#stimulus-source");
    for (const [selector, capabilityKey, optionValue] of controls) {
      const selectable = this.sourceCapabilities?.[capabilityKey]?.selectionEnabled === true;
      const button = this.root.querySelector?.(selector);
      if (button) {
        button.hidden = !selectable;
        button.disabled = !selectable;
      }
      const option = sourceSelect?.querySelector?.(`option[value="${optionValue}"]`);
      if (option) {
        option.hidden = !selectable;
        option.disabled = !selectable;
      }
    }
  }

  #applyInputCapability(binding = this.root.researchUi?.inputBinding) {
    const availability = nativeInputPresetAvailability(this.nativeInputCapability);
    const select = this.root.querySelector?.("#input-preset");
    for (const option of select?.querySelectorAll?.("option") ?? []) {
      if (option.value === "custom") continue;
      const available = availability[option.value] === true;
      option.disabled = !available;
      option.title = available ? "" : "No safe native Tauri backend is available for this preset.";
    }
    const presetReady = nativeInputBindingSupported(binding, this.nativeInputCapability);
    this.#dispatch(RESEARCH_UI_EVENTS.capabilityStatus, {
      nativeInputReady: this.nativeInputCapability?.nativeAuthorityReady === true,
      nativeInputPresetReady: presetReady,
    });
    return presetReady;
  }

  async #setNativeInputRegion(selector, purpose) {
    const element = this.root.querySelector?.(selector);
    const region = nativeInputRegionRequest(
      element,
      purpose,
      ++this.inputLayoutEpoch,
      this.window,
    );
    return this.invoke("research_input_set_region", { region });
  }

  async #beginNativeInputTest(binding = this.root.researchUi?.inputBinding) {
    if (!this.#applyInputCapability(binding)) {
      await this.invoke("research_input_cancel_setup");
      return;
    }
    const grid = this.root.querySelector?.(".input-test-grid");
    if (!grid || grid.getClientRects?.().length === 0) return;
    await this.#setNativeInputRegion(".input-test-grid", "setupTest");
    const status = await this.invoke("research_input_begin_test", { binding });
    this.root.researchUi?.applyNativeInputStatus?.(status);
  }

  async #beginNativeCapture(detail) {
    const binding = detail?.binding;
    if (!this.#applyInputCapability(binding)) {
      throw new Error("This binding cannot be captured by the safe native Tauri backend.");
    }
    await this.#setNativeInputRegion("#binding-capture-dialog .dialog-content", "setupCapture");
    const status = await this.invoke("research_input_begin_capture", {
      binding,
      direction: detail.direction,
    });
    this.root.researchUi?.applyNativeInputStatus?.(status);
  }

  async #refreshNativeInputRegion() {
    if (this.run) {
      await this.#setNativeInputRegion(".run-feedback-stage", "runFeedback");
      return;
    }
    if (this.root.researchUi?.openSection === "input") {
      await this.#beginNativeInputTest();
    }
  }

  async #pollNativeInputStatus() {
    const status = await this.invoke("research_input_status");
    this.root.researchUi?.applyNativeInputStatus?.(status);
    if (status?.capture?.captureId && status.capture.captureId !== this.lastCaptureId) {
      this.lastCaptureId = status.capture.captureId;
      this.root.researchUi?.applyNativeCapture?.(status.capture);
      await this.#beginNativeInputTest(status.capture.binding);
    }
  }

  #startInputPolling() {
    this.#stopInputPolling();
    this.inputPollTimer = this.setInterval?.(() => {
      void this.#pollNativeInputStatus().catch((error) => this.#showRuntimeError(error));
    }, STATUS_POLL_MS);
  }

  #stopInputPolling() {
    if (this.inputPollTimer !== null) this.clearInterval?.(this.inputPollTimer);
    this.inputPollTimer = null;
  }

  #selectedPlaybackMode() {
    return this.root.querySelector?.("#native-playback-mode")?.value ?? "nativeLibvlc";
  }

  #listen(target, type, listener, options) {
    target?.addEventListener(type, listener, options);
    this.listeners.push([target, type, listener, options]);
  }

  #queue(operation) {
    this.operation = this.operation.then(operation, operation).catch((error) => this.#showRuntimeError(error));
    return this.operation;
  }

  async #chooseWorkspace() {
    const workspace = await this.invoke("research_choose_workspace");
    if (!workspace?.selected) return;
    await this.#adoptWorkspace(workspace, { rescan: true });
  }

  async #adoptWorkspace(workspace, { rescan = false } = {}) {
    if (!workspace?.workspaceId || workspace.librariesReady !== true) {
      throw new Error("The selected native workspace did not initialize all four Research libraries.");
    }
    this.workspace = Object.freeze({ ...workspace });
    this.catalog.clear();
    this.#dispatch(RESEARCH_UI_EVENTS.workspaceReady, {
      surface: "tauri",
      label: workspace.displayName ?? "Windows Research workspace",
      directoryPermission: true,
      workspaceId: workspace.workspaceId,
    });
    if (rescan) await this.#rescanWorkspace();
  }

  async #rescanWorkspace() {
    this.#requireWorkspace();
    const result = await this.invoke("research_rescan_stimuli", { workspaceId: this.workspace.workspaceId });
    await this.#catalogue(result);
  }

  async #importStimuli(selectionKind) {
    this.#requireWorkspace();
    const result = await this.invoke("research_import_stimuli", {
      workspaceId: this.workspace.workspaceId,
      selectionKind,
    });
    if (result) await this.#catalogue(result);
  }

  async #catalogue(result) {
    if (result?.workspaceId !== this.workspace.workspaceId || !Array.isArray(result.stimuli)) {
      throw new Error("Native stimulus scan returned an invalid workspace binding.");
    }
    const playbackMode = this.#selectedPlaybackMode();
    if (playbackMode !== "unqualifiedWebview") {
      this.catalog.clear();
      this.#dispatch(RESEARCH_UI_EVENTS.stimuliCatalogued, { items: [], replace: true });
      try {
        authorizeDesktopPlaybackMode(playbackMode, this.nativeMediaCapability);
        this.#showSetupError("The qualified native catalogue requires the native player actor adapter.");
      } catch (error) {
        this.#showSetupError(error);
      }
      return;
    }
    const nextCatalog = new Map();
    const items = [];
    const failures = [];
    for (const scanned of result.stimuli) {
      try {
        const summary = await probeAndAttestNativeVideo({
          invoke: this.invoke,
          workspaceId: this.workspace.workspaceId,
          summary: scanned,
          videoFactory: this.videoFactory,
        });
        if (summary.decodeStatus !== "verified" || !summary.source) {
          throw new Error(`${summary.displayName} did not produce a verified source contract.`);
        }
        const existing = this.root.researchUi?.settings?.stimuli?.items?.find(({ source }) => (
          source.kind === "workspaceFile" && source.relativePath === summary.source.relativePath
        ));
        const stimulusId = existing?.stimulusId ?? safeStimulusId(summary);
        const stimulus = Object.freeze({
          stimulusId,
          title: existing?.title ?? summary.displayName,
          source: Object.freeze({ ...summary.source }),
        });
        nextCatalog.set(summary.workspaceFileId, Object.freeze({ summary: Object.freeze({ ...summary }), stimulus }));
        items.push(Object.freeze({ stimulus, verified: true, workspaceFileId: summary.workspaceFileId }));
      } catch (error) {
        failures.push(`${scanned.displayName}: ${messageOf(error)}`);
      }
    }
    this.catalog = nextCatalog;
    this.#dispatch(RESEARCH_UI_EVENTS.stimuliCatalogued, { items, replace: true });
    if (failures.length > 0) throw new Error(`Native decode verification failed for ${failures.join("; ")}`);
  }

  async #loadSettings() {
    const receipt = await this.invoke("research_load_settings");
    if (!receipt) return;
    const payload = receipt.settings ?? receipt.legacySettings;
    if (!payload) throw new Error("Native settings import returned no compatible payload.");
    this.#dispatch(RESEARCH_UI_EVENTS.settingsLoaded, { settings: payload });
    if (this.workspace) await this.#rescanWorkspace();
  }

  async #saveSettings(detail) {
    this.#requireWorkspace();
    const receipt = await this.invoke("research_save_settings", {
      workspaceId: this.workspace.workspaceId,
      settings: detail.settings,
    });
    this.#announce(`${receipt.fileName} saved with hash ${receipt.settingsSha256}.`);
  }

  async #exportPlan(detail) {
    this.#requireWorkspace();
    const receipt = await this.invoke("research_export_assignment_plan", {
      workspaceId: this.workspace.workspaceId,
      settings: detail.settings,
      assignmentPlan: detail.plan,
    });
    this.#announce(`${receipt.fileName} exported with ${receipt.rowCount} rows.`);
  }

  async #refreshReadiness(settings = this.root.researchUi?.settings, plan = this.root.researchUi?.plan) {
    if (!settings || !plan || !this.workspace) return;
    const estimate = estimateResearchStorageUse(settings, plan);
    const [storage, lsl] = await Promise.all([
      this.invoke("research_storage_readiness", {
        workspaceId: this.workspace.workspaceId,
        requiredBytes: estimate.requiredBytes,
      }),
      this.invoke("research_lsl_readiness", { settings }),
    ]);
    this.storageReadiness = Object.freeze({ ...storage, persisted: true });
    this.#dispatch(RESEARCH_UI_EVENTS.capabilityStatus, {
      timingWorkerReady: true,
      storageReady: storage.sufficient === true && storage.writeReady === true,
      storageReadiness: this.storageReadiness,
      lslReady: lsl.ready === true,
    });
  }

  async #refreshParticipantStates(settings = this.root.researchUi?.settings) {
    if (!settings || !this.workspace) return;
    const [states, recoveryListing] = await Promise.all([
      this.invoke("research_participant_states", {
        workspaceId: this.workspace.workspaceId,
        settings,
      }),
      this.invoke("research_recoveries", { workspaceId: this.workspace.workspaceId }),
    ]);
    this.recoveries = Array.isArray(recoveryListing?.recoveries) ? recoveryListing.recoveries : [];
    this.participantStateById = new Map((states ?? []).map(({ participantId, state }) => [
      participantId,
      String(state).toLowerCase(),
    ]));
    const corrupt = recoveryListing?.corruptRecoveryIds ?? [];
    const plan = this.root.researchUi?.plan;
    const playbackMode = this.#selectedPlaybackMode();
    const projectedStates = (states ?? []).map((state) => ({
      ...state,
      recoverable: state.recoverable === true && this.recoveries.some((candidate) => (
        candidate.participantId === state.participantId
        && candidate.settingsSha256 === plan?.settingsSha256
        && candidate.assignmentPlanSha256 === plan?.planHashSha256
        && candidate.playbackMode === playbackMode
      )),
    }));
    this.#dispatch(RESEARCH_UI_EVENTS.capabilityStatus, {
      manifestReady: true,
      manifestError: "",
    });
    this.#dispatch(RESEARCH_UI_EVENTS.participantStates, participantStateDetail(projectedStates));
    if (corrupt.length > 0) {
      this.#announce(`${corrupt.length} corrupt recovery record${corrupt.length === 1 ? " was" : "s were"} quarantined from usable attempts.`);
    }
  }

  #workspaceBindings(plan) {
    return plan.stimuli
      .filter(({ source }) => source.kind === "workspaceFile")
      .map((stimulus) => {
        const entry = [...this.catalog.values()].find(({ summary }) => (
          summary.source?.relativePath === stimulus.source.relativePath
          && summary.sha256 === stimulus.source.sha256
          && summary.byteLength === stimulus.source.byteLength
        ));
        if (!entry) throw new Error(`Native workspace verification is stale for ${stimulus.title}. Rescan before Start.`);
        return Object.freeze({ stimulusId: stimulus.stimulusId, workspaceFileId: entry.summary.workspaceFileId });
      });
  }

  async #start(detail) {
    this.#requireWorkspace();
    if (this.run) throw new Error("A native Research attempt is already active.");
    const settings = detail?.settings;
    const plan = detail?.resolvedPlan;
    const inputTestReceiptId = detail?.inputTestReceiptId;
    if (typeof inputTestReceiptId !== "string" || inputTestReceiptId.length < 8) {
      throw new Error("A fresh native input-test receipt is required before Start or recovery Resume.");
    }
    if (!this.#applyInputCapability(settings?.input)) {
      throw new Error("The selected input binding has no safe native Tauri authority.");
    }
    const playbackMode = authorizeDesktopPlaybackMode(detail?.playbackMode, this.nativeMediaCapability);
    await Promise.all([
      this.#refreshReadiness(settings, plan),
      this.#refreshParticipantStates(settings),
    ]);
    const estimate = estimateResearchStorageUse(settings, plan);
    if (!this.storageReadiness?.sufficient || !this.storageReadiness.writeReady
      || this.storageReadiness.requiredBytes !== estimate.requiredBytes) {
      throw new Error("Native output/recovery storage does not pass the current write and capacity probe.");
    }
    const unsupported = plan.stimuli.find(({ source }) => source.kind !== "workspaceFile");
    if (unsupported) {
      throw new Error(`${unsupported.source.kind} is not qualified by the Windows native source adapter in this internal alpha.`);
    }
    const workspaceFiles = this.#workspaceBindings(plan);
    let receipt;
    if (detail.attemptDisposition === "resume-compatible") {
      const recovery = this.recoveries
        .filter((candidate) => candidate.participantId === detail.participantId
          && candidate.settingsSha256 === detail.settingsSha256
          && candidate.assignmentPlanSha256 === plan.planHashSha256
          && candidate.playbackMode === playbackMode)
        .sort((left, right) => right.attemptNumber - left.attemptNumber)[0];
      if (recovery) {
        receipt = await this.invoke("research_resume_run", {
          request: {
            workspaceId: this.workspace.workspaceId,
            recoveryId: recovery.recoveryId,
            settings,
            assignmentPlan: plan,
            workspaceFiles,
            inputTestReceiptId,
            playbackMode,
          },
        });
      }
      if (!recovery && this.participantStateById.get(detail.participantId) === "partial") {
        throw new Error("The selected participant is Partial, but no compatible native recovery record is available. Choose Start a new attempt explicitly.");
      }
    }
    if (!receipt) {
      receipt = await this.invoke("research_start_run", {
        request: {
          workspaceId: this.workspace.workspaceId,
          settings,
          assignmentPlan: plan,
          participant: { participantId: detail.participantId, ...detail.participant },
          workspaceFiles,
          rerunConfirmed: detail.rerunConfirmed === true,
          inputTestReceiptId,
          playbackMode,
        },
      });
    }
    const assignment = plan.assignments.find(({ participantId }) => participantId === receipt.participantId);
    if (!assignment) throw new Error("Native receipt participant is absent from the frozen assignment plan.");
    if (receipt.playbackMode !== playbackMode
      || receipt.playbackQualification !== (playbackMode === "nativeLibvlc" ? "qualifiedNative" : "unqualified")) {
      throw new Error("Native playback receipt does not match the explicit qualification choice.");
    }
    this.run = {
      receipt,
      settings,
      plan,
      assignment,
      index: Math.max(0, (receipt.resumeAtStimulusPosition ?? 1) - 1),
      awaitingStart: true,
      transitionActive: false,
      bufferPaused: false,
      manualPaused: false,
      lifecycleInFlight: false,
      lastStatus: null,
    };
    this.#dispatch(RESEARCH_UI_EVENTS.runStarted, receipt);
    try {
      const inputStatus = await this.#setNativeInputRegion(".run-feedback-stage", "runFeedback");
      if (inputStatus?.runReady !== true) {
        throw new Error("The native Run feedback-stage allow-region is not ready.");
      }
      await this.#prepareCurrentStimulus({ recovery: receipt.resumed === true });
    } catch (error) {
      await this.invoke("research_finish_run", { outcome: "stopEarly" }).catch(() => {});
      this.run = null;
      throw error;
    }
    this.#stopInputPolling();
    this.#startPolling();
  }

  async #prepareCurrentStimulus({ recovery = false } = {}) {
    if (this.run?.receipt?.playbackMode !== "unqualifiedWebview") {
      throw new Error("Qualified native playback cannot be projected through the WebView video element.");
    }
    const stimulus = this.#currentStimulus();
    const entry = [...this.catalog.values()].find(({ summary }) => (
      summary.source?.relativePath === stimulus.source.relativePath
      && summary.sha256 === stimulus.source.sha256
      && summary.byteLength === stimulus.source.byteLength
    ));
    if (!entry) throw new Error(`No fresh native media grant can be issued for ${stimulus.title}.`);
    const receipt = await this.invoke("research_workspace_media_url", {
      workspaceId: this.workspace.workspaceId,
      workspaceFileId: entry.summary.workspaceFileId,
      sha256: entry.summary.sha256,
      byteLength: entry.summary.byteLength,
      mimeType: entry.summary.mimeType,
    });
    const video = this.#video();
    video.pause?.();
    video.src = receipt.mediaUrl;
    video.preload = "auto";
    video.playsInline = true;
    video.hidden = false;
    const metadata = once(video, "loadedmetadata");
    video.load?.();
    await metadata;
    video.currentTime = 0;
    this.run.awaitingStart = true;
    this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
      stimulus: `${this.run.index + 1}/${this.run.assignment.slots.length} · ${stimulus.title}`,
      timing: "Sampling stopped at safe boundary",
      write: "Native recovery journal ready",
      lsl: this.run.settings.advanced.lsl.enabled ? "Ready" : "Off",
      transitionActive: true,
      transitionMode: "continueWhenReady",
      transitionMessage: recovery
        ? "Recovery is ready at the last safe boundary. Begin the restarted video from its beginning."
        : "The verified complete video is ready. Begin when ready.",
      videoUrl: receipt.mediaUrl,
    });
  }

  async #continueRun({ directGesture = false } = {}) {
    if (!this.run) return;
    if (this.run.transitionActive) {
      const status = await this.invoke("research_run_status");
      if (!status.transitionReady) return;
      const completed = this.#currentStimulus();
      await this.invoke("research_set_stimulus_state", {
        update: stimulusUpdate("transitionCompleted", completed, this.run.index + 1, 0),
      });
      this.run.transitionActive = false;
      this.run.index += 1;
      await this.#prepareCurrentStimulus();
    }
    if (!this.run.awaitingStart) return;
    try {
      const video = this.#video();
      await video.play();
      const stimulus = this.#currentStimulus();
      await this.invoke("research_set_stimulus_state", {
        update: stimulusUpdate("started", stimulus, this.run.index + 1, video.currentTime * 1_000),
      });
      this.run.awaitingStart = false;
      this.run.bufferPaused = false;
      this.#dispatch(RESEARCH_UI_EVENTS.runStatus, { transitionActive: false });
    } catch (error) {
      this.run.awaitingStart = true;
      this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
        transitionActive: true,
        transitionMode: "continueWhenReady",
        transitionMessage: directGesture
          ? `Playback could not start: ${messageOf(error)}`
          : "Windows playback needs a direct gesture. Begin this video when ready.",
      });
    }
  }

  async #completeStimulus() {
    if (!this.run || this.run.lifecycleInFlight || this.run.awaitingStart) return;
    this.run.lifecycleInFlight = true;
    try {
      const stimulus = this.#currentStimulus();
      const position = this.run.index + 1;
      const mediaTimeMs = this.#video().currentTime * 1_000;
      await this.invoke("research_set_stimulus_state", {
        update: stimulusUpdate("completed", stimulus, position, mediaTimeMs),
      });
      this.root.researchUi?.resetAffect?.("safe-boundary");
      if (position >= this.run.assignment.slots.length) {
        await this.#finish("completed");
        return;
      }
      await this.invoke("research_set_stimulus_state", {
        update: stimulusUpdate("transitionStarted", stimulus, position, mediaTimeMs),
      });
      this.run.transitionActive = true;
      const status = await this.invoke("research_run_status");
      this.#projectStatus(status);
      if (this.run.settings.experiment.betweenVideos.mode !== "continueWhenReady" && status.transitionReady) {
        await this.#continueRun();
      }
    } finally {
      if (this.run) this.run.lifecycleInFlight = false;
    }
  }

  async #togglePause() {
    if (!this.run || this.run.awaitingStart) return;
    const video = this.#video();
    const phase = this.run.lastStatus?.phase;
    const stimulus = this.#currentStimulus();
    const position = this.run.index + 1;
    if (phase === "playing") {
      video.pause();
      await this.invoke("research_set_stimulus_state", {
        update: stimulusUpdate("paused", stimulus, position, video.currentTime * 1_000),
      });
      this.run.manualPaused = true;
    } else if (phase === "paused") {
      await video.play();
      await this.invoke("research_set_stimulus_state", {
        update: stimulusUpdate("resumed", stimulus, position, video.currentTime * 1_000),
      });
      this.run.manualPaused = false;
      this.run.bufferPaused = false;
    }
  }

  async #pauseForBuffering() {
    if (!this.run || this.run.awaitingStart || this.run.bufferPaused || this.run.manualPaused) return;
    if (this.run.lastStatus?.phase !== "playing") return;
    const stimulus = this.#currentStimulus();
    await this.invoke("research_set_stimulus_state", {
      update: stimulusUpdate("paused", stimulus, this.run.index + 1, this.#video().currentTime * 1_000),
    });
    this.run.bufferPaused = true;
  }

  async #resumeAfterBuffering() {
    if (!this.run?.bufferPaused || this.run.manualPaused) return;
    const stimulus = this.#currentStimulus();
    await this.invoke("research_set_stimulus_state", {
      update: stimulusUpdate("resumed", stimulus, this.run.index + 1, this.#video().currentTime * 1_000),
    });
    this.run.bufferPaused = false;
  }

  async #finish(outcome) {
    if (!this.run) return;
    const receipt = await this.invoke("research_finish_run", { outcome });
    this.#stopPolling();
    this.#clearVideo();
    this.run = null;
    this.#startInputPolling();
    this.root.researchUi?.resetAffect?.("attempt-finished");
    this.#dispatch(RESEARCH_UI_EVENTS.runComplete, {
      status: receipt.completionStatus,
      participant: receipt.participantId,
      attempt: receipt.attemptNumber,
      receipt: receipt.outputReceiptId,
      files: receipt.files.map(({ fileName }) => fileName).join(", "),
    });
    await this.#refreshParticipantStates();
  }

  async #interruptForMediaFailure() {
    if (!this.run || this.run.mediaFailureInFlight) return;
    this.run.mediaFailureInFlight = true;
    const stimulus = this.#currentStimulus();
    const video = this.#video();
    const report = mediaFailureReport({
      mediaErrorCode: video.error?.code,
      stimulusId: stimulus.stimulusId,
      stimulusPosition: this.run.index + 1,
      mediaTimeMs: video.currentTime * 1_000,
    });
    let receipt;
    try {
      receipt = await this.invoke("research_report_media_failure", { report });
    } finally {
      this.#stopPolling();
      this.#clearVideo();
      this.run = null;
      this.#startInputPolling();
      this.root.researchUi?.resetAffect?.("media-failure-boundary");
      this.root.researchUi?.setMode?.("setup");
    }
    this.#showSetupError(`Playback interrupted (${receipt.failureCode}). Recovery ${receipt.recoveryId} is available at the last safe boundary.`);
    await this.#refreshParticipantStates();
  }

  #startPolling() {
    this.#stopPolling();
    this.pollTimer = this.setInterval?.(() => {
      void this.invoke("research_run_status")
        .then((status) => {
          this.#projectStatus(status);
          if (this.run?.transitionActive
            && status.transitionReady
            && this.run.settings.experiment.betweenVideos.mode !== "continueWhenReady") {
            this.#queue(() => this.#continueRun());
          }
        })
        .catch((error) => this.#showRuntimeError(error));
    }, STATUS_POLL_MS);
  }

  #stopPolling() {
    if (this.pollTimer !== null) this.clearInterval?.(this.pollTimer);
    this.pollTimer = null;
  }

  #projectStatus(status) {
    if (!this.run) return;
    this.run.lastStatus = status;
    const stimulus = this.#currentStimulus();
    const transitionMode = this.run.settings.experiment.betweenVideos.mode;
    const transitionMessage = status.transitionRemainingMs === null
      ? "Sampling is stopped and the rating is neutral. Continue when ready."
      : status.transitionReady
        ? "Sampling is stopped and the rating is neutral. Preparing the next complete video."
        : `Sampling is stopped and the rating is neutral. Next video in ${(status.transitionRemainingMs / 1_000).toFixed(1)} seconds.`;
    this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
      stimulus: `${this.run.index + 1}/${this.run.assignment.slots.length} · ${stimulus.title}`,
      timing: `${status.sampleCount} rows · ${status.gapEventCount} gap events · ${status.missedSlotCount} missed slots`,
      write: status.writeHealthy ? "Native journal synced" : `Write failure: ${status.failureCode ?? "unknown"}`,
      lsl: status.lslEnabled ? "Streaming" : "Off",
      x: status.currentValence,
      y: status.currentArousal,
      paused: status.phase === "paused",
      transitionActive: this.run.transitionActive,
      transitionMode,
      transitionMessage,
    });
  }

  #currentStimulus() {
    const slot = this.run?.assignment?.slots?.[this.run.index];
    const stimulus = slot && this.run.plan.stimuli.find(({ stimulusId }) => stimulusId === slot.stimulusId);
    if (!stimulus) throw new Error("The current native assignment slot is unavailable.");
    return stimulus;
  }

  #clearVideo() {
    const video = this.#video();
    video.pause?.();
    video.removeAttribute?.("src");
    video.load?.();
    video.hidden = true;
  }

  #video() {
    const video = this.root.querySelector?.("#run-video");
    if (!video) throw new Error("Research run video element is missing.");
    return video;
  }

  #requireWorkspace() {
    if (!this.workspace?.workspaceId) throw new Error("Select a native Research workspace first.");
  }

  #dispatch(type, detail) {
    this.root.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #announce(message) {
    const announcer = this.root.querySelector?.("#research-announcer");
    if (announcer) announcer.textContent = message;
  }

  #showSetupError(error) {
    const status = this.root.querySelector?.("#start-status");
    if (status) status.textContent = messageOf(error);
  }

  #showRuntimeError(error) {
    const message = messageOf(error);
    if (this.run) {
      this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
        stimulus: "Stopped by native error",
        timing: "Stopped",
        write: message,
      });
    } else this.#showSetupError(error);
  }
}

async function bootNativeBridge() {
  const root = document.querySelector("#research-app[data-research-surface=\"tauri\"]");
  if (!root) return;
  if (!root.researchUi) await delay(0);
  const bridge = new NativeResearchRuntimeBridge(root);
  root.researchRuntime = bridge;
  await bridge.initialize();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void bootNativeBridge(), { once: true });
  } else {
    void bootNativeBridge();
  }
}
