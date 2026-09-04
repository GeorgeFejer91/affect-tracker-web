import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  authorizeDesktopPlaybackMode,
  closeMalformedNativeStartBoundary,
  closeNativeRendererFailureBoundary,
  invokeNativeRunActivation,
  mediaFailureReport,
  nativeInputBindingSupported,
  nativeFinalizeReceiptMatches,
  nativeInputPresetAvailability,
  nativeInputRegionRequest,
  nativeMediaGenerationMatches,
  nativePendingFinalizationContract,
  participantStateDetail,
  probeAndAttestNativeVideo,
  nativeRendererRunFenceMatches,
  nativeRunStatusHandshake,
  nativeRunStatusMatchesFence,
  nativeStartReceiptMatches,
  nativeStatusPollMayProject,
  selectPendingNativeFinalizationRecovery,
} from "../site/src/research/native-bridge.js";

function nativeStatus(overrides = {}) {
  return {
    active: false,
    runId: null,
    participantId: null,
    attemptNumber: null,
    phase: "finished",
    sampleCount: 0,
    eventCount: 0,
    gapEventCount: 0,
    missedSlotCount: 0,
    coalescedInputUpdateCount: 0,
    currentValence: 0,
    currentArousal: 0,
    inputActive: false,
    activeStimulusPosition: null,
    lastSafeStimulusPosition: 0,
    mediaTimeMs: null,
    transitionDurationMs: null,
    transitionRemainingMs: null,
    transitionReady: false,
    writeHealthy: true,
    lslEnabled: false,
    failureCode: null,
    playbackMode: null,
    playbackQualification: null,
    ...overrides,
  };
}

function finalizedFiles() {
  return ["settings.snapshot.json", "events.jsonl", "ratings.csv", "manifest.json"].map((fileName) => ({
    fileName,
    sha256: "a".repeat(64),
    byteLength: 1,
  }));
}

test("native timing readiness requires a complete bounded RunStatus handshake", () => {
  assert.equal(nativeRunStatusHandshake(nativeStatus()), true);
  assert.equal(nativeRunStatusHandshake(nativeStatus({ sampleCount: -1 })), false);
  assert.equal(nativeRunStatusHandshake(nativeStatus({ coalescedInputUpdateCount: -1 })), false);
  assert.equal(nativeRunStatusHandshake(nativeStatus({ currentValence: 1.01 })), false);
  assert.equal(nativeRunStatusHandshake(nativeStatus({ transitionReady: "yes" })), false);
  assert.equal(nativeRunStatusHandshake(nativeStatus({ phase: "playing" })), false);
  assert.equal(nativeRunStatusHandshake(nativeStatus({ playbackMode: "unqualifiedWebview" })), false);
  assert.equal(nativeRunStatusHandshake(nativeStatus({ writeHealthy: false, failureCode: "write-failed" })), false);
  assert.equal(nativeRunStatusHandshake(nativeStatus({ sampleCount: 1 })), false);
  assert.equal(nativeRunStatusHandshake(nativeStatus({ active: true })), false);
  assert.equal(nativeRunStatusHandshake(nativeStatus({
    active: true,
    runId: "11111111-1111-4111-8111-111111111111",
    participantId: "P001",
    attemptNumber: 1,
    phase: "prepared",
    playbackMode: "unqualifiedWebview",
    playbackQualification: "unqualified",
  })), true);
});

test("renderer fences require both the local epoch and native run ID", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const otherRunId = "22222222-2222-4222-8222-222222222222";
  const run = {
    rendererEpoch: 7,
    receipt: {
      runId,
      participantId: "P001",
      attemptNumber: 1,
      playbackMode: "unqualifiedWebview",
      playbackQualification: "unqualified",
    },
  };
  const fence = { rendererEpoch: 7, runId };
  const matchingStatus = nativeStatus({
    active: true,
    runId,
    participantId: "P001",
    attemptNumber: 1,
    phase: "playing",
    activeStimulusPosition: 1,
    mediaTimeMs: 125,
    playbackMode: "unqualifiedWebview",
    playbackQualification: "unqualified",
  });
  assert.equal(nativeRendererRunFenceMatches(run, fence), true);
  assert.equal(nativeRendererRunFenceMatches(run, { ...fence, rendererEpoch: 6 }), false);
  assert.equal(nativeRendererRunFenceMatches(run, { ...fence, runId: otherRunId }), false);
  assert.equal(nativeRunStatusMatchesFence(matchingStatus, run, fence), true);
  assert.equal(nativeRunStatusMatchesFence({ ...matchingStatus, runId: otherRunId }, run, fence), false);
  assert.equal(nativeRunStatusMatchesFence({ ...matchingStatus, participantId: "P002" }, run, fence), false);
  assert.equal(nativeRunStatusMatchesFence({ ...matchingStatus, attemptNumber: 2 }, run, fence), false);
  assert.equal(nativeRunStatusMatchesFence({
    ...matchingStatus,
    playbackMode: "nativeLibvlc",
    playbackQualification: "qualifiedNative",
  }, run, fence), false);
  assert.equal(nativeRunStatusMatchesFence({ ...matchingStatus, active: false }, run, fence), false);
});

