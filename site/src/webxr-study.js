import {
  affectParameters,
  buildFlubberPath,
  clamp,
  createProfiles,
  createProjectionOffsets,
} from "./math.js?v=shape-1";
import {
  advanceWebXrAffectWithPolar,
  applyWebXrRemoteCoordinates,
  controllerFacingModelMatrix,
  createEquirectSphereVertices,
  matrixWithoutTranslation,
  modelMatrix,
  multiplyMatrices,
  normalizeWebhookUrl,
  readQuestControllerState,
  WEBXR_SAMPLE_INTERVAL_MS,
  webXrCsv,
} from "./webxr-study-core.js";
import {
  stimulusDurationSeconds,
  stimulusFilenameToken,
  WEBXR_STIMULI,
  webXrStimulusById,
} from "./webxr-stimuli.js";
import {
  createPolarH10BrowserSession,
  normalizePolarMetric,
  POLAR_METRICS,
  polarWebBluetoothSupport,
} from "./polar-stream.js?v=remote-13";
import { createFlubberReceiver } from "./flubber-remote.js?v=collaboration-4";

const VIDEO_MODEL = modelMatrix(0, 1.55, -2.8, 2.4, 1.35);
const SPHERE_MODEL = modelMatrix(0, 0, 0, 1, 1);
const IMMERSIVE_FLUBBER_MODEL = modelMatrix(0, -0.72, -2.2, 0.62, 0.7);
const FLUBBER_CANVAS_WIDTH = 512;
const FLUBBER_CANVAS_HEIGHT = 576;
const COUNTDOWN_MS = 3_000;

const elements = {
  canvas: document.querySelector("#xr-canvas"),
  video: document.querySelector("#study-video"),
  stimulus: document.querySelector("#stimulus-select"),
  stimulusName: document.querySelector("#stimulus-name"),
  stimulusDescription: document.querySelector("#stimulus-description"),
  stimulusMetadata: document.querySelector("#stimulus-metadata"),
  stimulusWarning: document.querySelector("#stimulus-warning"),
  presentationMode: document.querySelector("#presentation-mode"),
  passthroughVideoOption: document.querySelector("#passthrough-video-option"),
  presentationNote: document.querySelector("#presentation-note"),
  webhook: document.querySelector("#webhook-url"),
  controllerFollow: document.querySelector("#controller-follow-enabled"),
  controllerFollowControls: document.querySelector("#controller-follow-controls"),
  controllerFollowHand: document.querySelector("#controller-follow-hand"),
  flubberSize: document.querySelector("#flubber-size"),
  flubberSizeOutput: document.querySelector("#flubber-size-output"),
  flubberBaseShape: document.querySelector("#flubber-base-shape"),
  polarStatus: document.querySelector("#webxr-polar-status"),
  polarSupport: document.querySelector("#webxr-polar-support"),
  polarBattery: document.querySelector("#webxr-polar-battery"),
  polarConnect: document.querySelector("#webxr-polar-connect"),
  polarDisconnect: document.querySelector("#webxr-polar-disconnect"),
  polarEcgPort: document.querySelector("#webxr-polar-ecg-port"),
  polarEcg: document.querySelector("#webxr-polar-ecg"),
  polarRate: document.querySelector("#webxr-polar-rate"),
  polarSamples: document.querySelector("#webxr-polar-samples"),
  polarX: document.querySelector("#webxr-polar-x"),
  polarY: document.querySelector("#webxr-polar-y"),
  polarXValue: document.querySelector("#webxr-polar-x-value"),
  polarYValue: document.querySelector("#webxr-polar-y-value"),
  remotePanel: document.querySelector("#webxr-remote-panel"),
  remoteStatus: document.querySelector("#webxr-remote-status"),
  remoteUse: document.querySelector("#webxr-remote-use"),
  remoteStop: document.querySelector("#webxr-remote-stop"),
  remoteSources: document.querySelector("#webxr-remote-sources"),
  remoteDetails: document.querySelector("#webxr-remote-details"),
  remoteSource: document.querySelector("#webxr-remote-source"),
  remoteValues: document.querySelector("#webxr-remote-values"),
  remoteRoute: document.querySelector("#webxr-remote-route"),
  remoteQuality: document.querySelector("#webxr-remote-quality"),
  remoteMode: document.querySelector("#webxr-remote-mode"),
  start: document.querySelector("#start-vr"),
  download: document.querySelector("#download-csv"),
  status: document.querySelector("#study-status"),
};

const state = {
  session: undefined,
  referenceSpace: undefined,
  viewerSpace: undefined,
  sessionId: "",
  webhookUrl: "",
  phase: "idle",
  countdownEndsAt: 0,
  runStartedAt: 0,
  previousFrameAt: 0,
  previousSampleAt: 0,
  targetX: 0,
  targetY: 0,
  currentX: 0,
  currentY: 0,
  phaseRadians: 0,
  stickX: 0,
  stickY: 0,
  controllerHand: "unknown",
  controllerFollowEnabled: false,
  controllerFollowHand: "right",
  flubberSize: 1,
  flubberBaseShape: "circle",
  presentationMode: "virtual",
  controllerTracking: false,
  controllerRigModel: undefined,
  resetPressed: false,
  pausePressed: false,
  paused: false,
  finalizing: false,
  records: [],
  lastCsv: "",
  lastFilename: "",
  stimulus: WEBXR_STIMULI[0],
  polarConnected: false,
  polarConnecting: false,
  polarBatteryPercent: undefined,
  polarMetrics: {},
  polarMappings: {
    valence: { metric: "manual" },
    arousal: { metric: "manual" },
  },
  polarHudText: "",
  remote: { enabled: false, phase: "idle", sources: [] },
  remoteHudText: "",
  wakeLock: undefined,
  pendingRemoteEvents: [],
};

const profiles = createProfiles();
let offsets = createProjectionOffsets("webxr-preview", profiles.waveCount);
let renderer;
const polarSession = createPolarH10BrowserSession({ allowQuestExperiment: true });
const flubberReceiver = createFlubberReceiver();
let polarEcgWindow = [];

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("is-error", error);
}

function polarMetricById(metricId) {
  return POLAR_METRICS.find((metric) => metric.id === metricId);
}

function formatPolarMetric(metricId, value) {
  const metric = polarMetricById(metricId);
  if (!metric || !Number.isFinite(value)) return "Waiting for metric";
  const magnitude = Math.abs(value);
  const digits = magnitude >= 1_000 ? 0 : magnitude >= 100 ? 1 : magnitude >= 10 ? 2 : 3;
  return `${value.toFixed(digits)} ${metric.unit}`;
}

