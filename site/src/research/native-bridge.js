import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import {
  INPUT_PRESET_OPTIONS,
  RESEARCH_UI_EVENTS,
  estimateResearchStorageUse,
} from "./app.js";
import { probeVideoElement } from "./workspace.js";

const STATUS_POLL_MS = 100;
const DECODE_PROBE_MS = 80;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RUN_PHASES = new Set(["prepared", "betweenStimuli", "playing", "paused", "finalizing", "finished", "failed"]);
const PLAYBACK_MODES = new Set(["nativeLibvlc", "unqualifiedWebview"]);
const PLAYBACK_QUALIFICATIONS = new Set(["qualifiedNative", "unqualified"]);

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

export function participantStateDetail(rows, pendingFinalizations = []) {
  const detail = Object.fromEntries((rows ?? []).map(({ participantId, state }) => [
    participantId,
    String(state).toLowerCase(),
  ]));
  detail.__recoverable = Object.freeze(Object.fromEntries((rows ?? []).map(({ participantId, recoverable }) => [
    participantId,
    recoverable === true,
  ])));
  const newestPending = new Map();
  for (const pending of pendingFinalizations) {
    const current = newestPending.get(pending.participantId);
    if (!current || pending.attemptNumber > current.attemptNumber) newestPending.set(pending.participantId, pending);
  }
  detail.__finalizationPending = Object.freeze(Object.fromEntries((rows ?? []).map(({ participantId }) => [
    participantId,
    newestPending.has(participantId),
  ])));
  detail.__finalizationBinding = Object.freeze(Object.fromEntries([...newestPending].map(([participantId, pending]) => [
    participantId,
    Object.freeze({
      settingsSha256: pending.settingsSha256,
      assignmentPlanSha256: pending.assignmentPlanSha256,
      playbackMode: pending.playbackMode,
      completionStatus: pending.pendingCompletionStatus,
      attemptNumber: pending.attemptNumber,
    }),
  ])));
  return Object.freeze(detail);
}

function nullable(value, predicate) {
  return value === null || predicate(value);
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function nativeMediaFailureReceiptMatches(receipt, runId) {
  return Boolean(receipt?.runId === runId
    && typeof receipt.recoveryId === "string" && receipt.recoveryId.length > 0
    && typeof receipt.failureCode === "string" && receipt.failureCode.length > 0
    && nullable(receipt.interruptedStimulusPosition, (value) => Number.isSafeInteger(value) && value > 0)
    && nonNegativeInteger(receipt.lastSafeStimulusPosition));
}

export function nativeFinalizeReceiptMatches(receipt, {
  runId,
  participantId,
  attemptNumber,
  completionStatus,
} = {}) {
  if (receipt?.runId !== runId
    || receipt.participantId !== participantId
    || receipt.attemptNumber !== attemptNumber
    || receipt.completionStatus !== completionStatus
    || !RUN_ID_PATTERN.test(receipt.outputReceiptId ?? "")
    || !Array.isArray(receipt.files)) return false;
  const names = new Set();
  for (const file of receipt.files) {
    if (typeof file?.fileName !== "string" || file.fileName.length === 0
      || /[\\/]/u.test(file.fileName) || names.has(file.fileName)
      || !/^[0-9a-f]{64}$/u.test(file.sha256 ?? "")
      || !Number.isSafeInteger(file.byteLength) || file.byteLength <= 0) return false;
    names.add(file.fileName);
  }
  return names.has("settings.snapshot.json")
    && names.has("events.jsonl")
    && names.has("manifest.json")
    && (names.has("ratings.csv") || names.has("ratings.tsv"));
}

export function nativeStartReceiptMatches(receipt, {
  participantId,
  settingsSha256,
  assignmentPlanSha256,
  playbackMode,
  resumed,
  recovery = null,
  slotCount,
} = {}) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || !RUN_ID_PATTERN.test(receipt.runId ?? "")
    || typeof participantId !== "string" || participantId.length === 0
    || receipt.participantId !== participantId
    || !Number.isSafeInteger(receipt.attemptNumber) || receipt.attemptNumber < 1
    || !SHA256_PATTERN.test(settingsSha256 ?? "") || receipt.settingsSha256 !== settingsSha256
    || !SHA256_PATTERN.test(assignmentPlanSha256 ?? "") || receipt.assignmentPlanSha256 !== assignmentPlanSha256
    || !RUN_ID_PATTERN.test(receipt.outputReceiptId ?? "")
    || typeof receipt.sessionStem !== "string" || receipt.sessionStem.length === 0 || receipt.sessionStem.length > 240
    || /[<>:"/\\|?*\u0000-\u001f]/u.test(receipt.sessionStem)
    || !receipt.sessionStem.startsWith(`${participantId}_`)
    || !receipt.sessionStem.endsWith(`_R${String(receipt.attemptNumber).padStart(2, "0")}`)
    || typeof resumed !== "boolean" || receipt.resumed !== resumed
    || !Number.isSafeInteger(slotCount) || slotCount < 1
    || !PLAYBACK_MODES.has(playbackMode)
    || receipt.playbackMode !== playbackMode
    || receipt.playbackQualification !== (playbackMode === "nativeLibvlc" ? "qualifiedNative" : "unqualified")) {
    return false;
  }
  if (!resumed) return receipt.resumeAtStimulusPosition === 1;
  if (!recovery || recovery.runId !== receipt.runId
    || recovery.participantId !== participantId
    || recovery.attemptNumber !== receipt.attemptNumber
    || !nonNegativeInteger(recovery.lastSafeStimulusPosition)
    || recovery.lastSafeStimulusPosition >= slotCount) return false;
  return receipt.resumeAtStimulusPosition === recovery.lastSafeStimulusPosition + 1;
}

/**
 * Bind a reload-only durable-finalization retry to the exact recovery summary
 * selected by the operator. A pending retry deliberately carries no media,
 * input, or playback-capability fields.
 */
export function nativePendingFinalizationContract(recovery, {
  workspaceId,
  participantId,
  settingsSha256,
  assignmentPlanSha256,
  playbackMode,
  settings,
  assignmentPlan,
} = {}) {
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) return null;
  if (typeof recovery.finalizationPending !== "boolean"
    || (recovery.finalizationPending === false && recovery.pendingCompletionStatus !== null)) {
    throw new Error("Native recovery finalization state is inconsistent or unsupported.");
  }
  if (!recovery.finalizationPending) return null;
  const expectedQualification = playbackMode === "nativeLibvlc" ? "qualifiedNative" : "unqualified";
  if (!PLAYBACK_MODES.has(playbackMode)
    || !RUN_ID_PATTERN.test(recovery.runId ?? "")
    || typeof recovery.recoveryId !== "string" || recovery.recoveryId.length === 0
    || recovery.participantId !== participantId
    || !Number.isSafeInteger(recovery.attemptNumber) || recovery.attemptNumber < 1
    || !SHA256_PATTERN.test(settingsSha256 ?? "")
    || !SHA256_PATTERN.test(assignmentPlanSha256 ?? "")
    || recovery.settingsSha256 !== settingsSha256
    || recovery.assignmentPlanSha256 !== assignmentPlanSha256
    || recovery.playbackMode !== playbackMode
    || recovery.playbackQualification !== expectedQualification
    || !["completed", "partial"].includes(recovery.pendingCompletionStatus)
    || typeof workspaceId !== "string" || workspaceId.length === 0
    || !settings || typeof settings !== "object" || Array.isArray(settings)
    || !assignmentPlan || typeof assignmentPlan !== "object" || Array.isArray(assignmentPlan)) {
    throw new Error("Pending native finalization is not bound to the selected run, participant, attempt, hashes, and playback contract.");
  }
  return Object.freeze({
    request: Object.freeze({
      workspaceId,
      recoveryId: recovery.recoveryId,
      settings,
      assignmentPlan,
    }),
    expectedReceipt: Object.freeze({
      runId: recovery.runId,
      participantId: recovery.participantId,
      attemptNumber: recovery.attemptNumber,
      completionStatus: recovery.pendingCompletionStatus,
    }),
  });
}