test("media event provenance requires the current detached element and source generation", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const currentVideo = {};
  const priorVideo = {};
  const run = { rendererEpoch: 7, mediaEpoch: 12, receipt: { runId } };
  const fence = { rendererEpoch: 7, runId };
  assert.equal(nativeMediaGenerationMatches(run, fence, 12, currentVideo, currentVideo), true);
  assert.equal(nativeMediaGenerationMatches(run, fence, 11, currentVideo, currentVideo), false);
  assert.equal(nativeMediaGenerationMatches(run, fence, 12, currentVideo, priorVideo), false);
  assert.equal(nativeMediaGenerationMatches(run, { ...fence, rendererEpoch: 6 }, 12, currentVideo, currentVideo), false);
});

test("status polls cannot project across a lifecycle command or newer poll", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const fence = { rendererEpoch: 7, runId };
  const run = {
    rendererEpoch: 7,
    receipt: { runId },
    terminalInFlight: null,
    lifecycleInFlight: false,
    lifecycleRevision: 4,
    lastProjectedStatusSequence: 8,
  };
  assert.equal(nativeStatusPollMayProject(run, fence, 4, 9), true);
  assert.equal(nativeStatusPollMayProject({ ...run, lifecycleInFlight: true }, fence, 4, 9), false);
  assert.equal(nativeStatusPollMayProject(run, fence, 3, 9), false);
  assert.equal(nativeStatusPollMayProject(run, fence, 4, 8), false);
  assert.equal(nativeStatusPollMayProject({ ...run, terminalInFlight: "failClosed" }, fence, 4, 9), false);
});

test("renderer lifecycle failure negotiates one run-bound recovery or partial boundary", async () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const report = mediaFailureReport({
    runId,
    mediaErrorCode: 3,
    stimulusId: "video-a",
    stimulusPosition: 1,
    mediaTimeMs: 250,
  });
  const recoveryCalls = [];
  const recovered = await closeNativeRendererFailureBoundary({
    runId,
    participantId: "P001",
    attemptNumber: 1,
    report,
    async invoke(command, payload) {
      recoveryCalls.push([command, payload]);
      return {
        runId,
        recoveryId: "recovery-1",
        failureCode: "media-decode",
        interruptedStimulusPosition: 1,
        lastSafeStimulusPosition: 0,
      };
    },
  });
  assert.equal(recovered.confirmed, true);
  assert.equal(recovered.failureReceipt.recoveryId, "recovery-1");
  assert.equal(recovered.finishReceipt, null);
  assert.deepEqual(recoveryCalls, [["research_report_media_failure", { report }]]);

  const fallbackCalls = [];
  const finalized = await closeNativeRendererFailureBoundary({
    runId,
    participantId: "P001",
    attemptNumber: 1,
    report,
    async invoke(command, payload) {
      fallbackCalls.push([command, payload]);
      if (command === "research_report_media_failure") throw new Error("report unavailable");
      return {
        runId,
        participantId: "P001",
        attemptNumber: 1,
        completionStatus: "partial",
        outputReceiptId: "33333333-3333-4333-8333-333333333333",
        files: finalizedFiles(),
      };
    },
  });
  assert.equal(finalized.confirmed, true);
  assert.equal(finalized.failureReceipt, null);
  assert.equal(finalized.finishReceipt.outputReceiptId, "33333333-3333-4333-8333-333333333333");
  assert.deepEqual(fallbackCalls.map(([command]) => command), [
    "research_report_media_failure",
    "research_finish_run",
  ]);
  assert.deepEqual(fallbackCalls[1][1], { runId, outcome: "stopEarly" });
});