function polarAxisReading(axis) {
  const mapping = state.polarMappings[axis];
  if (!mapping || mapping.metric === "manual") return { mapping: { metric: "manual" } };
  const value = state.polarMetrics[mapping.metric];
  return {
    mapping,
    value,
    normalized: state.polarConnected ? normalizePolarMetric(value, mapping) : undefined,
  };
}

function updatePolarMappingUi() {
  for (const [axis, select, output] of [
    ["valence", elements.polarX, elements.polarXValue],
    ["arousal", elements.polarY, elements.polarYValue],
  ]) {
    const reading = polarAxisReading(axis);
    if (state.remote.enabled) output.value = "Incoming signal owns this axis";
    else if (reading.mapping.metric === "manual") output.value = "Right thumbstick";
    else if (!state.polarConnected) output.value = "Connect H10 first";
    else if (reading.normalized === undefined) output.value = formatPolarMetric(reading.mapping.metric, reading.value);
    else output.value = `${formatPolarMetric(reading.mapping.metric, reading.value)} → ${reading.normalized.toFixed(3)}`;
    select.disabled = Boolean(state.session) || state.remote.enabled;
  }
  const summaries = [
    ["X", polarAxisReading("valence")],
    ["Y", polarAxisReading("arousal")],
  ].filter(([, reading]) => reading.normalized !== undefined).map(([axis, reading]) => {
    const metric = polarMetricById(reading.mapping.metric);
    return `${axis} ${metric?.shortLabel ?? reading.mapping.metric} ${reading.normalized >= 0 ? "+" : ""}${reading.normalized.toFixed(2)}`;
  });
  state.polarHudText = summaries.length ? summaries.join(" · ") : "";
}

function setPolarMapping(axis, metricId) {
  const metric = polarMetricById(metricId);
  state.polarMappings[axis] = metric
    ? { metric: metric.id, minimum: metric.minimum, maximum: metric.maximum, invert: false }
    : { metric: "manual" };
  updatePolarMappingUi();
  if (state.session) record("event", "polar-mapping", `${axis}:${state.polarMappings[axis].metric}`);
}

function populatePolarMappings() {
  for (const select of [elements.polarX, elements.polarY]) {
    const manual = document.createElement("option");
    manual.value = "manual";
    manual.textContent = "Right thumbstick / manual";
    select.append(manual);
    for (const metric of POLAR_METRICS) {
      const option = document.createElement("option");
      option.value = metric.id;
      option.textContent = `${metric.label} (${metric.unit})`;
      select.append(option);
    }
  }
  setPolarMapping("valence", "manual");
  setPolarMapping("arousal", "manual");
}

function updatePolarConnectionUi(message, error = false) {
  const support = polarWebBluetoothSupport({ allowQuestExperiment: true });
  state.polarStatusMessage = message;
  elements.polarStatus.value = message;
  elements.polarStatus.classList.toggle("is-error", error);
  elements.polarConnect.hidden = state.polarConnected;
  elements.polarDisconnect.hidden = !state.polarConnected;
  elements.polarConnect.disabled = !support.supported || state.polarConnecting || Boolean(state.session) || state.remote.enabled;
  elements.polarDisconnect.disabled = Boolean(state.session) || state.remote.enabled;
  elements.polarBattery.hidden = !Number.isFinite(state.polarBatteryPercent);
  elements.polarBattery.value = Number.isFinite(state.polarBatteryPercent) ? `${state.polarBatteryPercent}%` : "—";
  updatePolarMappingUi();
}

function formatRemoteValues(snapshot) {
  const latest = snapshot.latest;
  if (!latest) return "Waiting";
  const prefix = snapshot.phase === "stale" ? "Holding " : "";
  return `${prefix}X ${latest.currentX >= 0 ? "+" : ""}${latest.currentX.toFixed(3)} · Y ${latest.currentY >= 0 ? "+" : ""}${latest.currentY.toFixed(3)}`;
}

function remoteRouteText(snapshot) {
  const parts = [];
  if (snapshot.forceTurnRequested) parts.push("TURN relay-only test requested");
  if (snapshot.route === "direct") parts.push("Direct P2P");
  else if (snapshot.route === "relay") parts.push("TURN relay");
  if (Number.isFinite(snapshot.rttMs)) parts.push(`${snapshot.rttMs} ms RTT`);
  return parts.join(" · ") || "Negotiating";
}