export function selectPendingNativeFinalizationRecovery(recoveries, {
  participantId,
  settingsSha256,
  assignmentPlanSha256,
  playbackMode,
  attemptNumber,
  completionStatus,
} = {}) {
  if (!Array.isArray(recoveries)
    || typeof participantId !== "string" || participantId.length === 0
    || !SHA256_PATTERN.test(settingsSha256 ?? "")
    || !SHA256_PATTERN.test(assignmentPlanSha256 ?? "")
    || !PLAYBACK_MODES.has(playbackMode)
    || !Number.isSafeInteger(attemptNumber) || attemptNumber < 1
    || !["completed", "partial"].includes(completionStatus)) return null;
  const exact = recoveries.filter((candidate) => (
    candidate?.participantId === participantId
    && candidate.settingsSha256 === settingsSha256
    && candidate.assignmentPlanSha256 === assignmentPlanSha256
    && candidate.playbackMode === playbackMode
    && candidate.attemptNumber === attemptNumber
    && candidate.finalizationPending === true
    && candidate.pendingCompletionStatus === completionStatus
  ));
  if (exact.length > 1) throw new Error("Native recovery listing contains duplicate pending finalization identities.");
  return exact[0] ?? null;
}

/**
 * Validate the bounded Rust RunStatus handshake before treating the native
 * scheduler/status boundary as available. This proves contract compatibility,
 * not timing qualification on physical hardware.
 */
export function nativeRunStatusHandshake(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)
    || typeof status.active !== "boolean"
    || !RUN_PHASES.has(status.phase)
    || !nonNegativeInteger(status.sampleCount)
    || !nonNegativeInteger(status.eventCount)
    || !nonNegativeInteger(status.gapEventCount)
    || !nonNegativeInteger(status.missedSlotCount)
    || !Number.isFinite(status.currentValence) || status.currentValence < -1 || status.currentValence > 1
    || !Number.isFinite(status.currentArousal) || status.currentArousal < -1 || status.currentArousal > 1
    || typeof status.inputActive !== "boolean"
    || !nullable(status.activeStimulusPosition, (value) => Number.isSafeInteger(value) && value > 0)
    || !nonNegativeInteger(status.lastSafeStimulusPosition)
    || !nullable(status.mediaTimeMs, (value) => Number.isFinite(value) && value >= 0)
    || !nullable(status.transitionDurationMs, nonNegativeInteger)
    || !nullable(status.transitionRemainingMs, (value) => Number.isFinite(value) && value >= 0)
    || typeof status.transitionReady !== "boolean"
    || typeof status.writeHealthy !== "boolean"
    || typeof status.lslEnabled !== "boolean"
    || !nullable(status.failureCode, (value) => typeof value === "string" && value.length > 0)
    || !nullable(status.playbackMode, (value) => PLAYBACK_MODES.has(value))
    || !nullable(status.playbackQualification, (value) => PLAYBACK_QUALIFICATIONS.has(value))) {
    return false;
  }
  if (status.active) {
    return RUN_ID_PATTERN.test(status.runId ?? "")
      && typeof status.participantId === "string" && status.participantId.length > 0
      && Number.isSafeInteger(status.attemptNumber) && status.attemptNumber > 0
      && ((status.playbackMode === "nativeLibvlc" && status.playbackQualification === "qualifiedNative")
        || (status.playbackMode === "unqualifiedWebview" && status.playbackQualification === "unqualified"));
  }
  return status.runId === null
    && status.participantId === null
    && status.attemptNumber === null
    && status.phase === "finished"
    && status.activeStimulusPosition === null
    && status.mediaTimeMs === null
    && status.transitionDurationMs === null
    && status.transitionRemainingMs === null
    && status.transitionReady === false
    && status.sampleCount === 0
    && status.eventCount === 0
    && status.gapEventCount === 0
    && status.missedSlotCount === 0
    && status.currentValence === 0
    && status.currentArousal === 0
    && status.inputActive === false
    && status.lastSafeStimulusPosition === 0
    && status.writeHealthy === true
    && status.lslEnabled === false
    && status.failureCode === null
    && status.playbackMode === null
    && status.playbackQualification === null;
}

export function nativeRendererRunFenceMatches(run, fence) {
  return Boolean(run && fence
    && Number.isSafeInteger(fence.rendererEpoch) && fence.rendererEpoch > 0
    && RUN_ID_PATTERN.test(fence.runId ?? "")
    && run.rendererEpoch === fence.rendererEpoch
    && run.receipt?.runId === fence.runId);
}

export function nativeMediaGenerationMatches(run, fence, mediaEpoch, currentVideo, eventVideo) {
  return nativeRendererRunFenceMatches(run, fence)
    && Number.isSafeInteger(mediaEpoch) && mediaEpoch > 0
    && run.mediaEpoch === mediaEpoch
    && currentVideo === eventVideo;
}

export function nativeStatusPollMayProject(run, fence, lifecycleRevision, requestSequence) {
  return nativeRendererRunFenceMatches(run, fence)
    && !run.terminalInFlight
    && !run.lifecycleInFlight
    && run.lifecycleRevision === lifecycleRevision
    && Number.isSafeInteger(requestSequence)
    && requestSequence > run.lastProjectedStatusSequence;
}