test("renderer lifecycle failure remains unconfirmed when both native terminal paths fail", async () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const report = mediaFailureReport({
    runId,
    mediaErrorCode: 3,
    stimulusId: "video-a",
    stimulusPosition: 1,
    mediaTimeMs: 250,
  });
  const result = await closeNativeRendererFailureBoundary({
    runId,
    participantId: "P001",
    attemptNumber: 1,
    report,
    async invoke() { throw new Error("native IPC unavailable"); },
  });
  assert.equal(result.confirmed, false);
  assert.equal(result.failureReceipt, null);
  assert.equal(result.finishReceipt, null);
  assert.equal(result.reconciliation, "unavailable");
  assert.match(result.boundaryError.message, /native IPC unavailable/u);
  const stillActive = await closeNativeRendererFailureBoundary({
    runId,
    participantId: "P001",
    attemptNumber: 1,
    report,
    async invoke(command) {
      if (command === "research_run_status") return nativeStatus({
        active: true,
        runId,
        participantId: "P001",
        attemptNumber: 1,
        phase: "playing",
        activeStimulusPosition: 1,
        mediaTimeMs: 250,
        playbackMode: "unqualifiedWebview",
        playbackQualification: "unqualified",
      });
      throw new Error("terminal path unavailable");
    },
  });
  assert.equal(stillActive.confirmed, false);
  assert.equal(stillActive.reconciliation, "nativeStillActive");
  assert.equal(stillActive.reconciliationStatus.runId, runId);
  await assert.rejects(closeNativeRendererFailureBoundary({
    runId,
    participantId: "P001",
    attemptNumber: 1,
    report: { ...report, runId: "22222222-2222-4222-8222-222222222222" },
    async invoke() {},
  }), /one authoritative run ID/u);
});

test("terminal receipts bind run, participant, attempt, outcome, and mandatory artifacts", () => {
  const receipt = {
    runId: "11111111-1111-4111-8111-111111111111",
    participantId: "P001",
    attemptNumber: 2,
    completionStatus: "partial",
    outputReceiptId: "33333333-3333-4333-8333-333333333333",
    files: finalizedFiles(),
  };
  const expected = {
    runId: receipt.runId,
    participantId: "P001",
    attemptNumber: 2,
    completionStatus: "partial",
  };
  assert.equal(nativeFinalizeReceiptMatches(receipt, expected), true);
  assert.equal(nativeFinalizeReceiptMatches({ ...receipt, completionStatus: "completed" }, expected), false);
  assert.equal(nativeFinalizeReceiptMatches({ ...receipt, participantId: "P002" }, expected), false);
  assert.equal(nativeFinalizeReceiptMatches({ ...receipt, files: receipt.files.slice(1) }, expected), false);
  assert.equal(nativeFinalizeReceiptMatches({ ...receipt, files: [...receipt.files, receipt.files[0]] }, expected), false);
});

test("Start and Resume receipts bind the selected participant, hashes, attempt identity, and safe boundary", () => {
  const receipt = {
    runId: "11111111-1111-4111-8111-111111111111",
    participantId: "P001",
    attemptNumber: 2,
    sessionStem: "P001_EF_A27_GW_HR_20260903T143012482Z_R02",
    settingsSha256: "a".repeat(64),
    assignmentPlanSha256: "b".repeat(64),
    outputReceiptId: "33333333-3333-4333-8333-333333333333",
    resumed: false,
    resumeAtStimulusPosition: 1,
    playbackMode: "unqualifiedWebview",
    playbackQualification: "unqualified",
  };
  const expected = {
    participantId: "P001",
    settingsSha256: "a".repeat(64),
    assignmentPlanSha256: "b".repeat(64),
    playbackMode: "unqualifiedWebview",
    resumed: false,
    slotCount: 3,
  };
  assert.equal(nativeStartReceiptMatches(receipt, expected), true);
  assert.equal(nativeStartReceiptMatches({ ...receipt, participantId: "P002" }, expected), false);
  assert.equal(nativeStartReceiptMatches({ ...receipt, attemptNumber: 0 }, expected), false);
  assert.equal(nativeStartReceiptMatches({ ...receipt, settingsSha256: "c".repeat(64) }, expected), false);
  assert.equal(nativeStartReceiptMatches({ ...receipt, outputReceiptId: "output-1" }, expected), false);
  assert.equal(nativeStartReceiptMatches({ ...receipt, sessionStem: "../escape" }, expected), false);
  assert.equal(nativeStartReceiptMatches({ ...receipt, resumeAtStimulusPosition: null }, expected), false);

  const recovery = {
    runId: receipt.runId,
    participantId: "P001",
    attemptNumber: 2,
    lastSafeStimulusPosition: 1,
  };
  const resumed = { ...receipt, resumed: true, resumeAtStimulusPosition: 2 };
  const resumeExpected = { ...expected, resumed: true, recovery };
  assert.equal(nativeStartReceiptMatches(resumed, resumeExpected), true);
  assert.equal(nativeStartReceiptMatches({ ...resumed, resumeAtStimulusPosition: 1 }, resumeExpected), false);
  assert.equal(nativeStartReceiptMatches(resumed, {
    ...resumeExpected,
    recovery: { ...recovery, runId: "22222222-2222-4222-8222-222222222222" },
  }), false);
});