function remoteQualityText(snapshot) {
  const diagnostics = snapshot?.diagnostics;
  if (!diagnostics?.receivedFrames) return "Waiting for coordinate frames";
  const parts = [`${diagnostics.receivedFrames.toLocaleString()} frames`];
  if (Number.isFinite(diagnostics.p95GapMs)) parts.push(`p95 gap ${diagnostics.p95GapMs} ms`);
  if (Number.isFinite(diagnostics.maxGapMs)) parts.push(`max ${diagnostics.maxGapMs} ms`);
  parts.push(`${diagnostics.staleTransitions} loss warning${diagnostics.staleTransitions === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function remoteModeText() {
  if (state.session) {
    if (state.session.visibilityState === "visible") return "Immersive WebXR foreground";
    if (state.session.visibilityState === "visible-blurred") return "Immersive WebXR · system overlay may throttle delivery";
    return "Immersive WebXR hidden · Meta has backgrounded this session";
  }
  if (state.wakeLock && !state.wakeLock.released) return "Screen wake lock active · enter WebXR for lowest latency";
  return "Browser panel · Meta may deprioritize delivery";
}

function renderRemoteSources(snapshot) {
  elements.remoteSources.replaceChildren();
  const show = snapshot.enabled && !state.session && (
    snapshot.sources.length > 1
    || snapshot.phase === "stale" && snapshot.sources.length > 0
  );
  elements.remoteSources.hidden = !show;
  if (!show) return;
  for (const source of snapshot.sources) {
    const button = document.createElement("button");
    button.type = "button";
    const selected = source.streamId === snapshot.selectedStreamId;
    button.textContent = selected ? `${source.label} — selected` : source.label;
    button.disabled = selected;
    button.setAttribute("aria-pressed", String(selected));
    button.addEventListener("click", () => { void flubberReceiver.selectSource(source.streamId); });
    elements.remoteSources.append(button);
  }
}

function updateRemoteUi(detail = flubberReceiver.snapshot()) {
  state.remote = detail;
  const enabled = detail.enabled;
  elements.remoteUse.hidden = enabled;
  elements.remoteStop.hidden = !enabled;
  elements.remoteUse.disabled = Boolean(state.session);
  elements.remoteStop.disabled = Boolean(state.session);
  elements.remoteDetails.hidden = !detail.selectedStreamId;
  elements.remoteSource.value = detail.sourceLabel || "—";
  elements.remoteValues.value = formatRemoteValues(detail);
  elements.remoteRoute.value = remoteRouteText(detail);
  elements.remoteQuality.value = remoteQualityText(detail);
  elements.remoteMode.value = remoteModeText();
  renderRemoteSources(detail);

  let fallback = "Incoming signal off";
  if (detail.phase === "discovering") fallback = "Looking for public Affect Tracker broadcasts…";
  else if (detail.phase === "selecting") fallback = "Choose a source below.";
  else if (detail.phase === "connecting") fallback = `Connecting to ${detail.sourceLabel}…`;
  else if (detail.phase === "live") fallback = detail.route === "relay"
    ? `${detail.sourceLabel} is live through a TURN relay.`
    : `${detail.sourceLabel} is live.`;
  else if (detail.phase === "stale") fallback = `${detail.sourceLabel} signal lost; holding the last position.`;
  else if (detail.phase === "error") fallback = "Incoming signal could not connect.";
  elements.remoteStatus.value = detail.message || fallback;
  elements.remoteStatus.classList.toggle("is-error", Boolean(detail.error || detail.phase === "error" || detail.phase === "stale"));
  state.remoteHudText = detail.phase === "stale"
    ? "REMOTE • SIGNAL LOST — HOLDING"
    : detail.phase === "live" ? `${detail.sourceLabel.toUpperCase()} • LIVE` : "";

  updatePolarConnectionUi(state.polarStatusMessage ?? (state.polarConnected ? "Polar H10 ECG is live at 130 Hz" : "Not connected"));
  if (detail.transition) {
    const remoteEvent = {
      event: `remote-${detail.transition}`,
      detail: detail.sourceLabel || detail.message || "incoming",
    };
    if (state.session) record("event", remoteEvent.event, remoteEvent.detail);
    else {
      state.pendingRemoteEvents.push(remoteEvent);
      if (state.pendingRemoteEvents.length > 32) state.pendingRemoteEvents.shift();
    }
  }
}

function drawPolarEcg() {
  const canvas = elements.polarEcg;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#030708";
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (polarEcgWindow.length < 2) return;
  const sorted = [...polarEcgWindow].sort((left, right) => left - right);
  const lower = sorted[Math.floor(sorted.length * 0.02)];
  const upper = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.98))];
  const center = (lower + upper) / 2;
  const halfRange = Math.max(50, (upper - lower) * 0.6);
  context.strokeStyle = "#79e2bd";
  context.lineWidth = 1.4;
  context.beginPath();
  for (let index = 0; index < polarEcgWindow.length; index += 1) {
    const x = index / (polarEcgWindow.length - 1) * canvas.width;
    const y = clamp(0.5 - (polarEcgWindow[index] - center) / (halfRange * 2), 0.04, 0.96) * canvas.height;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();
}

function handlePolarEvent(event) {
  if (event.kind === "status") {
    updatePolarConnectionUi(event.message);
    return;
  }
  if (event.kind === "connection") {
    state.polarConnecting = Boolean(event.recovering);
    state.polarConnected = event.connected;
    state.polarBatteryPercent = Number.isFinite(event.batteryPercent) ? event.batteryPercent : undefined;
    if (!event.connected) {
      state.polarMetrics = {};
      polarEcgWindow = [];
      elements.polarSamples.value = "0";
      elements.polarEcgPort.hidden = true;
      drawPolarEcg();
    }
    updatePolarConnectionUi(event.message, Boolean(event.error));
    if (state.session) {
      const action = event.recovering ? "polar-recovering" : event.recovered ? "polar-recovered" : event.connected ? "polar-connect" : "polar-disconnect";
      record("event", action, "web-bluetooth");
    }
    return;
  }
  if (event.kind === "ecg") {
    polarEcgWindow.push(...event.microvolts);
    if (polarEcgWindow.length > 650) polarEcgWindow.splice(0, polarEcgWindow.length - 650);
    elements.polarSamples.value = event.snapshot.totalEcgSamples.toLocaleString();
    const rate = event.streamHealth?.observedSampleRateHz;
    elements.polarRate.value = `${Math.round(Number.isFinite(rate) ? rate : 130)} Hz`;
    elements.polarEcgPort.hidden = false;
    drawPolarEcg();
    return;
  }
  if (event.kind === "metrics") {
    state.polarMetrics = { ...event.snapshot.values };
    updatePolarMappingUi();
    return;
  }
  if (event.kind === "error") updatePolarConnectionUi(event.message, true);
}

async function connectPolar() {
  state.polarConnecting = true;
  updatePolarConnectionUi("Waiting for the browser Bluetooth chooser…");
  try {
    await polarSession.connect(handlePolarEvent);
  } catch (error) {
    state.polarConnecting = false;
    updatePolarConnectionUi(error?.message ?? String(error), true);
  }
}

async function disconnectPolar() {
  await polarSession.disconnect();
}

async function acquireLowLatencyWakeLock() {
  if (!navigator.wakeLock?.request || document.visibilityState !== "visible") return false;
  if (state.wakeLock && !state.wakeLock.released) return true;
  try {
    const wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock = wakeLock;
    wakeLock.addEventListener("release", () => {
      if (state.wakeLock === wakeLock) state.wakeLock = undefined;
      elements.remoteMode.value = remoteModeText();
    }, { once: true });
    elements.remoteMode.value = remoteModeText();
    return true;
  } catch {
    state.wakeLock = undefined;
    elements.remoteMode.value = remoteModeText();
    return false;
  }
}

async function releaseLowLatencyWakeLock() {
  const wakeLock = state.wakeLock;
  state.wakeLock = undefined;
  if (wakeLock && !wakeLock.released) await wakeLock.release().catch(() => {});
  elements.remoteMode.value = remoteModeText();
}

async function useIncomingSignal() {
  if (state.session) return;
  elements.remoteUse.disabled = true;
  try {
    await acquireLowLatencyWakeLock();
    if (state.polarConnected || state.polarConnecting) await polarSession.disconnect();
    await flubberReceiver.startDiscovery();
  } catch (error) {
    setStatus(`Incoming signal could not start: ${error?.message ?? String(error)}`, true);
  } finally {
    updateRemoteUi();
  }
}

async function stopIncomingSignal() {
  if (state.session) return;
  await flubberReceiver.stop();
  state.remoteHudText = "";
  await releaseLowLatencyWakeLock();
  updateRemoteUi();
  setStatus("Incoming signal stopped. Quest controller and direct Polar input are available again.");
}

function applyStimulus(stimulus, updateUrl = true) {
  if (state.session) return;
  state.stimulus = stimulus;
  elements.video.pause();
  elements.video.setAttribute("src", stimulus.src);
  elements.video.load();
  elements.stimulus.value = stimulus.id;
  elements.stimulusName.textContent = stimulus.title;
  elements.stimulusDescription.textContent = stimulus.description;
  const duration = stimulusDurationSeconds(stimulus);
  const presentation = stimulus.projection === "flat" ? "flat theatre screen" : "full equirectangular 360° sphere";
  const parts = [stimulus.collection, presentation, stimulus.audio ? "with audio" : "silent"];
  if (duration) parts.push(`${duration.toFixed(2)} seconds`, `${stimulus.frameCount} frames`);
  if (stimulus.pilotValence !== undefined && stimulus.pilotArousal !== undefined) {
    parts.push(`CEAP pilot V/A ${stimulus.pilotValence.toFixed(2)} / ${stimulus.pilotArousal.toFixed(2)} (1–9)`);
  }
  elements.stimulusMetadata.textContent = parts.join(" • ");
  elements.stimulusWarning.textContent = stimulus.warning ? `Content note: ${stimulus.warning}` : "";
  elements.stimulusWarning.hidden = !stimulus.warning;
  elements.passthroughVideoOption.disabled = stimulus.projection !== "flat";
  if (stimulus.projection !== "flat" && elements.presentationMode.value === "passthrough-video") {
    elements.presentationMode.value = "virtual";
    if (state.vrSupported !== undefined) updatePresentationControls();
  }
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set("stimulus", stimulus.id);
    history.replaceState(null, "", url);
  }
}

function populateStimulusLibrary() {
  for (const stimulus of WEBXR_STIMULI) {
    const option = document.createElement("option");
    option.value = stimulus.id;
    option.textContent = stimulus.optionLabel;
    elements.stimulus.append(option);
  }
  const requested = new URL(window.location.href).searchParams.get("stimulus");
  applyStimulus(webXrStimulusById(requested), false);
}

function rounded(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : "";
}

function record(recordType, event = "", detail = "") {
  const now = performance.now();
  const hasStimulus = state.presentationMode !== "passthrough-flubber";
  const polarValence = polarAxisReading("valence");
  const polarArousal = polarAxisReading("arousal");
  const remote = flubberReceiver.snapshot(now);
  state.records.push({
    session_id: state.sessionId,
    stimulus_id: hasStimulus ? state.stimulus.id : "",
    stimulus_title: hasStimulus ? state.stimulus.title : "",
    stimulus_collection: hasStimulus ? state.stimulus.collection : "",
    stimulus_projection: hasStimulus ? state.stimulus.projection : "none",
    stimulus_source_start_seconds: hasStimulus ? state.stimulus.sourceStartSeconds : "",
    stimulus_frame_count: hasStimulus ? state.stimulus.frameCount : "",
    stimulus_pilot_valence: hasStimulus ? state.stimulus.pilotValence : "",
    stimulus_pilot_arousal: hasStimulus ? state.stimulus.pilotArousal : "",
    record_type: recordType,
    iso_time: new Date().toISOString(),
    monotonic_ms: rounded(now, 3),
    elapsed_ms: state.runStartedAt ? rounded(now - state.runStartedAt, 3) : 0,
    video_time_seconds: rounded(elements.video.currentTime, 3),
    current_valence: rounded(state.currentX),
    current_arousal: rounded(state.currentY),
    target_valence: rounded(state.targetX),
    target_arousal: rounded(state.targetY),
    stick_x: rounded(state.stickX),
    stick_y: rounded(state.stickY),
    controller_hand: state.controllerHand,
    presentation_mode: state.presentationMode,
    flubber_controller_follow: state.controllerFollowEnabled,
    flubber_follow_hand: state.controllerFollowEnabled ? state.controllerFollowHand : "",
    flubber_size_scale: rounded(state.flubberSize, 2),
    flubber_base_shape: state.flubberBaseShape,
    flubber_tracking: state.controllerFollowEnabled ? state.controllerTracking : "",
    polar_connected: state.polarConnected,
    polar_valence_metric: polarValence.mapping.metric,
    polar_valence_value: rounded(polarValence.value),
    polar_valence_normalized: rounded(polarValence.normalized),
    polar_arousal_metric: polarArousal.mapping.metric,
    polar_arousal_value: rounded(polarArousal.value),
    polar_arousal_normalized: rounded(polarArousal.normalized),
    remote_enabled: remote.enabled,
    remote_source: remote.sourceLabel,
    remote_signal_state: remote.enabled ? remote.phase : "off",
    remote_sequence: remote.latest?.sequence ?? "",
    remote_packet_age_ms: rounded(remote.packetAgeMs, 3),
    paused: state.paused,
    event,
    detail,
  });
}

function sessionFilename(partial) {
  const date = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const stimulus = state.presentationMode === "passthrough-flubber" ? "flubber-only" : stimulusFilenameToken(state.stimulus);
  return `affect-webxr-${stimulus}-${date}${partial ? "-partial" : ""}.csv`;
}

function downloadLastCsv() {
  if (!state.lastCsv) return;
  const url = URL.createObjectURL(new Blob([state.lastCsv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = state.lastFilename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

async function forwardCsv(csv) {
  if (!state.webhookUrl) return "No webhook configured; CSV stayed on this headset.";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(state.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "text/csv;charset=utf-8" },
      body: csv,
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}.`);
    return "CSV delivered to the configured webhook.";
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Webhook timed out after 15 seconds.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function finalize(reason, partial = false, autoDownload = true) {
  if (state.finalizing || state.phase === "idle") return;
  state.finalizing = true;
  state.phase = "finished";
  elements.video.pause();
  record("event", partial ? "study-aborted" : "study-complete", reason);
  state.lastCsv = webXrCsv(state.records);
  state.lastFilename = sessionFilename(partial);
  elements.download.hidden = false;
  elements.start.disabled = true;
  elements.start.textContent = "Run another study";
  setStatus(`${partial ? "Study ended early" : "Study complete"}. CSV ready to save.`);
  if (autoDownload) downloadLastCsv();

  let delivery = "";
  try {
    delivery = await forwardCsv(state.lastCsv);
  } catch (error) {
    delivery = `Webhook delivery failed: ${error?.message ?? String(error)} The CSV is still available below.`;
  }
  setStatus(`${partial ? "Study ended early" : "Study complete"}. ${delivery}`,
    delivery.startsWith("Webhook delivery failed"));
  state.finalizing = false;
  if (!state.session) elements.start.disabled = false;
}

function resetAffect() {
  if (state.remote.enabled) {
    record("event", "reset-ignored", "incoming-signal-owns-both-axes");
    return;
  }
  if (polarAxisReading("valence").normalized === undefined) {
    state.targetX = 0;
    state.currentX = 0;
  }
  if (polarAxisReading("arousal").normalized === undefined) {
    state.targetY = 0;
    state.currentY = 0;
  }
  record("event", "reset", "left-x");
}

async function togglePause() {
  if (state.phase !== "running") return;
  state.paused = !state.paused;
  if (state.presentationMode !== "passthrough-flubber") {
    if (state.paused) elements.video.pause();
    else await elements.video.play();
  }
  record("event", state.paused ? "pause" : "resume", "left-y");
}

function readControllers() {
  const input = readQuestControllerState(state.session?.inputSources);
  state.stickX = input.x;
  state.stickY = input.y;
  state.controllerHand = input.hand;
  if (input.reset && !state.resetPressed) resetAffect();
  if (input.pause && !state.pausePressed) togglePause().catch((error) => {
    setStatus(`Playback could not resume: ${error?.message ?? String(error)}`, true);
  });
  state.resetPressed = input.reset;
  state.pausePressed = input.pause;
  return input;
}

function updateControllerRig(frame, viewerPose) {
  if (!state.controllerFollowEnabled) return;
  const source = Array.from(state.session?.inputSources ?? []).find(
    (candidate) => candidate.handedness === state.controllerFollowHand && candidate.gripSpace,
  );
  const gripPose = source ? frame.getPose(source.gripSpace, state.referenceSpace) : undefined;
  const tracked = Boolean(gripPose && viewerPose?.transform?.position);
  if (tracked) {
    state.controllerRigModel = controllerFacingModelMatrix(
      gripPose.transform.position,
      viewerPose.transform.position,
      0.62 * state.flubberSize,
      0.7 * state.flubberSize,
    );
  }
  if (tracked !== state.controllerTracking) {
    state.controllerTracking = tracked;
    record("event", tracked ? "controller-tracking-acquired" : "controller-tracking-lost", state.controllerFollowHand);
  }
}

async function beginPlayback() {
  if (state.phase !== "countdown") return;
  state.phase = "running";
  state.runStartedAt = performance.now();
  state.previousSampleAt = state.runStartedAt;
  state.paused = false;
  if (state.presentationMode === "passthrough-flubber") {
    record("event", "flubber-only-start", "passthrough");
    return;
  }
  elements.video.currentTime = 0;
  try {
    await elements.video.play();
    record("event", "video-start", state.stimulus.id);
  } catch (error) {
    finalize(`video-play-failed:${error?.name ?? "error"}`, true, false).catch(() => {});
    state.session?.end().then(downloadLastCsv).catch(() => downloadLastCsv());
  }
}

function updateStudy(now, deltaSeconds) {
  const input = readControllers();
  if (state.phase === "countdown" && now >= state.countdownEndsAt) beginPlayback();
  if (state.phase === "running" && !state.paused) {
    const remote = flubberReceiver.snapshot(now);
    state.remote = remote;
    const remoteNext = applyWebXrRemoteCoordinates(state, remote);
    const polarValence = polarAxisReading("valence");
    const polarArousal = polarAxisReading("arousal");
    const next = remoteNext ?? advanceWebXrAffectWithPolar(state, input, deltaSeconds, {
      x: polarValence.normalized,
      y: polarArousal.normalized,
    });
    Object.assign(state, next);
    const frequency = affectParameters(state.currentX, state.currentY).frequency;
    state.phaseRadians = (state.phaseRadians + deltaSeconds * Math.PI * 2 * frequency) % (Math.PI * 2);
    if (now - state.previousSampleAt >= WEBXR_SAMPLE_INTERVAL_MS) {
      state.previousSampleAt += WEBXR_SAMPLE_INTERVAL_MS;
      if (now - state.previousSampleAt >= WEBXR_SAMPLE_INTERVAL_MS) state.previousSampleAt = now;
      record("sample");
    }
  }
}

function renderFrame(now, frame) {
  const session = frame.session;
  const pose = frame.getViewerPose(state.referenceSpace);
  const viewerPose = frame.getViewerPose(state.viewerSpace);
  const deltaSeconds = state.previousFrameAt ? Math.min(0.05, (now - state.previousFrameAt) / 1_000) : 0;
  state.previousFrameAt = now;
  updateStudy(now, deltaSeconds);
  updateControllerRig(frame, pose);
  if (pose) renderer.render(session, pose, viewerPose, state);
  if (state.phase !== "finished") session.requestAnimationFrame(renderFrame);
}

async function startStudy() {
  if (state.session) return;
  let webhookUrl;
  try {
    webhookUrl = normalizeWebhookUrl(elements.webhook.value);
  } catch (error) {
    setStatus(error.message, true);
    elements.webhook.focus();
    return;
  }

  const remote = flubberReceiver.snapshot();
  if (remote.enabled && (remote.phase !== "live" || !remote.latest)) {
    setStatus("Wait for the incoming Flubber signal to become live before entering immersive mode.", true);
    elements.remoteStop.focus();
    return;
  }

  const polarAssigned = Object.values(state.polarMappings).some((mapping) => mapping.metric !== "manual");
  if (!remote.enabled && polarAssigned && !state.polarConnected) {
    setStatus("Connect the Polar H10 before entering immersive mode, or return both Polar axes to the right thumbstick.", true);
    elements.polarConnect.focus();
    return;
  }

  await acquireLowLatencyWakeLock();

  elements.start.disabled = true;
  elements.stimulus.disabled = true;
  elements.presentationMode.disabled = true;
  elements.controllerFollow.disabled = true;
  elements.controllerFollowHand.disabled = true;
  elements.flubberSize.disabled = true;
  elements.flubberBaseShape.disabled = true;
  elements.polarConnect.disabled = true;
  elements.polarDisconnect.disabled = true;
  elements.polarX.disabled = true;
  elements.polarY.disabled = true;
  elements.remoteUse.disabled = true;
  elements.remoteStop.disabled = true;
  for (const button of elements.remoteSources.querySelectorAll("button")) button.disabled = true;
  elements.download.hidden = true;
  const presentationMode = elements.presentationMode.value;
  const passthrough = presentationMode !== "virtual";
  if (presentationMode === "passthrough-video" && state.stimulus.projection !== "flat") {
    setStatus("Passthrough behind video is available only for the flat-screen stimulus.", true);
    restoreControls();
    return;
  }
  const sessionMode = passthrough ? "immersive-ar" : "immersive-vr";
  setStatus(`Requesting ${passthrough ? "passthrough" : "immersive"} access…`);
  let requestedSession;
  try {
    const sessionPromise = navigator.xr.requestSession(sessionMode, {
      requiredFeatures: ["local-floor"],
    });
    const mediaUnlock = presentationMode === "passthrough-flubber" ? Promise.resolve() : elements.video.play()
        .then(() => { elements.video.pause(); elements.video.currentTime = 0; })
        .catch(() => {});
    const session = await sessionPromise;
    requestedSession = session;
    await mediaUnlock;
    const entryRemote = flubberReceiver.snapshot();
    if (entryRemote.enabled && (entryRemote.phase !== "live" || !entryRemote.latest)) {
      requestedSession = undefined;
      await session.end().catch(() => {});
      throw new Error("The incoming Flubber signal was lost before immersive mode started.");
    }
    if (!renderer) renderer = createRenderer(elements.canvas, elements.video);
    if (typeof renderer.gl.makeXRCompatible === "function") {
      await renderer.gl.makeXRCompatible();
    }
    const layer = new XRWebGLLayer(session, renderer.gl, { alpha: passthrough, antialias: true });
    session.updateRenderState({ baseLayer: layer });
    const [referenceSpace, viewerSpace] = await Promise.all([
      session.requestReferenceSpace("local-floor"),
      session.requestReferenceSpace("viewer"),
    ]);

    state.session = session;
    elements.remoteMode.value = remoteModeText();
    session.addEventListener("visibilitychange", () => {
      elements.remoteMode.value = remoteModeText();
    });
    state.referenceSpace = referenceSpace;
    state.viewerSpace = viewerSpace;
    state.sessionId = crypto.randomUUID?.() ?? `webxr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    state.webhookUrl = webhookUrl;
    state.controllerFollowEnabled = elements.controllerFollow.checked;
    state.controllerFollowHand = elements.controllerFollowHand.value;
    state.flubberSize = Number(elements.flubberSize.value);
    state.flubberBaseShape = elements.flubberBaseShape.value;
    state.presentationMode = presentationMode;
    state.controllerTracking = false;
    state.controllerRigModel = undefined;
    state.phase = "countdown";
    state.countdownEndsAt = performance.now() + COUNTDOWN_MS;
    state.runStartedAt = 0;
    state.previousFrameAt = 0;
    state.previousSampleAt = 0;
    state.targetX = 0;
    state.targetY = 0;
    state.currentX = 0;
    state.currentY = 0;
    state.phaseRadians = 0;
    state.stickX = 0;
    state.stickY = 0;
    state.controllerHand = "unknown";
    state.resetPressed = false;
    state.pausePressed = false;
    state.paused = false;
    state.finalizing = false;
    state.records = [];
    offsets = createProjectionOffsets(state.sessionId, profiles.waveCount);
    for (const remoteEvent of state.pendingRemoteEvents) {
      record("event", remoteEvent.event, `pre-entry:${remoteEvent.detail}`);
    }
    state.pendingRemoteEvents = [];
    record("event", "xr-session-start", `${sessionMode}:${presentationMode}:${state.stimulus.id}:${state.stimulus.projection}`);
    session.addEventListener("end", () => {
      const wasFinished = state.phase === "finished";
      const flubberOnly = state.presentationMode === "passthrough-flubber";
      const finalizePromise = wasFinished ? Promise.resolve() : finalize("xr-session-ended", !flubberOnly);
      finalizePromise.finally(() => {
        state.session = undefined;
        state.referenceSpace = undefined;
        state.viewerSpace = undefined;
        elements.remoteMode.value = remoteModeText();
        elements.stimulus.disabled = elements.presentationMode.value === "passthrough-flubber";
        elements.presentationMode.disabled = false;
        elements.controllerFollow.disabled = false;
        elements.controllerFollowHand.disabled = !elements.controllerFollow.checked;
        elements.flubberSize.disabled = false;
        elements.flubberBaseShape.disabled = false;
        updatePolarConnectionUi(state.polarStatusMessage ?? (state.polarConnected ? "Polar H10 ECG is live at 130 Hz" : "Not connected"));
        updateRemoteUi();
        if (!state.finalizing) elements.start.disabled = false;
      });
    }, { once: true });
    elements.video.onended = () => {
      finalize("video-ended", false, false).catch(() => {});
      session.end().then(downloadLastCsv).catch(() => downloadLastCsv());
    };
    session.requestAnimationFrame(renderFrame);
    const polarAxes = [
      state.polarMappings.valence.metric !== "manual" ? "valence (X)" : "",
      state.polarMappings.arousal.metric !== "manual" ? "arousal (Y)" : "",
    ].filter(Boolean);
    setStatus(
      remote.enabled
        ? `${state.stimulus.title} is running. ${remote.sourceLabel} directly drives both Flubber axes.`
        : polarAxes.length
        ? `${state.stimulus.title} is running. Polar Stream drives ${polarAxes.join(" and ")}; use the right thumbstick for any manual axis.`
        : `${state.stimulus.title} is running. Use the right thumbstick to rate affect.`,
    );
  } catch (error) {
    requestedSession?.end().catch(() => {});
    elements.start.disabled = false;
    elements.stimulus.disabled = elements.presentationMode.value === "passthrough-flubber";
    elements.presentationMode.disabled = false;
    elements.controllerFollow.disabled = false;
    elements.controllerFollowHand.disabled = !elements.controllerFollow.checked;
    elements.flubberSize.disabled = false;
    elements.flubberBaseShape.disabled = false;
    updatePolarConnectionUi(state.polarStatusMessage ?? (state.polarConnected ? "Polar H10 ECG is live at 130 Hz" : "Not connected"));
    updateRemoteUi();
    setStatus(
      error?.name === "NotSupportedError"
        ? `This browser could not start ${passthrough ? "passthrough" : "immersive VR"}. Try another presentation mode in Meta Quest Browser.`
        : `Immersive mode could not start: ${error?.message ?? String(error)}`,
      true,
    );
  }
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "WebGL shader compilation failed.");
  }
  return shader;
}

function createTexture(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  return texture;
}

function createRenderer(canvas, video) {
  const contextOptions = { alpha: true, antialias: true, premultipliedAlpha: true };
  const gl = canvas.getContext("webgl", contextOptions) ??
    canvas.getContext("experimental-webgl", contextOptions) ??
    canvas.getContext("webgl");
  if (!gl) {
    throw new Error("A WebGL rendering context could not be created. Close other immersive tabs and restart Meta Quest Browser.");
  }
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, `
    attribute vec3 a_position;
    attribute vec2 a_tex_coord;
    uniform mat4 u_mvp;
    varying vec2 v_tex_coord;
    void main() {
      gl_Position = u_mvp * vec4(a_position, 1.0);
      v_tex_coord = a_tex_coord;
    }
  `);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    uniform sampler2D u_texture;
    varying vec2 v_tex_coord;
    void main() { gl_FragColor = texture2D(u_texture, v_tex_coord); }
  `);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "WebGL program linking failed.");
  }

  const quadVertices = new Float32Array([
    -0.5, -0.5, 0, 0, 0,
     0.5, -0.5, 0, 1, 0,
    -0.5,  0.5, 0, 0, 1,
    -0.5,  0.5, 0, 0, 1,
     0.5, -0.5, 0, 1, 0,
     0.5,  0.5, 0, 1, 1,
  ]);
  const sphereVertices = createEquirectSphereVertices();
  const createGeometryBuffer = (vertices) => {
    const geometryBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, geometryBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    return geometryBuffer;
  };
  const quadBuffer = createGeometryBuffer(quadVertices);
  const sphereBuffer = createGeometryBuffer(sphereVertices);
  const sphereViewMatrices = [new Float32Array(16), new Float32Array(16)];
  const position = gl.getAttribLocation(program, "a_position");
  const texCoord = gl.getAttribLocation(program, "a_tex_coord");
  const mvp = gl.getUniformLocation(program, "u_mvp");
  const videoTexture = createTexture(gl);
  const flubberTexture = createTexture(gl);
  const flubberCanvas = document.createElement("canvas");
  flubberCanvas.width = FLUBBER_CANVAS_WIDTH;
  flubberCanvas.height = FLUBBER_CANVAS_HEIGHT;
  const context = flubberCanvas.getContext("2d");

  function uploadVideo() {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  }

  function uploadFlubber(study) {
    const countdown = study.phase === "countdown"
      ? Math.max(1, Math.ceil((study.countdownEndsAt - performance.now()) / 1_000))
      : undefined;
    const rendered = buildFlubberPath({
      profiles,
      offsets,
      x: study.currentX,
      y: study.currentY,
      phase: study.phaseRadians,
      baseShape: study.flubberBaseShape,
    });
    context.clearRect(0, 0, flubberCanvas.width, flubberCanvas.height);
    if (study.remote.enabled) {
      context.fillStyle = study.remote.phase === "stale" ? "rgba(255,177,138,0.98)" : "rgba(120,215,255,0.98)";
      context.textAlign = "center";
      context.font = "800 18px system-ui, sans-serif";
      context.fillText(study.remote.phase === "stale" ? "REMOTE • SIGNAL LOST" : "REMOTE • LIVE", 256, 28);
    } else if (study.polarConnected) {
      context.fillStyle = "rgba(121,226,189,0.96)";
      context.textAlign = "center";
      context.font = "800 18px system-ui, sans-serif";
      context.fillText("POLAR STREAM • LIVE", 256, 28);
    }
    context.save();
    context.translate(FLUBBER_CANVAS_WIDTH / 2, 238);
    context.scale(165, 165);
    const path = new Path2D(rendered.path);
    context.fillStyle = rendered.color;
    context.shadowColor = rendered.color;
    context.shadowBlur = 0.16;
    context.fill(path);
    context.shadowBlur = 0;
    context.strokeStyle = "rgba(255,255,255,0.9)";
    context.lineWidth = 0.025;
    context.stroke(path);
    context.restore();
    context.fillStyle = "rgba(255,255,255,0.96)";
    context.textAlign = "center";
    context.font = "700 30px system-ui, sans-serif";
    context.fillText(`X ${study.currentX >= 0 ? "+" : ""}${study.currentX.toFixed(3)}   Y ${study.currentY >= 0 ? "+" : ""}${study.currentY.toFixed(3)}`, 256, 525);
    context.font = "600 19px system-ui, sans-serif";
    context.fillStyle = "rgba(220,230,240,0.92)";
    context.fillText(
      study.paused ? "PAUSED — press Y to resume" : (study.remoteHudText || study.polarHudText || "Right stick: valence × arousal"),
      256,
      558,
    );
    if (countdown !== undefined) {
      context.fillStyle = "rgba(0,0,0,0.7)";
      context.beginPath();
      context.arc(256, 238, 86, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "white";
      context.font = "800 112px system-ui, sans-serif";
      context.fillText(String(countdown), 256, 276);
    }
    gl.bindTexture(gl.TEXTURE_2D, flubberTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, flubberCanvas);
  }

  function bindGeometry(buffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(texCoord);
    gl.vertexAttribPointer(texCoord, 2, gl.FLOAT, false, 20, 12);
  }

  function draw(texture, projection, view, model, transparent, geometryBuffer, vertexCount) {
    const viewModel = multiplyMatrices(view, model);
    const projectionViewModel = multiplyMatrices(projection, viewModel);
    gl.uniformMatrix4fv(mvp, false, projectionViewModel);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (transparent) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.disable(gl.BLEND);
    }
    bindGeometry(geometryBuffer);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
  }

  return {
    gl,
    render(session, pose, viewerPose, study) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, session.renderState.baseLayer.framebuffer);
      const passthrough = study.presentationMode !== "virtual";
      const hasVideo = study.presentationMode !== "passthrough-flubber";
      gl.clearColor(0.008, 0.012, 0.02, passthrough ? 0 : 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(program);
      if (hasVideo) uploadVideo();
      uploadFlubber(study);
      for (let viewIndex = 0; viewIndex < pose.views.length; viewIndex += 1) {
        const view = pose.views[viewIndex];
        const viewport = session.renderState.baseLayer.getViewport(view);
        gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
        if (hasVideo && study.stimulus.projection === "equirectangular-360") {
          draw(
            videoTexture,
            view.projectionMatrix,
            matrixWithoutTranslation(view.transform.inverse.matrix, sphereViewMatrices[viewIndex]),
            SPHERE_MODEL,
            false,
            sphereBuffer,
            sphereVertices.length / 5,
          );
          const controllerRigged = study.controllerFollowEnabled && study.controllerRigModel;
          const hudView = controllerRigged ? view : (viewerPose?.views?.[viewIndex] ?? view);
          const hudFlubberModel = study.flubberSize === 1 ? IMMERSIVE_FLUBBER_MODEL :
            modelMatrix(0, -0.72, -2.2, 0.62 * study.flubberSize, 0.7 * study.flubberSize);
          draw(
            flubberTexture,
            hudView.projectionMatrix,
            hudView.transform.inverse.matrix,
            controllerRigged ? study.controllerRigModel : hudFlubberModel,
            true,
            quadBuffer,
            6,
          );
        } else {
          if (hasVideo) {
            draw(
              videoTexture,
              view.projectionMatrix,
              view.transform.inverse.matrix,
              VIDEO_MODEL,
              false,
              quadBuffer,
              6,
            );
          }
          const fixedFlubberModel = modelMatrix(0, 0.54, -2.38, 0.62 * study.flubberSize, 0.7 * study.flubberSize);
          draw(
            flubberTexture,
            view.projectionMatrix,
            view.transform.inverse.matrix,
            study.controllerFollowEnabled && study.controllerRigModel ? study.controllerRigModel : fixedFlubberModel,
            true,
            quadBuffer,
            6,
          );
        }
      }
    },
  };
}

