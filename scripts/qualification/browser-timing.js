import { BrowserWorkerTimingAccumulator } from "./browser-timing-metrics.js";

const query = (selector) => document.querySelector(selector);
const frequencyField = query("#frequency-hz");
const durationField = query("#duration-seconds");
const commitField = query("#candidate-commit");
const hardwareField = query("#hardware-record");
const startButton = query("#start-run");
const stopButton = query("#stop-run");
const downloadButton = query("#download-receipt");
const status = query("#run-status");
const receiptOutput = query("#receipt-json");

let worker = null;
let accumulator = null;
let sessionToken = null;
let commandSequence = 1;
let requestedDurationSeconds = null;
let startedAt = null;
let stoppedAt = null;
let startedMonotonicMs = null;
let stopTimer = null;
let stateTimer = null;
let protocolTimer = null;
let pendingCommand = null;
let statePolarity = 1;
let stopping = false;
let receipt = null;
let visibilityLossCount = 0;
let hiddenStartedAt = null;
let hiddenDurationMs = 0;

const commitFromQuery = new URL(location.href).searchParams.get("commit");
if (/^[0-9a-f]{40}$/u.test(commitFromQuery ?? "")) commitField.value = commitFromQuery;

function setStatus(message, state = "idle") {
  status.textContent = message;
  status.dataset.state = state;
}

function setControls(running, canStop = false) {
  startButton.disabled = running;
  stopButton.disabled = !running || !canStop;
  for (const field of [frequencyField, durationField, commitField, hardwareField]) field.disabled = running;
}

function clearTimers() {
  if (stopTimer !== null) clearTimeout(stopTimer);
  if (stateTimer !== null) clearInterval(stateTimer);
  if (protocolTimer !== null) clearTimeout(protocolTimer);
  stopTimer = null;
  stateTimer = null;
  protocolTimer = null;
}

function terminateWorker() {
  clearTimers();
  worker?.terminate();
  worker = null;
  pendingCommand = null;
  stopping = false;
  setControls(false);
}

function failRun(message) {
  terminateWorker();
  setStatus(message, "error");
}

function workerCommand(type, details = {}) {
  if (pendingCommand) throw new Error(`Worker command ${pendingCommand.type} is still pending.`);
  const commandId = commandSequence;
  commandSequence += 1;
  pendingCommand = { commandId, type, details: structuredClone(details) };
  worker.postMessage({ type, commandId, sessionToken, ...details });
  return commandId;
}

function armProtocolTimeout(message) {
  if (protocolTimer !== null) clearTimeout(protocolTimer);
  protocolTimer = setTimeout(() => failRun(message), 5_000);
}

function clearProtocolTimeout() {
  if (protocolTimer !== null) clearTimeout(protocolTimer);
  protocolTimer = null;
}

function currentMappedMonotonicMs() {
  return performance.now();
}

function stateRecord(currentValence) {
  const anchorMonotonicMs = currentMappedMonotonicMs();
  return {
    currentValence,
    currentArousal: 0,
    targetValence: currentValence,
    targetArousal: 0,
    animationActive: true,
    inputActive: true,
    stimulusTimeMs: startedAt ? Math.max(0, Date.now() - Date.parse(startedAt)) : 0,
    mappingValues: {},
    anchorMonotonicMs,
  };
}

function sendMeasuredState() {
  statePolarity *= -1;
  const state = stateRecord(statePolarity * 0.25);
  accumulator.noteStateUpdate(state);
  worker.postMessage({ type: "state", sessionToken, state });
}

function updateLiveEvidence() {
  query("#sample-count").textContent = String(accumulator.sampleCount);
  query("#gap-count").textContent = String(accumulator.gapEventCount);
  query("#missed-count").textContent = String(accumulator.missedSlotCount);
  query("#corrupt-count").textContent = String(accumulator.corruptRecordCount + accumulator.sequenceErrorCount);
}

function environmentRecord() {
  const userAgentData = navigator.userAgentData;
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGiB: navigator.deviceMemory ?? null,
    userAgentBrands: userAgentData?.brands?.map(({ brand, version }) => ({ brand, version })) ?? null,
    userAgentPlatform: userAgentData?.platform ?? null,
    crossOriginIsolated,
    secureContext: isSecureContext,
    visibilityLossCount,
    hiddenDurationMs: Math.round(hiddenDurationMs),
  };
}

function finalizeReceipt() {
  stoppedAt = new Date().toISOString();
  if (hiddenStartedAt !== null) {
    hiddenDurationMs += performance.now() - hiddenStartedAt;
    hiddenStartedAt = performance.now();
  }
  try {
    receipt = accumulator.receipt({
      candidateCommit: commitField.value.trim(),
      hardwareRecord: hardwareField.value.trim(),
      startedAt,
      finalizedAt: stoppedAt,
      requestedDurationSeconds,
      actualDurationMs: performance.now() - startedMonotonicMs,
      environment: environmentRecord(),
    });
    receiptOutput.textContent = `${JSON.stringify(receipt, null, 2)}\n`;
    downloadButton.disabled = false;
    setStatus(receipt.workerThresholdsPassed
      ? "Worker-only thresholds passed. Full application qualification is still required."
      : "Diagnostic complete. One or more worker-only thresholds did not pass.",
    receipt.workerThresholdsPassed ? "pass" : "warning");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Receipt construction failed.", "error");
  } finally {
    terminateWorker();
  }
}

function requestStop() {
  if (!worker || stopping) return;
  stopping = true;
  clearTimers();
  setStatus("Stopping at the current worker boundary…", "running");
  workerCommand("stimulus-stop", { stimulusEpoch: 1 });
  armProtocolTimeout("The sampling worker did not acknowledge the stop boundary.");
}