test("malformed Start receipt rollback uses only a matching authoritative native status identity", async () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const calls = [];
  const result = await closeMalformedNativeStartBoundary({
    receipt: { runId: "not-a-run" },
    participantId: "P001",
    playbackMode: "unqualifiedWebview",
    async invoke(command, payload) {
      calls.push([command, payload]);
      if (command === "research_run_status") return nativeStatus({
        active: true,
        runId,
        participantId: "P001",
        attemptNumber: 3,
        phase: "prepared",
        playbackMode: "unqualifiedWebview",
        playbackQualification: "unqualified",
      });
      if (command === "research_finish_run") return {
        runId,
        participantId: "P001",
        attemptNumber: 3,
        completionStatus: "partial",
        outputReceiptId: "33333333-3333-4333-8333-333333333333",
        files: finalizedFiles(),
      };
      throw new Error(`Unexpected ${command}`);
    },
  });
  assert.equal(result.confirmed, true);
  assert.deepEqual(calls.map(([command]) => command), ["research_run_status", "research_finish_run"]);
  assert.deepEqual(calls[1][1], { runId, outcome: "stopEarly" });

  const mismatchCalls = [];
  const mismatch = await closeMalformedNativeStartBoundary({
    receipt: { runId },
    participantId: "P001",
    playbackMode: "unqualifiedWebview",
    async invoke(command) {
      mismatchCalls.push(command);
      return nativeStatus({
        active: true,
        runId: "22222222-2222-4222-8222-222222222222",
        participantId: "P001",
        attemptNumber: 3,
        phase: "prepared",
        playbackMode: "unqualifiedWebview",
        playbackQualification: "unqualified",
      });
    },
  });
  assert.equal(mismatch.confirmed, false);
  assert.equal(mismatch.reconciliation, "statusMismatch");
  assert.deepEqual(mismatchCalls, ["research_run_status"]);
});

test("rejected native activation rolls back only the matching run activated after an idle snapshot", async () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const calls = [];
  let statusReads = 0;
  await assert.rejects(invokeNativeRunActivation({
    command: "research_start_run",
    payload: { request: { opaque: true } },
    participantId: "P001",
    playbackMode: "unqualifiedWebview",
    async invoke(command, payload) {
      calls.push([command, payload]);
      if (command === "research_run_status") {
        statusReads += 1;
        return statusReads === 1 ? nativeStatus() : nativeStatus({
          active: true,
          runId,
          participantId: "P001",
          attemptNumber: 4,
          phase: "prepared",
          playbackMode: "unqualifiedWebview",
          playbackQualification: "unqualified",
        });
      }
      if (command === "research_start_run") throw new Error("IPC response lost after activation");
      if (command === "research_finish_run") return {
        runId,
        participantId: "P001",
        attemptNumber: 4,
        completionStatus: "partial",
        outputReceiptId: "33333333-3333-4333-8333-333333333333",
        files: finalizedFiles(),
      };
      throw new Error(`Unexpected ${command}`);
    },
  }), (error) => {
    assert.equal(error.nativeActivationReconciliation, "rolledBack");
    assert.match(error.message, /rejected after activation; the matching run was finalized as Partial/u);
    return true;
  });
  assert.deepEqual(calls.map(([command]) => command), [
    "research_run_status",
    "research_start_run",
    "research_run_status",
    "research_finish_run",
  ]);
  assert.deepEqual(calls[3][1], { runId, outcome: "stopEarly" });
});

test("rejected native activation never stops an ambiguous or mismatched active identity", async () => {
  const calls = [];
  let statusReads = 0;
  await assert.rejects(invokeNativeRunActivation({
    command: "research_resume_run",
    payload: { request: { opaque: true } },
    participantId: "P001",
    playbackMode: "unqualifiedWebview",
    expectedRunId: "11111111-1111-4111-8111-111111111111",
    expectedAttemptNumber: 2,
    async invoke(command) {
      calls.push(command);
      if (command === "research_run_status") {
        statusReads += 1;
        return statusReads === 1 ? nativeStatus() : nativeStatus({
          active: true,
          runId: "22222222-2222-4222-8222-222222222222",
          participantId: "P001",
          attemptNumber: 3,
          phase: "prepared",
          playbackMode: "unqualifiedWebview",
          playbackQualification: "unqualified",
        });
      }
      if (command === "research_resume_run") throw new Error("IPC rejected");
      throw new Error(`Unexpected terminal command ${command}`);
    },
  }), (error) => {
    assert.equal(error.nativeActivationReconciliation, "unreconciled");
    assert.match(error.message, /does not match this request.*outcome is unknown.*restart/u);
    return true;
  });
  assert.deepEqual(calls, ["research_run_status", "research_resume_run", "research_run_status"]);
});