async function initialize() {
  elements.start.disabled = true;
  if (!navigator.xr) {
    setStatus("WebXR is unavailable. Open this page in Meta Quest Browser.", true);
    return;
  }
  try {
    const [vrSupported, arSupported] = await Promise.all([
      navigator.xr.isSessionSupported("immersive-vr"),
      navigator.xr.isSessionSupported("immersive-ar"),
    ]);
    state.vrSupported = vrSupported;
    state.arSupported = arSupported;
    updatePresentationControls();
  } catch (error) {
    setStatus(`WebXR capability check failed: ${error?.message ?? String(error)}`, true);
  }
}

elements.start.addEventListener("click", startStudy);
elements.download.addEventListener("click", downloadLastCsv);
elements.stimulus.addEventListener("change", () => applyStimulus(webXrStimulusById(elements.stimulus.value)));
function updateRiggingControls() {
  const enabled = elements.controllerFollow.checked;
  elements.controllerFollowHand.disabled = !enabled;
  elements.controllerFollowControls.classList.toggle("is-disabled", !enabled);
  elements.flubberSizeOutput.value = Number(elements.flubberSize.value).toFixed(2);
}
function restoreControls() {
  elements.start.disabled = false;
  elements.stimulus.disabled = elements.presentationMode.value === "passthrough-flubber";
  elements.presentationMode.disabled = false;
  elements.controllerFollow.disabled = false;
  elements.controllerFollowHand.disabled = !elements.controllerFollow.checked;
  elements.flubberSize.disabled = false;
  elements.flubberBaseShape.disabled = false;
  updatePolarConnectionUi(state.polarStatusMessage ?? (state.polarConnected ? "Polar H10 ECG is live at 130 Hz" : "Not connected"));
  updateRemoteUi();
}
function updatePresentationControls() {
  const passthrough = elements.presentationMode.value !== "virtual";
  const flubberOnly = elements.presentationMode.value === "passthrough-flubber";
  const supported = passthrough ? state.arSupported : state.vrSupported;
  elements.stimulus.disabled = flubberOnly;
  if (flubberOnly) {
    elements.video.pause();
    elements.video.removeAttribute("src");
    elements.video.load();
  } else if (elements.video.getAttribute("src") !== state.stimulus.src) {
    elements.video.setAttribute("src", state.stimulus.src);
    elements.video.load();
  }
  elements.start.disabled = !supported;
  elements.presentationNote.textContent = flubberOnly
    ? "No video is loaded or rendered; the study runs until immersive mode is exited."
    : elements.presentationMode.value === "passthrough-video"
      ? "The selected flat video and Flubber appear over the headset passthrough view."
      : "The selected video is presented against the normal virtual background.";
  setStatus(
    supported ? "Ready. Put on the headset, then enter the selected mode." :
      `This browser does not provide ${passthrough ? "immersive passthrough" : "immersive VR"}. Open the page in Meta Quest Browser.`,
    !supported,
  );
}
elements.controllerFollow.addEventListener("change", updateRiggingControls);
elements.flubberSize.addEventListener("input", updateRiggingControls);
elements.presentationMode.addEventListener("change", updatePresentationControls);
elements.polarConnect.addEventListener("click", connectPolar);
elements.polarDisconnect.addEventListener("click", disconnectPolar);
elements.polarX.addEventListener("change", () => setPolarMapping("valence", elements.polarX.value));
elements.polarY.addEventListener("change", () => setPolarMapping("arousal", elements.polarY.value));
elements.remoteUse.addEventListener("click", useIncomingSignal);
elements.remoteStop.addEventListener("click", stopIncomingSignal);
flubberReceiver.addEventListener("statechange", (event) => updateRemoteUi(event.detail));
flubberReceiver.addEventListener("frame", (event) => {
  state.remote = event.detail;
  state.remoteHudText = event.detail.phase === "live"
    ? `${event.detail.sourceLabel.toUpperCase()} • LIVE`
    : "REMOTE • SIGNAL LOST — HOLDING";
  elements.remoteQuality.value = remoteQualityText(event.detail);
  if (!state.session) elements.remoteValues.value = formatRemoteValues(event.detail);
});
window.addEventListener("pagehide", () => {
  void polarSession.disconnect({ emit: false });
  void flubberReceiver.stop();
  void releaseLowLatencyWakeLock();
}, { once: true });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (state.session || flubberReceiver.snapshot().enabled)) {
    void acquireLowLatencyWakeLock();
  }
});
populateStimulusLibrary();
populatePolarMappings();
updateRiggingControls();
updateRemoteUi();
const polarSupport = polarWebBluetoothSupport({ allowQuestExperiment: true });
elements.polarSupport.textContent = polarSupport.reason;
updatePolarConnectionUi(polarSupport.supported ? "Not connected" : polarSupport.reason, !polarSupport.supported);
initialize();