function handleWorkerMessage({ data }) {
  if (!worker || data?.sessionToken !== sessionToken) {
    failRun("The worker response did not bind the active diagnostic session.");
    return;
  }
  if (data.type === "ready") {
    clearProtocolTimeout();
    if (data.samplingFrequencyHz !== accumulator.frequencyHz
      || data.clockDomain !== "controller-performance-v1"
      || !Number.isFinite(data.workerTimeOriginMs)
      || !Number.isFinite(data.clockOffsetMs)) {
      failRun("The worker returned an invalid timing-domain handshake.");
      return;
    }
    worker.postMessage({ type: "state", sessionToken, state: stateRecord(0) });
    workerCommand("stimulus-start", {
      stimulusIndex: 0,
      stimulusId: accumulator.stimulusId,
      stimulusEpoch: accumulator.stimulusEpoch,
    });
    armProtocolTimeout("The sampling worker did not acknowledge the start boundary.");
    return;
  }
  if (data.type === "ack") {
    if (!pendingCommand
      || data.commandId !== pendingCommand.commandId
      || data.commandType !== pendingCommand.type
      || Object.entries(pendingCommand.details).some(([key, value]) => data[key] !== value)) {
      failRun("The sampling worker acknowledgement changed command provenance.");
      return;
    }
    const commandType = pendingCommand.type;
    pendingCommand = null;
    clearProtocolTimeout();
    if (commandType === "stimulus-start") {
      startedAt = new Date().toISOString();
      startedMonotonicMs = performance.now();
      setControls(true, true);
      setStatus(`Running at ${accumulator.frequencyHz} Hz for ${requestedDurationSeconds} seconds. Keep this browser window visible.`, "running");
      sendMeasuredState();
      stateTimer = setInterval(sendMeasuredState, 2_000);
      stopTimer = setTimeout(requestStop, requestedDurationSeconds * 1_000);
    } else if (commandType === "stimulus-stop") {
      workerCommand("stop");
      armProtocolTimeout("The sampling worker did not acknowledge shutdown.");
    } else if (commandType === "stop") {
      finalizeReceipt();
    }
    return;
  }
  if (data.type === "sample" || data.type === "gap") {
    accumulator.acceptMessage(data);
    if (data.type === "gap" || accumulator.sampleCount % 130 === 0) updateLiveEvidence();
    return;
  }
  if (data.type === "error") {
    failRun("The sampling worker rejected the diagnostic protocol.");
    return;
  }
  accumulator.acceptMessage(data);
}

function startRun() {
  if (worker) return;
  if (!commitField.reportValidity() || !hardwareField.reportValidity()
    || !frequencyField.reportValidity() || !durationField.reportValidity()) return;
  const candidateCommit = commitField.value.trim();
  if (!/^[0-9a-f]{40}$/u.test(candidateCommit)) {
    commitField.setCustomValidity("Enter the exact lowercase 40-character candidate Git SHA.");
    commitField.reportValidity();
    return;
  }
  commitField.setCustomValidity("");
  const frequencyHz = Number(frequencyField.value);
  requestedDurationSeconds = Number(durationField.value);
  sessionToken = `browser-worker-${crypto.randomUUID()}`;
  commandSequence = 1;
  pendingCommand = null;
  statePolarity = 1;
  stopping = false;
  receipt = null;
  startedAt = null;
  stoppedAt = null;
  startedMonotonicMs = null;
  visibilityLossCount = 0;
  hiddenDurationMs = 0;
  hiddenStartedAt = document.visibilityState === "hidden" ? performance.now() : null;
  accumulator = new BrowserWorkerTimingAccumulator({ frequencyHz, sessionToken });
  receiptOutput.textContent = "No receipt yet.";
  downloadButton.disabled = true;
  updateLiveEvidence();
  setControls(true, false);
  setStatus("Starting the sampling worker…", "running");
  worker = new Worker("../../site/src/research/sampling-worker.js", { type: "module", name: "affect-research-browser-timing" });
  worker.addEventListener("message", handleWorkerMessage);
  worker.addEventListener("error", () => failRun("The sampling worker failed."));
  worker.addEventListener("messageerror", () => failRun("The sampling worker returned an unreadable message."));
  worker.postMessage({
    type: "configure",
    sessionToken,
    controllerTimeOriginMs: performance.timeOrigin,
    samplingFrequencyHz: frequencyHz,
  });
  armProtocolTimeout("The sampling worker readiness handshake timed out.");
}

function downloadReceipt() {
  if (!receipt) return;
  const blob = new Blob([`${JSON.stringify(receipt, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `browser-worker-${receipt.candidateCommit.slice(0, 12)}-${receipt.configuration.samplingFrequencyHz}hz.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

document.addEventListener("visibilitychange", () => {
  if (!worker) return;
  if (document.visibilityState === "hidden" && hiddenStartedAt === null) {
    visibilityLossCount += 1;
    hiddenStartedAt = performance.now();
  } else if (document.visibilityState === "visible" && hiddenStartedAt !== null) {
    hiddenDurationMs += performance.now() - hiddenStartedAt;
    hiddenStartedAt = null;
  }
});

startButton.addEventListener("click", startRun);
stopButton.addEventListener("click", requestStop);
downloadButton.addEventListener("click", downloadReceipt);
query("#diagnostic-form").addEventListener("submit", (event) => {
  event.preventDefault();
  startRun();
});
commitField.addEventListener("input", () => commitField.setCustomValidity(""));
window.addEventListener("beforeunload", terminateWorker);