test("ordinary activation rejection with authoritative idle status needs no rollback", async () => {
  const calls = [];
  await assert.rejects(invokeNativeRunActivation({
    command: "research_start_run",
    payload: { request: { opaque: true } },
    participantId: "P001",
    playbackMode: "unqualifiedWebview",
    async invoke(command) {
      calls.push(command);
      if (command === "research_run_status") return nativeStatus();
      if (command === "research_start_run") throw new Error("validation rejected");
      throw new Error(`Unexpected ${command}`);
    },
  }), (error) => {
    assert.equal(error.nativeActivationReconciliation, "inactiveAfterRejection");
    assert.match(error.message, /rejected before activation/u);
    return true;
  });
  assert.deepEqual(calls, ["research_run_status", "research_start_run", "research_run_status"]);
});

test("pending recovery finalization is reload-only and binds the durable terminal intent", () => {
  const settings = { schema: "affect-research-settings" };
  const assignmentPlan = { schema: "affect-research-assignment-plan" };
  const context = {
    workspaceId: "workspace-opaque",
    participantId: "P001",
    settingsSha256: "a".repeat(64),
    assignmentPlanSha256: "b".repeat(64),
    playbackMode: "unqualifiedWebview",
    settings,
    assignmentPlan,
  };
  const recovery = {
    recoveryId: "recovery-opaque",
    runId: "11111111-1111-4111-8111-111111111111",
    participantId: "P001",
    attemptNumber: 2,
    settingsSha256: "a".repeat(64),
    assignmentPlanSha256: "b".repeat(64),
    playbackMode: "unqualifiedWebview",
    playbackQualification: "unqualified",
    finalizationPending: true,
    pendingCompletionStatus: "partial",
  };
  const contract = nativePendingFinalizationContract(recovery, context);
  assert.deepEqual(contract.request, {
    workspaceId: "workspace-opaque",
    recoveryId: "recovery-opaque",
    settings,
    assignmentPlan,
  });
  assert.deepEqual(contract.expectedReceipt, {
    runId: recovery.runId,
    participantId: "P001",
    attemptNumber: 2,
    completionStatus: "partial",
  });
  assert.equal("inputTestReceiptId" in contract.request, false);
  assert.equal("workspaceFiles" in contract.request, false);
  assert.equal("playbackMode" in contract.request, false);
  assert.equal(nativePendingFinalizationContract({
    ...recovery,
    finalizationPending: false,
    pendingCompletionStatus: null,
  }, context), null);
  assert.throws(() => nativePendingFinalizationContract({
    ...recovery,
    pendingCompletionStatus: null,
  }, context), /not bound to the selected run/u);
  assert.throws(() => nativePendingFinalizationContract({
    ...recovery,
    runId: "renderer-run",
  }, context), /not bound to the selected run/u);
  assert.throws(() => nativePendingFinalizationContract({
    ...recovery,
    finalizationPending: false,
  }, context), /inconsistent or unsupported/u);
});

test("explicit pending finalization cannot be retargeted by a newer resumable recovery", () => {
  const pending = {
    participantId: "P001",
    attemptNumber: 2,
    settingsSha256: "a".repeat(64),
    assignmentPlanSha256: "b".repeat(64),
    playbackMode: "unqualifiedWebview",
    finalizationPending: true,
    pendingCompletionStatus: "partial",
  };
  const newerResumable = {
    ...pending,
    attemptNumber: 3,
    finalizationPending: false,
    pendingCompletionStatus: null,
  };
  const expected = {
    participantId: "P001",
    settingsSha256: "a".repeat(64),
    assignmentPlanSha256: "b".repeat(64),
    playbackMode: "unqualifiedWebview",
    attemptNumber: 2,
    completionStatus: "partial",
  };
  assert.equal(selectPendingNativeFinalizationRecovery([newerResumable, pending], expected), pending);
  assert.equal(selectPendingNativeFinalizationRecovery([newerResumable, pending], {
    ...expected,
    attemptNumber: 3,
  }), null);
  assert.equal(selectPendingNativeFinalizationRecovery([pending], {
    ...expected,
    completionStatus: "completed",
  }), null);
  assert.throws(() => selectPendingNativeFinalizationRecovery([pending, { ...pending }], expected), /duplicate pending finalization identities/u);
});