export function nativeRunStatusMatchesFence(status, run, fence) {
  return nativeRendererRunFenceMatches(run, fence)
    && nativeRunStatusHandshake(status)
    && status.active === true
    && status.runId === fence.runId
    && status.participantId === run.receipt.participantId
    && status.attemptNumber === run.receipt.attemptNumber
    && status.playbackMode === run.receipt.playbackMode
    && status.playbackQualification === run.receipt.playbackQualification;
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

export function mediaFailureReport({ runId, mediaErrorCode, stimulusId, stimulusPosition, mediaTimeMs }) {
  const reason = ({ 1: "aborted", 2: "network", 3: "decode", 4: "sourceNotSupported" })[mediaErrorCode] ?? "unknown";
  if (!RUN_ID_PATTERN.test(runId ?? "") || !stimulusId || !Number.isInteger(stimulusPosition) || stimulusPosition < 1) {
    throw new TypeError("A media failure must bind the active native run and opaque stimulus position.");
  }
  return Object.freeze({
    runId,
    reason,
    stimulusId,
    stimulusPosition,
    mediaTimeMs: Math.max(0, Number(mediaTimeMs) || 0),
  });
}

export async function closeNativeRendererFailureBoundary({
  invoke,
  runId,
  participantId,
  attemptNumber,
  report = null,
  preferFinish = false,
} = {}) {
  if (typeof invoke !== "function" || !RUN_ID_PATTERN.test(runId ?? "")
    || typeof participantId !== "string" || participantId.length === 0
    || !Number.isSafeInteger(attemptNumber) || attemptNumber < 1
    || (report && report.runId !== runId)) {
    throw new TypeError("A native failure boundary requires one authoritative run ID.");
  }
  let failureReceipt = null;
  let finishReceipt = null;
  let boundaryError = null;
  let reconciliation = "notNeeded";
  let reconciliationStatus = null;
  if (!preferFinish && report) {
    try {
      failureReceipt = await invoke("research_report_media_failure", { report });
      if (!nativeMediaFailureReceiptMatches(failureReceipt, runId)) {
        throw new Error("Native interruption receipt did not match the active renderer run contract.");
      }
    } catch (error) {
      failureReceipt = null;
      boundaryError = error;
    }
  }
  if (!failureReceipt) {
    try {
      finishReceipt = await invoke("research_finish_run", { runId, outcome: "stopEarly" });
      if (!nativeFinalizeReceiptMatches(finishReceipt, {
        runId,
        participantId,
        attemptNumber,
        completionStatus: "partial",
      })) {
        throw new Error("Native fallback finalization receipt did not match the active renderer run contract.");
      }
      boundaryError = null;
    } catch (error) {
      finishReceipt = null;
      boundaryError = boundaryError ?? error;
    }
  }
  if (!failureReceipt && !finishReceipt) {
    try {
      const status = await invoke("research_run_status");
      if (!nativeRunStatusHandshake(status)) {
        reconciliation = "invalidStatus";
      } else if (!status.active) {
        reconciliation = "inactiveWithoutReceipt";
        reconciliationStatus = status;
      } else if (status.runId === runId) {
        reconciliation = "nativeStillActive";
        reconciliationStatus = status;
      } else {
        reconciliation = "differentNativeRun";
        reconciliationStatus = status;
      }
    } catch {
      reconciliation = "unavailable";
    }
  }
  return Object.freeze({
    confirmed: Boolean(failureReceipt || finishReceipt),
    failureReceipt,
    finishReceipt,
    boundaryError,
    reconciliation,
    reconciliationStatus,
  });
}

export async function closeMalformedNativeStartBoundary({
  invoke,
  receipt,
  participantId,
  playbackMode,
} = {}) {
  if (typeof invoke !== "function" || typeof participantId !== "string" || participantId.length === 0
    || !PLAYBACK_MODES.has(playbackMode)) {
    throw new TypeError("Malformed native Start reconciliation requires the selected participant and playback contract.");
  }
  let status;
  try {
    status = await invoke("research_run_status");
  } catch (error) {
    return Object.freeze({ confirmed: false, reconciliation: "statusUnavailable", error });
  }
  const receiptRunId = RUN_ID_PATTERN.test(receipt?.runId ?? "") ? receipt.runId : null;
  if (!nativeRunStatusHandshake(status)
    || status.active !== true
    || status.participantId !== participantId
    || status.playbackMode !== playbackMode
    || (receiptRunId !== null && receiptRunId !== status.runId)) {
    return Object.freeze({ confirmed: false, reconciliation: "statusMismatch", status });
  }
  const boundary = await closeNativeRendererFailureBoundary({
    invoke,
    runId: status.runId,
    participantId: status.participantId,
    attemptNumber: status.attemptNumber,
    preferFinish: true,
  });
  return Object.freeze({ ...boundary, status });
}

function activationReconciliationError(message, reconciliation, cause = undefined) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  Object.defineProperty(error, "nativeActivationReconciliation", {
    value: reconciliation,
    enumerable: false,
  });
  return error;
}

export async function invokeNativeRunActivation({
  invoke,
  command,
  payload,
  participantId,
  playbackMode,
  expectedRunId = null,
  expectedAttemptNumber = null,
} = {}) {
  if (typeof invoke !== "function"
    || !["research_start_run", "research_resume_run"].includes(command)
    || !payload || typeof payload !== "object" || Array.isArray(payload)
    || typeof participantId !== "string" || participantId.length === 0
    || !PLAYBACK_MODES.has(playbackMode)
    || (expectedRunId !== null && !RUN_ID_PATTERN.test(expectedRunId))
    || (expectedAttemptNumber !== null
      && (!Number.isSafeInteger(expectedAttemptNumber) || expectedAttemptNumber < 1))
    || ((expectedRunId === null) !== (expectedAttemptNumber === null))) {
    throw new TypeError("Native activation requires one bounded Start or Resume identity.");
  }
  let before;
  try {
    before = await invoke("research_run_status");
  } catch (error) {
    throw activationReconciliationError(
      `Native activation preflight status is unavailable (${messageOf(error)}). Restart Affect Research before retrying.`,
      "preflightUnavailable",
      error,
    );
  }
  if (!nativeRunStatusHandshake(before) || before.active) {
    throw activationReconciliationError(
      "Native activation preflight did not prove an idle runtime. Restart Affect Research to reconcile native state.",
      "preflightNotIdle",
    );
  }
  try {
    return await invoke(command, payload);
  } catch (activationError) {
    let after;
    try {
      after = await invoke("research_run_status");
    } catch (statusError) {
      throw activationReconciliationError(
        `Native ${command === "research_start_run" ? "Start" : "Resume"} IPC was rejected and authoritative state is unavailable. Native outcome is unknown; restart Affect Research (${messageOf(activationError)}; ${messageOf(statusError)}).`,
        "unreconciled",
        activationError,
      );
    }
    if (!nativeRunStatusHandshake(after)) {
      throw activationReconciliationError(
        `Native ${command === "research_start_run" ? "Start" : "Resume"} IPC was rejected and returned an invalid reconciliation status. Native outcome is unknown; restart Affect Research (${messageOf(activationError)}).`,
        "unreconciled",
        activationError,
      );
    }
    if (!after.active) {
      throw activationReconciliationError(
        `Native ${command === "research_start_run" ? "Start" : "Resume"} was rejected before activation (${messageOf(activationError)}).`,
        "inactiveAfterRejection",
        activationError,
      );
    }
    const matchesExpectedActivation = after.participantId === participantId
      && after.playbackMode === playbackMode
      && (expectedRunId === null || after.runId === expectedRunId)
      && (expectedAttemptNumber === null || after.attemptNumber === expectedAttemptNumber);
    if (!matchesExpectedActivation) {
      throw activationReconciliationError(
        `Native ${command === "research_start_run" ? "Start" : "Resume"} IPC was rejected, but the active native identity does not match this request. Native outcome is unknown; restart Affect Research.`,
        "unreconciled",
        activationError,
      );
    }
    const rollback = await closeNativeRendererFailureBoundary({
      invoke,
      runId: after.runId,
      participantId: after.participantId,
      attemptNumber: after.attemptNumber,
      preferFinish: true,
    });
    if (rollback.confirmed) {
      throw activationReconciliationError(
        `Native ${command === "research_start_run" ? "Start" : "Resume"} IPC was rejected after activation; the matching run was finalized as Partial. Restart Affect Research before another attempt.`,
        "rolledBack",
        activationError,
      );
    }
    throw activationReconciliationError(
      `Native ${command === "research_start_run" ? "Start" : "Resume"} IPC was rejected after activation, and rollback could not be confirmed (${rollback.reconciliation}). Native outcome is unknown; restart Affect Research.`,
      "unreconciled",
      activationError,
    );
  }
}