test("Tauri projects each native input preset through explicit backend capabilities", () => {
  const capability = {
    nativeAuthorityReady: true,
    supportedPresets: [
      "arrowKeys", "wasd", "ijkl", "numpad", "pointerGrid", "mouseButtonsWheel",
      "gamepadDpad", "gamepadLeftStick", "gamepadRightStick", "custom",
    ],
    supportsCustomKeyboard: true,
    supportsCustomMouseButtons: true,
    supportsCustomWheel: true,
    supportsCustomGamepadButtons: true,
    supportsAbsolutePointer: true,
    supportsGamepad: true,
  };
  const availability = nativeInputPresetAvailability(capability);
  assert.equal(availability["arrow-keys"], true);
  assert.equal(availability["pointer-grid"], true);
  assert.equal(availability["gamepad-dpad"], true);

  const pointer = {
    preset: "pointerGrid", kind: "absolute",
    axes: {
      x: { kind: "pointerAxis", axis: "x", invert: false },
      y: { kind: "pointerAxis", axis: "y", invert: true },
    },
  };
  const dpad = {
    preset: "gamepadDpad", kind: "digital",
    directions: {
      up: { kind: "gamepadButton", button: 12 },
      down: { kind: "gamepadButton", button: 13 },
      left: { kind: "gamepadButton", button: 14 },
      right: { kind: "gamepadButton", button: 15 },
    },
  };
  const leftStick = {
    preset: "gamepadLeftStick", kind: "analog",
    axes: {
      x: { kind: "gamepadAxis", index: 0, invert: false },
      y: { kind: "gamepadAxis", index: 1, invert: true },
    },
  };
  const rightStick = {
    ...leftStick,
    preset: "gamepadRightStick",
    axes: {
      x: { kind: "gamepadAxis", index: 2, invert: false },
      y: { kind: "gamepadAxis", index: 3, invert: true },
    },
  };
  const mixedCustom = {
    preset: "custom", kind: "digital",
    directions: {
      up: { kind: "keyboard", code: "KeyW" },
      down: { kind: "mouseButton", button: 0 },
      left: { kind: "wheel", direction: "left" },
      right: { kind: "gamepadButton", button: 0 },
    },
  };
  for (const binding of [pointer, dpad, leftStick, rightStick, mixedCustom]) {
    assert.equal(nativeInputBindingSupported(binding, capability), true);
  }
  assert.equal(nativeInputBindingSupported(pointer, {
    ...capability, supportsAbsolutePointer: false,
  }), false);
  assert.equal(nativeInputBindingSupported(leftStick, {
    ...capability, supportsGamepad: false,
  }), false);
  assert.equal(nativeInputBindingSupported(dpad, {
    ...capability, supportsCustomGamepadButtons: false,
  }), false);
  assert.equal(nativeInputBindingSupported(mixedCustom, {
    ...capability, supportsCustomWheel: false,
  }), false);
  assert.equal(nativeInputBindingSupported({
    ...dpad, directions: { ...dpad.directions, right: undefined },
  }, capability), false);
});

test("native input regions remain bounded to visible client coordinates", () => {
  assert.deepEqual(nativeInputRegionRequest({
    getBoundingClientRect: () => ({ left: 10, top: 20, right: 110, bottom: 220, width: 100, height: 200 }),
  }, "runFeedback", 7, { innerWidth: 800, innerHeight: 600 }), {
    purpose: "runFeedback", layoutEpoch: 7, left: 10, top: 20, width: 100, height: 200,
    viewportWidth: 800, viewportHeight: 600,
  });
});

test("desktop playback defaults qualified and requires an explicit unqualified fallback", () => {
  const unavailable = {
    qualifiedStartAvailable: false,
    playerActorReady: false,
    reasonCode: "runtime-not-staged",
  };
  assert.throws(() => authorizeDesktopPlaybackMode(undefined, unavailable), /Qualified native playback is unavailable/u);
  assert.equal(authorizeDesktopPlaybackMode("unqualifiedWebview", unavailable), "unqualifiedWebview");
  assert.equal(authorizeDesktopPlaybackMode("nativeLibvlc", {
    qualifiedStartAvailable: true,
    playerActorReady: true,
  }), "nativeLibvlc");
  assert.throws(() => authorizeDesktopPlaybackMode("ambientVlc", unavailable), /Unknown Windows playback mode/u);
});

test("native participant projection distinguishes terminal and recoverable partials", () => {
  const detail = participantStateDetail([
    { participantId: "P001", state: "Partial", recoverable: true },
    { participantId: "P002", state: "Partial", recoverable: false },
  ], [{
    participantId: "P001",
    attemptNumber: 2,
    settingsSha256: "a".repeat(64),
    assignmentPlanSha256: "b".repeat(64),
    playbackMode: "unqualifiedWebview",
    pendingCompletionStatus: "partial",
  }]);
  assert.deepEqual(detail, {
    P001: "partial",
    P002: "partial",
    __recoverable: { P001: true, P002: false },
    __finalizationPending: { P001: true, P002: false },
    __finalizationBinding: {
      P001: {
        settingsSha256: "a".repeat(64),
        assignmentPlanSha256: "b".repeat(64),
        playbackMode: "unqualifiedWebview",
        completionStatus: "partial",
        attemptNumber: 2,
      },
    },
  });
});

test("WebView media errors become bounded path-free native interruption reports", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(mediaFailureReport({
    runId,
    mediaErrorCode: 3,
    stimulusId: "video-a",
    stimulusPosition: 2,
    mediaTimeMs: 125.5,
  }), {
    runId,
    reason: "decode",
    stimulusId: "video-a",
    stimulusPosition: 2,
    mediaTimeMs: 125.5,
  });
  assert.equal("path" in mediaFailureReport({
    runId,
    mediaErrorCode: 4,
    stimulusId: "video-a",
    stimulusPosition: 1,
    mediaTimeMs: 0,
  }), false);
  assert.throws(() => mediaFailureReport({
    runId: "stale-renderer-selected-run",
    mediaErrorCode: 3,
    stimulusId: "video-a",
    stimulusPosition: 1,
    mediaTimeMs: 0,
  }), /active native run and opaque stimulus position/u);
});

class ProbeVideo extends EventTarget {
  constructor() {
    super();
    this.duration = 12.5;
    this.videoWidth = 1_920;
    this.videoHeight = 1_080;
    this._currentTime = 0;
    this.paused = true;
    this.seeks = [];
    this.decodedFrames = [];
  }

  get currentTime() { return this._currentTime; }

  set currentTime(value) {
    this._currentTime = value;
    this.seeks.push(value);
    queueMicrotask(() => this.dispatchEvent(new Event("seeked")));
  }

  load() {
    if (!this.src) return;
    queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata")));
  }

  async play() {
    this.paused = false;
  }

  pause() { this.paused = true; }
  removeAttribute(name) { if (name === "src") this.src = ""; }
  requestVideoFrameCallback(callback) {
    const mediaTime = this.currentTime;
    this.decodedFrames.push(mediaTime);
    queueMicrotask(() => callback(0, { mediaTime }));
    return this.decodedFrames.length;
  }
}

test("native WebView attestation requires near-start, midpoint, and near-end decoded frames", async () => {
  const calls = [];
  const verified = {
    workspaceFileId: "file-opaque-1",
    displayName: "Complete Video.mp4",
    sha256: "a".repeat(64),
    byteLength: 4_096,
    mimeType: "video/mp4",
    durationMs: 12_500,
    decodeStatus: "attestedUnqualified",
    decodeBackend: "webviewVideoFrameCallback",
    decodeAttestation: "representativeFramesV1",
    decodedPositionsMs: [250, 6_250, 12_250],
    source: {
      kind: "workspaceFile",
      relativePath: "stimuli/.workspace/file-opaque-1",
      mimeType: "video/mp4",
      sha256: "a".repeat(64),
      byteLength: 4_096,
      durationMs: 12_500,
    },
  };
  let clock = 100;
  const result = await probeAndAttestNativeVideo({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    summary: {
      ...verified,
      durationMs: null,
      decodeStatus: "unverified",
      decodeBackend: null,
      decodeAttestation: null,
      decodedPositionsMs: [],
      source: null,
    },
    videoFactory: () => new ProbeVideo(),
    performanceNow: () => { clock += 100; return clock; },
    async invoke(command, payload) {
      calls.push([command, structuredClone(payload)]);
      if (command === "research_workspace_media_url") {
        return {
          mediaGrantId: "grant-opaque-1",
          workspaceFileId: "file-opaque-1",
          mediaUrl: "http://research-media.localhost/grant-opaque-1",
          byteLength: 4_096,
          mimeType: "video/mp4",
          durationMs: null,
          decodeStatus: "unverified",
          decodeBackend: null,
          decodeAttestation: null,
          decodedPositionsMs: [],
        };
      }
      if (command === "research_attest_workspace_decode") return verified;
      throw new Error(`Unexpected command ${command}`);
    },
  });
  assert.deepEqual(result, verified);
  assert.deepEqual(calls.map(([command]) => command), [
    "research_workspace_media_url",
    "research_attest_workspace_decode",
  ]);
  const attestation = calls[1][1].attestation;
  assert.equal(attestation.attestationKind, "attestRepresentativeFramesV1");
  assert.equal(attestation.decodeBackend, "webviewVideoFrameCallback");
  assert.equal(attestation.observedDurationMs, 12_500);
  assert.equal(attestation.videoWidth, 1_920);
  assert.equal(attestation.videoHeight, 1_080);
  assert.ok(attestation.mutedPlaybackMs >= 50);
  assert.deepEqual(attestation.decodedPositionsMs, [250, 6_250, 12_250]);
  assert.equal("path" in attestation, false);
  assert.equal("relativePath" in attestation, false);
});