function stimulusUpdate(runId, lifecycle, stimulus, position, mediaTimeMs = 0) {
  if (!RUN_ID_PATTERN.test(runId ?? "")) throw new TypeError("A playback event must bind the active native run ID.");
  return Object.freeze({
    runId,
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
  probeTimeoutMs = 15_000,
} = {}) {
  if (summary.decodeStatus === "attestedUnqualified"
    && summary.decodeBackend === "webviewVideoFrameCallback"
    && summary.decodeAttestation === "representativeFramesV1"
    && summary.source) return summary;
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
    const probe = await probeVideoElement(video, { timeoutMs: probeTimeoutMs });
    const restart = once(video, "seeked");
    video.currentTime = 0;
    await restart;
    const started = performanceNow();
    await video.play();
    await delay(DECODE_PROBE_MS);
    video.pause?.();
    const mutedPlaybackMs = Math.max(50, Math.min(5_000, performanceNow() - started));
    return invoke("research_attest_workspace_decode", {
      attestation: {
        attestationKind: "attestRepresentativeFramesV1",
        decodeBackend: "webviewVideoFrameCallback",
        workspaceId,
        mediaGrantId: receipt.mediaGrantId,
        workspaceFileId: summary.workspaceFileId,
        sha256: summary.sha256,
        byteLength: summary.byteLength,
        mimeType: summary.mimeType,
        observedDurationMs: probe.durationSeconds * 1_000,
        videoWidth: probe.videoWidth,
        videoHeight: probe.videoHeight,
        mutedPlaybackMs,
        decodedPositionsMs: probe.decodedPositionsSeconds.map((position) => position * 1_000),
      },
    });
  } catch (error) {
    await invoke("research_attest_workspace_decode", {
      attestation: {
        attestationKind: "revokeGrant",
        decodeBackend: "webviewVideoFrameCallback",
        workspaceId,
        mediaGrantId: receipt.mediaGrantId,
        workspaceFileId: summary.workspaceFileId,
        sha256: summary.sha256,
        byteLength: summary.byteLength,
        mimeType: summary.mimeType,
      },
    }).catch(() => {});
    throw error;
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
    this.nativeTimingReady = false;
    this.run = null;
    this.rendererEpoch = 0;
    this.mediaEpoch = 0;
    this.pollTimer = null;
    this.inputPollTimer = null;
    this.inputLayoutEpoch = 0;
    this.lastCaptureId = null;
    this.listeners = [];
    this.mediaListeners = [];
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
      this.nativeTimingReady = nativeRunStatusHandshake(status);
      this.#applySourceCapabilities();
      this.#applyInputCapability();
      this.root.researchUi?.applyNativeInputStatus?.(inputStatus);
      this.#dispatch(RESEARCH_UI_EVENTS.capabilityStatus, {
        indexedDbReady: true,
        timingWorkerReady: this.nativeTimingReady,
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
    this.#clearMediaListeners();
    this.run = null;
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
    this.#listen(this.root, RESEARCH_UI_EVENTS.pauseRequest, () => {
      this.#queueForCurrentRun((fence) => this.#togglePause(fence));
    });
    this.#listen(this.root, RESEARCH_UI_EVENTS.stopEarlyRequest, () => {
      this.#queueForCurrentRun((fence) => this.#finish(fence, "stopEarly"));
    });
    this.#listen(this.root, RESEARCH_UI_EVENTS.continueRequest, () => {
      this.#queueForCurrentRun((fence) => this.#continueRun(fence, { directGesture: true }));
    });
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

  #listenMedia(target, type, listener) {
    target.addEventListener(type, listener);
    this.mediaListeners.push([target, type, listener]);
  }

  #clearMediaListeners() {
    for (const [target, type, listener] of this.mediaListeners) {
      target.removeEventListener(type, listener);
    }
    this.mediaListeners = [];
  }

  #mediaGenerationMatches(fence, mediaEpoch, eventVideo) {
    return nativeMediaGenerationMatches(
      this.run,
      fence,
      mediaEpoch,
      this.root.querySelector?.("#run-video"),
      eventVideo,
    );
  }

  #installRunVideo(fence) {
    if (!this.#runAcceptsLifecycle(fence)) {
      throw new Error("The active renderer run changed before media installation.");
    }
    const previous = this.#video();
    const video = previous.cloneNode?.(false);
    if (!video || typeof video.play !== "function" || typeof previous.replaceWith !== "function") {
      throw new Error("A fresh run-bound video element could not be installed.");
    }
    video.removeAttribute?.("src");
    video.hidden = true;
    this.#clearMediaListeners();
    previous.replaceWith(video);
    const mediaEpoch = ++this.mediaEpoch;
    this.run.mediaEpoch = mediaEpoch;
    const queueMediaOperation = (operation) => {
      if (!this.#mediaGenerationMatches(fence, mediaEpoch, video)) return;
      this.#queue(() => {
        if (this.#mediaGenerationMatches(fence, mediaEpoch, video)) return operation(fence);
        return undefined;
      });
    };
    this.#listenMedia(video, "ended", () => queueMediaOperation((runFence) => this.#completeStimulus(runFence)));
    for (const type of ["waiting", "stalled"]) {
      this.#listenMedia(video, type, () => queueMediaOperation((runFence) => this.#pauseForBuffering(runFence)));
    }
    this.#listenMedia(video, "playing", () => queueMediaOperation((runFence) => this.#resumeAfterBuffering(runFence)));
    this.#listenMedia(video, "error", () => queueMediaOperation((runFence) => this.#interruptForMediaFailure(runFence)));
    return video;
  }

  #queue(operation) {
    this.operation = this.operation.then(operation, operation).catch((error) => this.#showRuntimeError(error));
    return this.operation;
  }

  #captureRunFence() {
    if (!this.run) return null;
    return Object.freeze({
      runId: this.run.receipt.runId,
      rendererEpoch: this.run.rendererEpoch,
    });
  }

  #runMatches(fence) {
    return nativeRendererRunFenceMatches(this.run, fence);
  }

  #runAcceptsLifecycle(fence) {
    return this.#runMatches(fence) && !this.run.terminalInFlight;
  }

  #queueForCurrentRun(operation) {
    const fence = this.#captureRunFence();
    if (fence) this.#queue(() => operation(fence));
  }

  #statusMatches(status, fence) {
    return nativeRunStatusMatchesFence(status, this.run, fence);
  }

  #statusOperationalForRun(status, run) {
    const previousPhase = run.lastStatus?.phase;
    const expectedPhase = !previousPhase
      || status.phase === previousPhase
      || (previousPhase === "prepared" && status.phase === "betweenStimuli");
    return status.writeHealthy === true
      && !["failed", "finalizing", "finished"].includes(status.phase)
      && expectedPhase;
  }

  #recordLifecycleAck(run, phase) {
    run.lastStatus = { ...run.lastStatus, phase };
  }

  #beginLifecycleCommand(run) {
    run.lifecycleRevision += 1;
    run.lifecycleDepth += 1;
    run.lifecycleInFlight = true;
  }

  #endLifecycleCommand(run) {
    run.lifecycleDepth = Math.max(0, run.lifecycleDepth - 1);
    run.lifecycleInFlight = run.lifecycleDepth > 0;
  }

  async #invokeLifecycleUpdate(fence, update) {
    if (!this.#runAcceptsLifecycle(fence)) return;
    const run = this.run;
    this.#beginLifecycleCommand(run);
    try {
      await this.invoke("research_set_stimulus_state", { update });
    } finally {
      this.#endLifecycleCommand(run);
    }
  }

  #markTimingHandshakeFailed() {
    this.nativeTimingReady = false;
    this.#dispatch(RESEARCH_UI_EVENTS.capabilityStatus, { timingWorkerReady: false });
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
        if (summary.decodeStatus !== "attestedUnqualified"
          || summary.decodeBackend !== "webviewVideoFrameCallback"
          || summary.decodeAttestation !== "representativeFramesV1"
          || !summary.source) {
          throw new Error(`${summary.displayName} did not produce an explicitly unqualified WebView source contract.`);
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
        items.push(Object.freeze({
          stimulus,
          verified: true,
          decodeQualification: "attestedUnqualified",
          workspaceFileId: summary.workspaceFileId,
        }));
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
      timingWorkerReady: this.nativeTimingReady,
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
    const compatibleRecoveries = this.recoveries.filter((candidate) => (
      candidate.settingsSha256 === plan?.settingsSha256
      && candidate.assignmentPlanSha256 === plan?.planHashSha256
      && candidate.playbackMode === playbackMode
    ));
    const pendingFinalizations = [];
    for (const candidate of compatibleRecoveries) {
      const pending = nativePendingFinalizationContract(candidate, {
        workspaceId: this.workspace.workspaceId,
        participantId: candidate.participantId,
        settingsSha256: plan.settingsSha256,
        assignmentPlanSha256: plan.planHashSha256,
        playbackMode,
        settings,
        assignmentPlan: plan,
      });
      if (pending) pendingFinalizations.push(candidate);
    }
    const projectedStates = (states ?? []).map((state) => ({
      ...state,
      recoverable: state.recoverable === true
        && compatibleRecoveries.some((candidate) => candidate.participantId === state.participantId),
    }));
    this.#dispatch(RESEARCH_UI_EVENTS.capabilityStatus, {
      manifestReady: true,
      manifestError: "",
    });
    this.#dispatch(RESEARCH_UI_EVENTS.participantStates, participantStateDetail(projectedStates, pendingFinalizations));
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

  async #activateNativeRun(request) {
    try {
      return await invokeNativeRunActivation({ invoke: this.invoke, ...request });
    } catch (error) {
      if (error?.nativeActivationReconciliation !== "inactiveAfterRejection") {
        this.#markTimingHandshakeFailed();
      }
      if (error?.nativeActivationReconciliation === "rolledBack") {
        await this.#refreshParticipantStates();
      }
      throw error;
    }
  }

  async #start(detail) {
    this.#requireWorkspace();
    if (this.run) throw new Error("A native Research attempt is already active.");
    const settings = detail?.settings;
    const plan = detail?.resolvedPlan;
    const requestedPlaybackMode = detail?.playbackMode ?? "nativeLibvlc";
    if (!PLAYBACK_MODES.has(requestedPlaybackMode)) throw new TypeError("Unknown Windows playback mode.");
    await this.#refreshParticipantStates(settings);
    let recovery = null;
    const compatibleRecoveries = this.recoveries
      .filter((candidate) => candidate.participantId === detail.participantId
        && candidate.settingsSha256 === detail.settingsSha256
        && candidate.assignmentPlanSha256 === plan?.planHashSha256
        && candidate.playbackMode === requestedPlaybackMode);
    if (detail.recoveryFinalizationOnly === true) {
      recovery = selectPendingNativeFinalizationRecovery(compatibleRecoveries, {
        participantId: detail.participantId,
        settingsSha256: detail.settingsSha256,
        assignmentPlanSha256: plan?.planHashSha256,
        playbackMode: requestedPlaybackMode,
        attemptNumber: detail.pendingFinalizationAttemptNumber,
        completionStatus: detail.pendingFinalizationCompletionStatus,
      });
      if (recovery) {
        const pendingFinalization = nativePendingFinalizationContract(recovery, {
          workspaceId: this.workspace.workspaceId,
          participantId: detail.participantId,
          settingsSha256: detail.settingsSha256,
          assignmentPlanSha256: plan?.planHashSha256,
          playbackMode: requestedPlaybackMode,
          settings,
          assignmentPlan: plan,
        });
        if (pendingFinalization) {
          let finalizationReceipt;
          this.#stopInputPolling();
          try {
            finalizationReceipt = await this.invoke("research_finalize_recovery", {
              request: pendingFinalization.request,
            });
            if (!nativeFinalizeReceiptMatches(finalizationReceipt, pendingFinalization.expectedReceipt)) {
              throw new Error("Native recovery-finalization receipt did not match the pending durable run contract.");
            }
          } finally {
            this.#startInputPolling();
          }
          this.#dispatch(RESEARCH_UI_EVENTS.runComplete, {
            status: finalizationReceipt.completionStatus,
            participant: finalizationReceipt.participantId,
            attempt: finalizationReceipt.attemptNumber,
            receipt: finalizationReceipt.outputReceiptId,
            files: finalizationReceipt.files.map(({ fileName }) => fileName).join(", "),
          });
          await this.#refreshParticipantStates(settings);
          return;
        }
      }
      throw new Error("The displayed pending finalization is no longer available under the exact participant, attempt, terminal status, settings, plan, and playback contract. Refresh Setup before retrying.");
    }
    if (detail.attemptDisposition === "resume-compatible") {
      recovery = compatibleRecoveries
        .sort((left, right) => right.attemptNumber - left.attemptNumber)[0] ?? null;
    }
    if (!this.nativeTimingReady) {
      throw new Error("The native scheduler/status capability handshake did not pass. Restart Affect Research before attempting a run.");
    }
    const inputTestReceiptId = detail?.inputTestReceiptId;
    if (typeof inputTestReceiptId !== "string" || inputTestReceiptId.length < 8) {
      throw new Error("A fresh native input-test receipt is required before Start or recovery Resume.");
    }
    if (!this.#applyInputCapability(settings?.input)) {
      throw new Error("The selected input binding has no safe native Tauri authority.");
    }
    const playbackMode = authorizeDesktopPlaybackMode(requestedPlaybackMode, this.nativeMediaCapability);
    await this.#refreshReadiness(settings, plan);
    const estimate = estimateResearchStorageUse(settings, plan);
    if (!this.storageReadiness?.sufficient || !this.storageReadiness.writeReady
      || this.storageReadiness.requiredBytes !== estimate.requiredBytes) {
      throw new Error("Native output/recovery storage does not pass the current write and capacity probe.");
    }
    const unsupported = plan.stimuli.find(({ source }) => source.kind !== "workspaceFile");
    if (unsupported) {
      throw new Error(`${unsupported.source.kind} is not qualified by the Windows native source adapter in this internal alpha.`);
    }
    const assignment = plan.assignments.find(({ participantId }) => participantId === detail.participantId);
    if (!assignment || !Array.isArray(assignment.slots) || assignment.slots.length === 0) {
      throw new Error("The selected participant is absent from the frozen assignment plan.");
    }
    const workspaceFiles = this.#workspaceBindings(plan);
    let receipt;
    if (detail.attemptDisposition === "resume-compatible") {
      if (recovery) {
        if (!RUN_ID_PATTERN.test(recovery.runId ?? "")
          || recovery.participantId !== detail.participantId
          || !Number.isSafeInteger(recovery.attemptNumber) || recovery.attemptNumber < 1
          || !nonNegativeInteger(recovery.lastSafeStimulusPosition)
          || recovery.lastSafeStimulusPosition >= assignment.slots.length
          || recovery.playbackQualification !== (playbackMode === "nativeLibvlc" ? "qualifiedNative" : "unqualified")) {
          throw new Error("The compatible native recovery summary has no valid safe stimulus boundary to resume.");
        }
        receipt = await this.#activateNativeRun({
          command: "research_resume_run",
          participantId: detail.participantId,
          playbackMode,
          expectedRunId: recovery.runId,
          expectedAttemptNumber: recovery.attemptNumber,
          payload: {
            request: {
              workspaceId: this.workspace.workspaceId,
              recoveryId: recovery.recoveryId,
              settings,
              assignmentPlan: plan,
              workspaceFiles,
              inputTestReceiptId,
              playbackMode,
            },
          },
        });
      }
      if (!recovery && this.participantStateById.get(detail.participantId) === "partial") {
        throw new Error("The selected participant is Partial, but no compatible native recovery record is available. Choose Start a new attempt explicitly.");
      }
    }
    if (!receipt) {
      receipt = await this.#activateNativeRun({
        command: "research_start_run",
        participantId: detail.participantId,
        playbackMode,
        payload: {
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
        },
      });
    }
    const expectedResumed = Boolean(recovery && detail.attemptDisposition === "resume-compatible");
    if (!nativeStartReceiptMatches(receipt, {
      participantId: detail.participantId,
      settingsSha256: detail.settingsSha256,
      assignmentPlanSha256: plan.planHashSha256,
      playbackMode,
      resumed: expectedResumed,
      recovery: expectedResumed ? recovery : null,
      slotCount: assignment.slots.length,
    })) {
      this.#markTimingHandshakeFailed();
      const rollback = await closeMalformedNativeStartBoundary({
        invoke: this.invoke,
        receipt,
        participantId: detail.participantId,
        playbackMode,
      });
      if (rollback.confirmed) {
        await this.#refreshParticipantStates(settings);
        throw new Error("The native Start/Resume receipt failed its frozen contract and the authoritative run was finalized as Partial. Restart Affect Research before another attempt.");
      }
      throw new Error(`The native Start/Resume receipt failed its frozen contract and native rollback is ${rollback.reconciliation ?? "unreconciled"}. Restart Affect Research to reconcile durable state.`);
    }
    this.run = {
      receipt,
      rendererEpoch: ++this.rendererEpoch,
      settings,
      plan,
      assignment,
      index: Math.max(0, (receipt.resumeAtStimulusPosition ?? 1) - 1),
      awaitingStart: true,
      transitionActive: false,
      bufferPaused: false,
      manualPaused: false,
      lifecycleInFlight: false,
      lifecycleDepth: 0,
      lifecycleRevision: 0,
      statusRequestSequence: 0,
      lastProjectedStatusSequence: 0,
      mediaEpoch: null,
      terminalInFlight: null,
      lastStatus: null,
    };
    const fence = this.#captureRunFence();
    this.#dispatch(RESEARCH_UI_EVENTS.runStarted, receipt);
    try {
      const inputStatus = await this.#setNativeInputRegion(".run-feedback-stage", "runFeedback");
      if (inputStatus?.runReady !== true) {
        throw new Error("The native Run feedback-stage allow-region is not ready.");
      }
      await this.#prepareCurrentStimulus(fence, { recovery: receipt.resumed === true });
    } catch (error) {
      await this.#failClosedLifecycle(fence, error, { preferFinish: true, context: "Run preparation failed" });
      return;
    }
    if (!this.#runMatches(fence)) return;
    this.#stopInputPolling();
    this.#startPolling();
  }

  async #prepareCurrentStimulus(fence, { recovery = false } = {}) {
    if (!this.#runAcceptsLifecycle(fence)) return;
    const run = this.run;
    if (run.receipt.playbackMode !== "unqualifiedWebview") {
      throw new Error("Qualified native playback cannot be projected through the WebView video element.");
    }
    const stimulus = this.#currentStimulus(run);
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
    if (!this.#runAcceptsLifecycle(fence)) return;
    const video = this.#installRunVideo(fence);
    video.pause?.();
    video.src = receipt.mediaUrl;
    video.preload = "auto";
    video.playsInline = true;
    video.hidden = false;
    const metadata = once(video, "loadedmetadata");
    video.load?.();
    await metadata;
    if (!this.#runAcceptsLifecycle(fence)) return;
    video.currentTime = 0;
    run.awaitingStart = true;
    this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
      stimulus: `${run.index + 1}/${run.assignment.slots.length} · ${stimulus.title}`,
      timing: "Sampling stopped at safe boundary",
      write: "Native recovery journal ready",
      lsl: run.settings.advanced.lsl.enabled ? "Ready" : "Off",
      transitionActive: true,
      transitionMode: "continueWhenReady",
      transitionMessage: recovery
        ? "Recovery is ready at the last safe boundary. Begin the restarted video from its beginning."
        : "The complete video passed the unqualified WebView frame attestation. Begin when ready.",
      videoUrl: receipt.mediaUrl,
    });
  }

  async #continueRun(fence, { directGesture = false } = {}) {
    if (!this.#runAcceptsLifecycle(fence)) return;
    const run = this.run;
    if (run.transitionActive) {
      let status;
      try {
        status = await this.invoke("research_run_status");
      } catch (error) {
        await this.#failClosedLifecycle(fence, error, { context: "Native transition status failed" });
        return;
      }
      if (!this.#runAcceptsLifecycle(fence)) return;
      if (!this.#statusMatches(status, fence)) {
        this.#markTimingHandshakeFailed();
        await this.#failClosedLifecycle(fence, new Error("Native transition status did not match the active renderer run."));
        return;
      }
      if (!this.#statusOperationalForRun(status, run)) {
        this.#markTimingHandshakeFailed();
        await this.#failClosedLifecycle(fence, new Error("Native transition status reported an unhealthy or divergent run."));
        return;
      }
      if (!status.transitionReady) return;
      const completed = this.#currentStimulus(run);
      try {
        await this.#invokeLifecycleUpdate(
          fence,
          stimulusUpdate(fence.runId, "transitionCompleted", completed, run.index + 1, 0),
        );
      } catch (error) {
        await this.#failClosedLifecycle(fence, error, { context: "Native transition completion failed" });
        return;
      }
      if (!this.#runAcceptsLifecycle(fence)) return;
      this.#recordLifecycleAck(run, "betweenStimuli");
      run.transitionActive = false;
      run.index += 1;
      try {
        await this.#prepareCurrentStimulus(fence);
      } catch (error) {
        await this.#failClosedLifecycle(fence, error, { context: "Next stimulus preparation failed" });
        return;
      }
    }
    if (!this.#runAcceptsLifecycle(fence) || !run.awaitingStart) return;
    const video = this.#video();
    try {
      await video.play();
    } catch (error) {
      if (!this.#runAcceptsLifecycle(fence)) return;
      run.awaitingStart = true;
      this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
        transitionActive: true,
        transitionMode: "continueWhenReady",
        transitionMessage: directGesture
          ? `Playback could not start: ${messageOf(error)}`
          : "Windows playback needs a direct gesture. Begin this video when ready.",
      });
      return;
    }
    if (!this.#runAcceptsLifecycle(fence)) return;
    const stimulus = this.#currentStimulus(run);
    try {
      await this.#invokeLifecycleUpdate(
        fence,
        stimulusUpdate(fence.runId, "started", stimulus, run.index + 1, video.currentTime * 1_000),
      );
    } catch (error) {
      await this.#failClosedLifecycle(fence, error, { context: "Native stimulus start failed" });
      return;
    }
    if (!this.#runAcceptsLifecycle(fence)) return;
    this.#recordLifecycleAck(run, "playing");
    run.awaitingStart = false;
    run.bufferPaused = false;
    this.#dispatch(RESEARCH_UI_EVENTS.runStatus, { transitionActive: false });
  }

  async #completeStimulus(fence) {
    if (!this.#runAcceptsLifecycle(fence) || this.run.lifecycleInFlight
      || this.run.awaitingStart) return;
    const run = this.run;
    this.#beginLifecycleCommand(run);
    try {
      const stimulus = this.#currentStimulus(run);
      const position = run.index + 1;
      const mediaTimeMs = this.#video().currentTime * 1_000;
      await this.#invokeLifecycleUpdate(
        fence,
        stimulusUpdate(fence.runId, "completed", stimulus, position, mediaTimeMs),
      );
      if (!this.#runAcceptsLifecycle(fence)) return;
      this.#recordLifecycleAck(run, "betweenStimuli");
      this.root.researchUi?.resetAffect?.("safe-boundary");
      if (position >= run.assignment.slots.length) {
        await this.#finish(fence, "completed");
        return;
      }
      await this.#invokeLifecycleUpdate(
        fence,
        stimulusUpdate(fence.runId, "transitionStarted", stimulus, position, mediaTimeMs),
      );
      if (!this.#runAcceptsLifecycle(fence)) return;
      this.#recordLifecycleAck(run, "betweenStimuli");
      run.transitionActive = true;
      const status = await this.invoke("research_run_status");
      if (!this.#runAcceptsLifecycle(fence)) return;
      if (!this.#statusMatches(status, fence)) {
        this.#markTimingHandshakeFailed();
        throw new Error("Native post-stimulus status did not match the active renderer run.");
      }
      if (!this.#statusOperationalForRun(status, run)) {
        this.#markTimingHandshakeFailed();
        throw new Error("Native post-stimulus status reported an unhealthy or divergent run.");
      }
      this.#projectStatus(status, fence);
      if (run.settings.experiment.betweenVideos.mode !== "continueWhenReady" && status.transitionReady) {
        await this.#continueRun(fence);
      }
    } catch (error) {
      await this.#failClosedLifecycle(fence, error, { context: "Native stimulus completion failed" });
    } finally {
      this.#endLifecycleCommand(run);
    }
  }

  async #togglePause(fence) {
    if (!this.#runAcceptsLifecycle(fence) || this.run.awaitingStart) return;
    const run = this.run;
    const video = this.#video();
    const phase = run.lastStatus?.phase;
    const stimulus = this.#currentStimulus(run);
    const position = run.index + 1;
    if (phase === "playing") {
      video.pause();
      try {
        await this.#invokeLifecycleUpdate(
          fence,
          stimulusUpdate(fence.runId, "paused", stimulus, position, video.currentTime * 1_000),
        );
      } catch (error) {
        await this.#failClosedLifecycle(fence, error, { context: "Native pause failed" });
        return;
      }
      if (this.#runAcceptsLifecycle(fence)) {
        this.#recordLifecycleAck(run, "paused");
        run.manualPaused = true;
      }
    } else if (phase === "paused") {
      try {
        await video.play();
      } catch (error) {
        if (this.#runAcceptsLifecycle(fence)) {
          this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
            paused: true,
            write: `Playback remains paused: ${messageOf(error)}`,
          });
        }
        return;
      }
      if (!this.#runAcceptsLifecycle(fence)) return;
      try {
        await this.#invokeLifecycleUpdate(
          fence,
          stimulusUpdate(fence.runId, "resumed", stimulus, position, video.currentTime * 1_000),
        );
      } catch (error) {
        await this.#failClosedLifecycle(fence, error, { context: "Native resume failed" });
        return;
      }
      if (this.#runAcceptsLifecycle(fence)) {
        this.#recordLifecycleAck(run, "playing");
        run.manualPaused = false;
        run.bufferPaused = false;
      }
    }
  }

  async #pauseForBuffering(fence) {
    if (!this.#runAcceptsLifecycle(fence) || this.run.awaitingStart || this.run.bufferPaused
      || this.run.manualPaused) return;
    const run = this.run;
    if (run.lastStatus?.phase !== "playing") return;
    const stimulus = this.#currentStimulus(run);
    try {
      await this.#invokeLifecycleUpdate(
        fence,
        stimulusUpdate(fence.runId, "paused", stimulus, run.index + 1, this.#video().currentTime * 1_000),
      );
    } catch (error) {
      await this.#failClosedLifecycle(fence, error, { context: "Native buffering pause failed" });
      return;
    }
    if (this.#runAcceptsLifecycle(fence)) {
      this.#recordLifecycleAck(run, "paused");
      run.bufferPaused = true;
    }
  }

  async #resumeAfterBuffering(fence) {
    if (!this.#runAcceptsLifecycle(fence) || !this.run.bufferPaused
      || this.run.manualPaused) return;
    const run = this.run;
    const stimulus = this.#currentStimulus(run);
    try {
      await this.#invokeLifecycleUpdate(
        fence,
        stimulusUpdate(fence.runId, "resumed", stimulus, run.index + 1, this.#video().currentTime * 1_000),
      );
    } catch (error) {
      await this.#failClosedLifecycle(fence, error, { context: "Native buffering resume failed" });
      return;
    }
    if (this.#runAcceptsLifecycle(fence)) {
      this.#recordLifecycleAck(run, "playing");
      run.bufferPaused = false;
    }
  }

  async #finish(fence, outcome) {
    if (!this.#runMatches(fence) || this.run.terminalInFlight) return;
    const run = this.run;
    run.terminalInFlight = "finish";
    this.#video().pause?.();
    let receipt;
    try {
      receipt = await this.invoke("research_finish_run", { runId: fence.runId, outcome });
      if (!nativeFinalizeReceiptMatches(receipt, {
        runId: fence.runId,
        participantId: run.receipt.participantId,
        attemptNumber: run.receipt.attemptNumber,
        completionStatus: outcome === "completed" ? "completed" : "partial",
      })) {
        throw new Error("Native finish receipt did not match the active renderer run contract.");
      }
    } catch (error) {
      if (this.#runMatches(fence)) run.terminalInFlight = null;
      await this.#failClosedLifecycle(fence, error, { context: "Native run finalization failed" });
      return;
    }
    if (!this.#runMatches(fence)) return;
    this.#stopPolling();
    this.run = null;
    this.#clearVideo();
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

  async #interruptForMediaFailure(fence) {
    if (!this.#runMatches(fence) || this.run.terminalInFlight) return;
    await this.#failClosedLifecycle(fence, new Error("The WebView video element reported a terminal media error."), {
      mediaErrorCode: this.#video().error?.code,
      context: "Playback interrupted",
    });
  }

  async #failClosedLifecycle(fence, error, {
    mediaErrorCode,
    preferFinish = false,
    context = "Playback lifecycle synchronization failed",
  } = {}) {
    if (!this.#runMatches(fence) || this.run.terminalInFlight === "failClosed") return;
    const run = this.run;
    run.terminalInFlight = "failClosed";
    run.awaitingStart = true;
    run.manualPaused = true;
    this.#stopPolling();
    const video = this.#video();
    video.pause?.();

    let report = null;
    if (!preferFinish) {
      try {
        const stimulus = this.#currentStimulus(run);
        report = mediaFailureReport({
          runId: fence.runId,
          mediaErrorCode,
          stimulusId: stimulus.stimulusId,
          stimulusPosition: run.index + 1,
          mediaTimeMs: video.currentTime * 1_000,
        });
      } catch {
        report = null;
      }
    }
    const {
      failureReceipt,
      finishReceipt,
      boundaryError,
      reconciliation,
    } = await closeNativeRendererFailureBoundary({
      invoke: this.invoke,
      runId: fence.runId,
      participantId: run.receipt.participantId,
      attemptNumber: run.receipt.attemptNumber,
      report,
      preferFinish,
    });
    if (!this.#runMatches(fence)) return;
    if (!failureReceipt && !finishReceipt) {
      run.terminalInFlight = "unreconciled";
      this.#markTimingHandshakeFailed();
      for (const selector of ["#run-pause", "#run-stop-early", "#run-continue"]) {
        const control = this.root.querySelector?.(selector);
        if (control) control.disabled = true;
      }
      const nativeState = ({
        nativeStillActive: "Native scheduler still reports this run active.",
        inactiveWithoutReceipt: "Native scheduler reports inactive, but no terminal receipt was returned.",
        differentNativeRun: "Native scheduler reports a different active run.",
        invalidStatus: "Native scheduler returned an invalid reconciliation status.",
        unavailable: "Native scheduler state could not be read.",
      })[reconciliation] ?? "Native scheduler state is unreconciled.";
      this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
        stimulus: "Native run outcome unknown — restart required",
        timing: `Local playback is paused. ${nativeState}`,
        write: `${context}: ${messageOf(error)} No recovery or finalization receipt was confirmed (${messageOf(boundaryError)}). Close and restart Affect Research to reconcile durable state.`,
        paused: true,
        transitionActive: false,
      });
      return;
    }

    this.run = null;
    this.#clearVideo();
    this.#startInputPolling();
    this.root.researchUi?.resetAffect?.("native-failure-boundary");
    this.root.researchUi?.setMode?.("setup");
    if (failureReceipt) {
      this.#showSetupError(`${context} (${failureReceipt.failureCode}). Recovery ${failureReceipt.recoveryId} is available at the last safe boundary.`);
    } else {
      this.#showSetupError(`${context}: ${messageOf(error)} The attempt was finalized as ${finishReceipt.completionStatus}.`);
    }
    await this.#refreshParticipantStates();
  }

  #scheduleFailClosed(fence, error, options) {
    if (!this.#runMatches(fence) || this.run.terminalInFlight) return;
    this.run.terminalInFlight = "failClosedPending";
    this.#video().pause?.();
    this.#queue(() => this.#failClosedLifecycle(fence, error, options));
  }

  #startPolling() {
    this.#stopPolling();
    const fence = this.#captureRunFence();
    if (!fence) return;
    this.pollTimer = this.setInterval?.(() => {
      if (!this.#runMatches(fence) || this.run.terminalInFlight || this.run.lifecycleInFlight) return;
      const run = this.run;
      const lifecycleRevision = run.lifecycleRevision;
      const requestSequence = ++run.statusRequestSequence;
      void this.invoke("research_run_status")
        .then((status) => {
          if (!nativeStatusPollMayProject(run, fence, lifecycleRevision, requestSequence)) return;
          if (!this.#statusMatches(status, fence)) {
            this.#markTimingHandshakeFailed();
            this.#scheduleFailClosed(fence, new Error("Native status did not match the active renderer run."), {
              context: "Native status synchronization failed",
            });
            return;
          }
          if (!this.#statusOperationalForRun(status, run)) {
            this.#markTimingHandshakeFailed();
            this.#scheduleFailClosed(fence, new Error("Native status reported an unhealthy or divergent run."), {
              context: "Native status synchronization failed",
            });
            return;
          }
          run.lastProjectedStatusSequence = requestSequence;
          this.#projectStatus(status, fence);
          if (run.transitionActive
            && status.transitionReady
            && run.settings.experiment.betweenVideos.mode !== "continueWhenReady") {
            this.#queue(() => this.#continueRun(fence));
          }
        })
        .catch((error) => {
          if (!nativeStatusPollMayProject(run, fence, lifecycleRevision, requestSequence)) return;
          this.#markTimingHandshakeFailed();
          this.#scheduleFailClosed(fence, error, { context: "Native status polling failed" });
        });
    }, STATUS_POLL_MS);
  }

  #stopPolling() {
    if (this.pollTimer !== null) this.clearInterval?.(this.pollTimer);
    this.pollTimer = null;
  }

  #projectStatus(status, fence) {
    if (!this.#statusMatches(status, fence) || this.run.terminalInFlight) return false;
    const run = this.run;
    run.lastStatus = status;
    const stimulus = this.#currentStimulus(run);
    const transitionMode = run.settings.experiment.betweenVideos.mode;
    const transitionMessage = status.transitionRemainingMs === null
      ? "Sampling is stopped and the rating is neutral. Continue when ready."
      : status.transitionReady
        ? "Sampling is stopped and the rating is neutral. Preparing the next complete video."
        : `Sampling is stopped and the rating is neutral. Next video in ${(status.transitionRemainingMs / 1_000).toFixed(1)} seconds.`;
    this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
      stimulus: `${run.index + 1}/${run.assignment.slots.length} · ${stimulus.title}`,
      timing: `${status.sampleCount} rows · ${status.gapEventCount} gap events · ${status.missedSlotCount} missed slots`,
      write: status.writeHealthy ? "Native journal synced" : `Write failure: ${status.failureCode ?? "unknown"}`,
      lsl: status.lslEnabled ? "Streaming" : "Off",
      x: status.currentValence,
      y: status.currentArousal,
      paused: status.phase === "paused",
      transitionActive: run.transitionActive,
      transitionMode,
      transitionMessage,
    });
    return true;
  }

  #currentStimulus(run = this.run) {
    const slot = run?.assignment?.slots?.[run.index];
    const stimulus = slot && run.plan.stimuli.find(({ stimulusId }) => stimulusId === slot.stimulusId);
    if (!stimulus) throw new Error("The current native assignment slot is unavailable.");
    return stimulus;
  }

  #clearVideo() {
    this.#clearMediaListeners();
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
      const fence = this.#captureRunFence();
      if (fence && !this.run.terminalInFlight) {
        this.#scheduleFailClosed(fence, error, { context: "Unhandled native bridge operation failed" });
        return;
      }
      this.#video().pause?.();
      this.#dispatch(RESEARCH_UI_EVENTS.runStatus, {
        stimulus: "Native run outcome unknown — restart required",
        timing: "Local playback is paused while native state remains unreconciled.",
        write: message,
        paused: true,
        transitionActive: false,
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