test("native metadata and seeking cannot pass without frame callbacks, and the grant is revoked", async () => {
  const video = new ProbeVideo();
  video.requestVideoFrameCallback = undefined;
  const calls = [];
  const summary = {
    workspaceFileId: "file-opaque-2",
    displayName: "Metadata Only.mp4",
    sha256: "b".repeat(64),
    byteLength: 2_048,
    mimeType: "video/mp4",
    durationMs: null,
    decodeStatus: "unverified",
    decodeBackend: null,
    decodeAttestation: null,
    decodedPositionsMs: [],
    source: null,
  };
  await assert.rejects(probeAndAttestNativeVideo({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    summary,
    videoFactory: () => video,
    probeTimeoutMs: 25,
    async invoke(command, payload) {
      calls.push([command, structuredClone(payload)]);
      if (command === "research_workspace_media_url") {
        return {
          mediaGrantId: "grant-opaque-2",
          workspaceFileId: summary.workspaceFileId,
          mediaUrl: "http://research-media.localhost/grant-opaque-2",
          byteLength: summary.byteLength,
          mimeType: summary.mimeType,
          durationMs: null,
          decodeStatus: "unverified",
          decodeBackend: null,
          decodeAttestation: null,
          decodedPositionsMs: [],
        };
      }
      if (command === "research_attest_workspace_decode") return summary;
      throw new Error(`Unexpected command ${command}`);
    },
  }), /Decoded-frame verification requires desktop Chrome or Edge/u);
  assert.deepEqual(calls.map(([command]) => command), [
    "research_workspace_media_url",
    "research_attest_workspace_decode",
  ]);
  assert.deepEqual(calls[1][1].attestation, {
    attestationKind: "revokeGrant",
    decodeBackend: "webviewVideoFrameCallback",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    mediaGrantId: "grant-opaque-2",
    workspaceFileId: summary.workspaceFileId,
    sha256: summary.sha256,
    byteLength: summary.byteLength,
    mimeType: summary.mimeType,
  });
});

test("desktop entrypoint activates only the path-free Research native bridge", async () => {
  const [html, source] = await Promise.all([
    readFile(new URL("../desktop/index.html", import.meta.url), "utf8"),
    readFile(new URL("../site/src/research/native-bridge.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /src="\.\.\/site\/src\/research\/native-bridge\.js"/u);
  assert.doesNotMatch(html, /runtime-bridge\.js|app\.js/u);
  for (const command of [
    "research_choose_workspace",
    "research_rescan_stimuli",
    "research_import_stimuli",
    "research_native_media_capability",
    "research_input_capability",
    "research_input_set_region",
    "research_input_begin_test",
    "research_input_begin_capture",
    "research_input_status",
    "research_storage_readiness",
    "research_start_run",
    "research_resume_run",
    "research_finalize_recovery",
    "research_run_status",
    "research_finish_run",
    "research_report_media_failure",
  ]) assert.match(source, new RegExp(`"${command}"`, "u"));
  assert.match(source, /selectionEnabled/u);
  assert.match(source, /playbackMode/u);
  assert.match(source, /decodeQualification: "attestedUnqualified"/u);
  assert.match(source, /this\.nativeTimingReady = nativeRunStatusHandshake\(status\)/u);
  assert.doesNotMatch(source, /timingWorkerReady:\s*true/u);
  assert.match(source, /const video = previous\.cloneNode\?\.\(false\)/u);
  assert.match(source, /#mediaGenerationMatches\(fence, mediaEpoch, video\)/u);
  assert.match(source, /this\.run\.lifecycleInFlight/u);
  assert.match(source, /run\.terminalInFlight = "failClosedPending"/u);
  assert.match(source, /Native run outcome unknown — restart required/u);
  assert.match(source, /Native recovery-finalization receipt did not match the pending durable run contract/u);
  assert.match(source, /selectPendingNativeFinalizationRecovery\(compatibleRecoveries/u);
  assert.match(source, /receipt = await this\.#activateNativeRun\(\{\s*command: "research_resume_run"/u);
  assert.match(source, /receipt = await this\.#activateNativeRun\(\{\s*command: "research_start_run"/u);
  assert.match(source, /if \(pendingFinalization\)[\s\S]+research_finalize_recovery[\s\S]+return;/u);
  assert.match(source, /Native status did not match the active renderer run/u);
  assert.doesNotMatch(source, /Stopped by native error/u);
  assert.doesNotMatch(source, /research_update_affect_state|research_gamepad_button/u);
  assert.doesNotMatch(source, /invoke\([^\n]+(?:filePath|rootPath|outputPath)/u);
});
