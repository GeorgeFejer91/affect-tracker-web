import {
  affectParameters,
  buildFlubberPath,
  clamp,
  createProfiles,
  createProjectionOffsets,
} from "./math.js?v=shape-1";
import { buildFaceGeometry } from "./face.js";
import {
  advanceWebXrAffect,
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
import { loadStudyCore } from "./study/core-adapter.js";
import {
  BrowserStudySession,
  createRunConfiguration,
  questionnaireForBlock,
} from "./study/participant-runner.js";
import {
  applyEvidenceWriteSafetyFence,
  DEFAULT_EVIDENCE_WRITE_DEADLINE_MS,
  EvidenceWriteWatchdog,
} from "./study/evidence-write-watchdog.js";
import {
  controllerIntentFromSnapshot,
  createEquirectangularMediaVertices,
  createXrPanelState,
  evaluatePortableMediaObservation,
  evaluatePortableWebXrRuntimePreflight,
  matchingPortableAssetIds,
  portableMediaPositionMs,
  portableControllerSnapshot,
  portableSampleSchedule,
  portableStereoUvTransform,
  portableStudyRunInputs,
  projectPortableBlockToXrPanel,
  reducePortableMediaControl,
  reduceXrPanelController,
  referencedContentAssets,
  resolvePortableVideoBlock,
  sha256PortableFile,
  validatePortableDecodedMedia,
  XR_PANEL_ADAPTER_CAPABILITIES,
} from "./study-xr/index.js";

const VIDEO_MODEL = modelMatrix(0, 1.55, -2.8, 2.4, 1.35);
const SPHERE_MODEL = modelMatrix(0, 0, 0, 1, 1);
const IMMERSIVE_FLUBBER_MODEL = modelMatrix(0, -0.72, -2.2, 0.62, 0.7);
const FLUBBER_CANVAS_WIDTH = 512;
const FLUBBER_CANVAS_HEIGHT = 576;
const PORTABLE_PANEL_CANVAS_WIDTH = 1200;
const PORTABLE_PANEL_CANVAS_HEIGHT = 720;
const PORTABLE_PANEL_MODEL = modelMatrix(0, 0, -1.55, 1.2, 0.72);
const PORTABLE_MEDIA_HUD_CANVAS_WIDTH = 1000;
const PORTABLE_MEDIA_HUD_CANVAS_HEIGHT = 250;
const PORTABLE_MEDIA_HUD_MODEL = modelMatrix(0, -0.72, -1.6, 0.92, 0.23);
const PORTABLE_MEDIA_FLUBBER_MODEL = modelMatrix(0, -0.32, -1.85, 0.42, 0.48);
const PORTABLE_TIMELINE_HEARTBEAT_MS = 1_000;
const IDENTITY_TEXTURE_TRANSFORM = portableStereoUvTransform("mono");
const MAX_PORTABLE_STUDY_BYTES = 2 * 1024 * 1024;
const PORTABLE_CONTROLLER_WAIT_MS = 5_000;
const PORTABLE_MEDIA_UNLOCK_TIMEOUT_MS = 3_000;
const PORTABLE_MEDIA_PROBE_TIMEOUT_MS = 15_000;
const COUNTDOWN_MS = 3_000;
const STUDY_CORE_RUN_CAPABILITIES = new Set([
  "affectInput",
  "contentAddressedMedia",
  "flatVideo",
  "equirectangular180",
  "equirectangular360",
  "sideBySideStereo",
  "topBottomStereo",
  "questionnaires",
  "faceFlubberComparison",
  "youtubeEmbed",
  "immersivePanels",
  "durableJournal",
  "lsl",
]);

const elements = {
  canvas: document.querySelector("#xr-canvas"),
  video: document.querySelector("#study-video"),
  introduction: document.querySelector("#study-introduction"),
  runModeLegacy: document.querySelector("#run-mode-legacy"),
  runModePortable: document.querySelector("#run-mode-portable"),
  legacyStudySetup: document.querySelector("#legacy-study-setup"),
  portableStudySetup: document.querySelector("#portable-study-setup"),
  legacyControllerHelp: document.querySelector("#legacy-controller-help"),
  portableControllerHelp: document.querySelector("#portable-controller-help"),
  portableStudyFile: document.querySelector("#portable-study-file"),
  portableStudyFileStatus: document.querySelector("#portable-study-file-status"),
  portableStudySummary: document.querySelector("#portable-study-summary"),
  portableStudyTitle: document.querySelector("#portable-study-title"),
  portableStudyRevision: document.querySelector("#portable-study-revision"),
  portableStudyHash: document.querySelector("#portable-study-hash"),
  portableMediaFiles: document.querySelector("#portable-media-files"),
  portableMediaStatus: document.querySelector("#portable-media-status"),
  portableParticipantCode: document.querySelector("#portable-participant-code"),
  portableRandomSeedField: document.querySelector("#portable-random-seed-field"),
  portableRandomSeed: document.querySelector("#portable-random-seed"),
  portableCounterbalanceField: document.querySelector("#portable-counterbalance-field"),
  portableCounterbalanceGroup: document.querySelector("#portable-counterbalance-group"),
  portableCounterbalanceRange: document.querySelector("#portable-counterbalance-range"),
  portableCalibrationFields: document.querySelector("#portable-calibration-fields"),
  portableCalibrationX: document.querySelector("#portable-calibration-x"),
  portableCalibrationY: document.querySelector("#portable-calibration-y"),
  portableCalibrationXValue: document.querySelector("#portable-calibration-x-value"),
  portableCalibrationYValue: document.querySelector("#portable-calibration-y-value"),
  portablePreflightStatus: document.querySelector("#portable-preflight-status"),
  portablePreflightIssues: document.querySelector("#portable-preflight-issues"),
  requirements: document.querySelector("#study-requirements"),
  stimulusAttribution: document.querySelector("#stimulus-attribution"),
  stimulus: document.querySelector("#stimulus-select"),
  stimulusName: document.querySelector("#stimulus-name"),
  stimulusDescription: document.querySelector("#stimulus-description"),
  stimulusMetadata: document.querySelector("#stimulus-metadata"),
  stimulusWarning: document.querySelector("#stimulus-warning"),
  presentationMode: document.querySelector("#presentation-mode"),
  passthroughVideoOption: document.querySelector("#passthrough-video-option"),
  presentationNote: document.querySelector("#presentation-note"),
  webhook: document.querySelector("#webhook-url"),
  webhookField: document.querySelector("#webhook-field"),
  webhookNote: document.querySelector("#webhook-note"),
  controllerFollow: document.querySelector("#controller-follow-enabled"),
  riggingPanel: document.querySelector("#webxr-rigging-panel"),
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
  polarPanel: document.querySelector("#webxr-polar-panel"),
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
  downloadManifest: document.querySelector("#download-manifest"),
  status: document.querySelector("#study-status"),
};

const state = {
  runnerMode: "legacy",
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
  portable: {
    core: undefined,
    study: undefined,
    assetBindings: new Map(),
    studyLoadRevision: 0,
    mediaLoadRevision: 0,
    preflight: undefined,
    runInputs: undefined,
    browserSession: undefined,
    currentBlock: undefined,
    questionnaire: undefined,
    panelState: undefined,
    panelModel: undefined,
    media: undefined,
    blockEnteredAt: 0,
    previousController: { x: 0, y: 0, select: false, back: false },
    commandPending: false,
    finishing: false,
    sessionEnded: false,
    errorMessage: "",
    evidenceWriteDeadlineMs: DEFAULT_EVIDENCE_WRITE_DEADLINE_MS,
    lastResult: undefined,
    lastManifestFilename: "",
    partialRetention: undefined,
  },
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

function setPortableFileStatus(message, kind = "") {
  elements.portableStudyFileStatus.value = message;
  elements.portableStudyFileStatus.classList.toggle("is-error", kind === "error");
  elements.portableStudyFileStatus.classList.toggle("is-ready", kind === "ready");
}

function hasDurableBrowserJournal() {
  return Boolean(globalThis.indexedDB?.open && globalThis.IDBKeyRange?.bound);
}

function observedPortableCapabilities() {
  const capabilities = new Set(XR_PANEL_ADAPTER_CAPABILITIES);
  if (state.vrSupported && navigator.xr) {
    capabilities.add("controllerInput");
    capabilities.add("affectInput");
    capabilities.add("flatVideo");
    capabilities.add("equirectangular180");
    capabilities.add("equirectangular360");
    capabilities.add("sideBySideStereo");
    capabilities.add("topBottomStereo");
  }
  if (hasDurableBrowserJournal()) capabilities.add("durableJournal");
  const referenced = referencedContentAssets(state.portable.study);
  if (referenced.length > 0
    && typeof globalThis.URL?.createObjectURL === "function"
    && referenced.every(({ assetId }) => state.portable.assetBindings.has(assetId))) {
    capabilities.add("contentAddressedMedia");
  }
  return [...capabilities];
}

function observedPortableMimeTypes() {
  return [...new Set(referencedContentAssets(state.portable.study)
    .map(({ mimeType }) => String(mimeType ?? "").trim().toLowerCase())
    .filter((mimeType) => mimeType && elements.video.canPlayType(mimeType) !== ""))];
}

function portableInputIssues() {
  const issues = [];
  const inputs = state.portable.runInputs;
  const seed = elements.portableRandomSeed.value.trim();
  if (inputs?.needsRandomSeed && seed && !/^[0-9a-f]{32}$/i.test(seed)) {
    issues.push({
      code: "invalidRandomSeed",
      path: "runConfiguration.randomSeed",
      message: "The optional run seed must contain exactly 32 hexadecimal characters.",
    });
  }
  if (inputs?.counterbalanceGroupCount) {
    const group = Number(elements.portableCounterbalanceGroup.value);
    if (!Number.isInteger(group) || group < 1 || group > inputs.counterbalanceGroupCount) {
      issues.push({
        code: "invalidCounterbalanceGroup",
        path: "runConfiguration.counterbalanceGroup",
        message: `Choose a counterbalance group from 1 through ${inputs.counterbalanceGroupCount}.`,
      });
    }
  }
  if (state.remote.enabled) {
    issues.push({
      code: "legacyRemoteActive",
      path: "runtime.input",
      message: "Stop the legacy incoming Flubber signal before starting a portable study.",
    });
  }
  if (state.polarConnected || state.polarConnecting
    || Object.values(state.polarMappings).some(({ metric }) => metric !== "manual")) {
    issues.push({
      code: "legacyPolarActive",
      path: "runtime.input",
      message: "Disconnect Polar Stream and return both legacy mappings to manual before starting a portable study.",
    });
  }
  return issues;
}

function renderPortableMediaStatus() {
  elements.portableMediaStatus.replaceChildren();
  const assets = referencedContentAssets(state.portable.study);
  for (const asset of assets) {
    const verified = state.portable.assetBindings.has(asset.assetId);
    const item = document.createElement("li");
    item.className = verified ? "is-ready" : "is-error";
    item.textContent = `${asset.assetId}: ${verified ? "SHA-256, byte length, duration, and first-frame decode verified" : "matching decodable local file required"}`;
    elements.portableMediaStatus.append(item);
  }
  if (assets.length === 0 && state.portable.study) {
    const item = document.createElement("li");
    item.className = "is-ready";
    item.textContent = "This study does not reference local media.";
    elements.portableMediaStatus.append(item);
  }
}

function renderPortablePreflight(report) {
  elements.portablePreflightIssues.replaceChildren();
  for (const issue of report?.issues ?? []) {
    const item = document.createElement("li");
    item.className = "is-error";
    item.textContent = `${issue.message} (${issue.path})`;
    elements.portablePreflightIssues.append(item);
  }
  const ready = Boolean(report?.ok);
  elements.portablePreflightStatus.classList.toggle("is-ready", ready);
  elements.portablePreflightStatus.classList.toggle("is-error", Boolean(report) && !ready);
  elements.portablePreflightStatus.value = !report
    ? "Load a published study to run preflight."
    : ready
      ? "Logical preflight passed. Controller presence is checked in XR before the authority starts."
      : `${report.issues.length} blocking issue${report.issues.length === 1 ? "" : "s"}. Immersive mode will not start.`;
}

function refreshPortablePreflight() {
  const study = state.portable.study;
  if (!study) {
    state.portable.preflight = undefined;
    renderPortablePreflight(undefined);
    if (state.runnerMode === "portable") elements.start.disabled = true;
    return undefined;
  }
  const base = evaluatePortableWebXrRuntimePreflight(study, {
    availableCapabilities: observedPortableCapabilities(),
    verifiedAssetIds: new Set(state.portable.assetBindings.keys()),
    requireVerifiedAssets: true,
    supportedMimeTypes: observedPortableMimeTypes(),
  });
  const issues = [...base.issues, ...portableInputIssues()];
  const report = Object.freeze({ ...base, ok: issues.length === 0, issues: Object.freeze(issues) });
  state.portable.preflight = report;
  renderPortablePreflight(report);
  if (state.runnerMode === "portable") {
    elements.start.disabled = Boolean(state.session) || !state.vrSupported || !report.ok;
  }
  return report;
}

function clearPortableStudy() {
  state.portable.study = undefined;
  state.portable.runInputs = undefined;
  state.portable.assetBindings = new Map();
  state.portable.preflight = undefined;
  elements.portableStudySummary.hidden = true;
  elements.portableMediaFiles.disabled = true;
  elements.portableMediaFiles.value = "";
  elements.portableParticipantCode.value = "";
  elements.portableRandomSeed.value = "";
  elements.portableCounterbalanceGroup.value = "1";
  elements.portableCalibrationX.value = "0";
  elements.portableCalibrationY.value = "0";
  elements.portableCalibrationXValue.value = "0.00";
  elements.portableCalibrationYValue.value = "0.00";
  elements.portableRandomSeedField.hidden = true;
  elements.portableCounterbalanceField.hidden = true;
  elements.portableCalibrationFields.hidden = true;
  renderPortableMediaStatus();
  renderPortablePreflight(undefined);
  if (state.runnerMode === "portable") elements.start.disabled = true;
}

function displayPortableStudy(study) {
  const inputs = portableStudyRunInputs(study);
  state.portable.runInputs = inputs;
  elements.portableStudyTitle.value = study.title;
  elements.portableStudyRevision.value = String(study.revision);
  elements.portableStudyHash.value = study.protocolHash;
  elements.portableStudySummary.hidden = false;
  const assets = referencedContentAssets(study);
  elements.portableMediaFiles.disabled = assets.length === 0;
  elements.portableRandomSeedField.hidden = !inputs.needsRandomSeed;
  elements.portableCounterbalanceField.hidden = !inputs.counterbalanceGroupCount;
  elements.portableCalibrationFields.hidden = !inputs.needsCalibration;
  if (inputs.counterbalanceGroupCount) {
    elements.portableCounterbalanceGroup.max = String(inputs.counterbalanceGroupCount);
    elements.portableCounterbalanceRange.value = `1–${inputs.counterbalanceGroupCount}`;
  }
  renderPortableMediaStatus();
}

function portableValidationMessage(validation) {
  return (validation?.errors ?? []).slice(0, 4)
    .map((issue) => `${issue.path ?? "study"}: ${issue.message ?? issue.code ?? "invalid value"}`)
    .join("; ");
}

async function loadPortableStudyFile() {
  if (state.session) return;
  const loadRevision = ++state.portable.studyLoadRevision;
  state.portable.mediaLoadRevision += 1;
  const file = elements.portableStudyFile.files?.[0];
  clearPortableStudy();
  if (!file) {
    setPortableFileStatus("Select an immutable, published StudyDefinitionV1 JSON file.");
    return;
  }
  if (file.size > MAX_PORTABLE_STUDY_BYTES) {
    setPortableFileStatus("Study JSON exceeds the 2 MiB safety limit.", "error");
    return;
  }
  setPortableFileStatus("Loading the shared WASM authority and validating the protocol…");
  try {
    const parsed = JSON.parse(await file.text());
    if (loadRevision !== state.portable.studyLoadRevision) return;
    const core = state.portable.core ?? await loadStudyCore();
    if (loadRevision !== state.portable.studyLoadRevision) return;
    state.portable.core = core;
    if (core.implementation !== "wasm" || !core.canRun) {
      throw new Error(`The shared WASM study authority is unavailable${core.loadError?.message ? `: ${core.loadError.message}` : "."}`);
    }
    if (!/^[0-9a-f]{64}$/.test(parsed?.protocolHash ?? "")) {
      throw new Error("Select a published definition containing a lowercase SHA-256 protocolHash.");
    }
    const validation = await core.validate(parsed);
    if (loadRevision !== state.portable.studyLoadRevision) return;
    if (!validation.valid) throw new Error(portableValidationMessage(validation) || "The study definition is invalid.");
    const observedHash = await core.hash(parsed);
    if (loadRevision !== state.portable.studyLoadRevision) return;
    if (observedHash !== parsed.protocolHash) {
      throw new Error("The published protocol hash does not match this study JSON.");
    }
    state.portable.study = parsed;
    displayPortableStudy(parsed);
    setPortableFileStatus(
      `${parsed.title} revision ${parsed.revision} passed the native-equivalent WASM schema and protocol-hash checks.`,
      "ready",
    );
    refreshPortablePreflight();
  } catch (error) {
    if (loadRevision !== state.portable.studyLoadRevision) return;
    clearPortableStudy();
    setPortableFileStatus(`Study could not be loaded: ${error?.message ?? String(error)}`, "error");
  }
}

async function bindPortableMediaFiles() {
  if (state.session || !state.portable.study) return;
  const mediaLoadRevision = ++state.portable.mediaLoadRevision;
  const assets = referencedContentAssets(state.portable.study);
  const files = [...(elements.portableMediaFiles.files ?? [])];
  state.portable.assetBindings = new Map();
  renderPortableMediaStatus();
  elements.portableMediaFiles.disabled = true;
  setPortableFileStatus(`Hashing and decoding ${files.length} local media file${files.length === 1 ? "" : "s"}…`);
  try {
    for (const file of files) {
      const sizeCandidates = assets.filter(({ byteLength }) => byteLength === file.size);
      if (sizeCandidates.length === 0) continue;
      const hash = await sha256PortableFile(file);
      if (mediaLoadRevision !== state.portable.mediaLoadRevision) return;
      const matchingIds = matchingPortableAssetIds(sizeCandidates, file, hash);
      const matchingAssets = sizeCandidates.filter(({ assetId }) => matchingIds.includes(assetId));
      if (matchingAssets.length > 0) await probePortableMediaFile(file, matchingAssets);
      if (mediaLoadRevision !== state.portable.mediaLoadRevision) return;
      for (const assetId of matchingIds) {
        state.portable.assetBindings.set(assetId, file);
      }
    }
    renderPortableMediaStatus();
    const matched = state.portable.assetBindings.size;
    setPortableFileStatus(
      `${state.portable.study.title} remains validated. ${matched} of ${assets.length} referenced media asset${assets.length === 1 ? "" : "s"} verified.`,
      matched === assets.length ? "ready" : "error",
    );
  } catch (error) {
    if (mediaLoadRevision !== state.portable.mediaLoadRevision) return;
    state.portable.assetBindings = new Map();
    renderPortableMediaStatus();
    setPortableFileStatus(`Media verification failed: ${error?.message ?? String(error)}`, "error");
  } finally {
    if (mediaLoadRevision !== state.portable.mediaLoadRevision) return;
    elements.portableMediaFiles.disabled = assets.length === 0;
    refreshPortablePreflight();
  }
}

async function probePortableMediaFile(file, assets) {
  for (const asset of assets) {
    if (elements.video.canPlayType(asset.mimeType) === "") {
      throw new Error(`This browser reports no playback support for ${asset.mimeType} (${asset.assetId}).`);
    }
  }
  const probe = document.createElement("video");
  const objectUrl = URL.createObjectURL(file);
  probe.preload = "auto";
  probe.muted = true;
  probe.playsInline = true;
  probe.disablePictureInPicture = true;
  let timer;
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const onDecodedFrame = () => {
        const observedDurationMs = Number(probe.duration) * 1_000;
        try {
          for (const asset of assets) validatePortableDecodedMedia(asset, {
            durationMs: observedDurationMs,
            videoWidth: probe.videoWidth,
            videoHeight: probe.videoHeight,
          });
        } catch (error) {
          finish(reject, error);
          return;
        }
        finish(resolve);
      };
      probe.addEventListener("loadeddata", onDecodedFrame, { once: true });
      probe.addEventListener("canplay", onDecodedFrame, { once: true });
      probe.addEventListener("error", () => finish(
        reject,
        new Error(`The browser could not decode this hash-matched file (media error ${probe.error?.code ?? "unknown"}).`),
      ), { once: true });
      timer = setTimeout(
        () => finish(reject, new Error("Timed out while decoding the first frame of a hash-matched media file.")),
        PORTABLE_MEDIA_PROBE_TIMEOUT_MS,
      );
      probe.src = objectUrl;
      probe.load();
    });
  } finally {
    clearTimeout(timer);
    probe.pause();
    probe.removeAttribute("src");
    probe.load();
    URL.revokeObjectURL(objectUrl);
  }
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

function downloadTextFile(filename, contents, mimeType) {
  const url = URL.createObjectURL(new Blob([contents], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

function downloadLastManifest() {
  const result = state.portable.lastResult;
  if (!result?.manifest) return;
  downloadTextFile(
    state.portable.lastManifestFilename,
    `${JSON.stringify(result.manifest, null, 2)}\n`,
    "application/json;charset=utf-8",
  );
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

function setPortableControlsDisabled(disabled) {
  for (const control of [
    elements.runModeLegacy,
    elements.runModePortable,
    elements.portableStudyFile,
    elements.portableMediaFiles,
    elements.portableParticipantCode,
    elements.portableRandomSeed,
    elements.portableCounterbalanceGroup,
    elements.portableCalibrationX,
    elements.portableCalibrationY,
  ]) {
    control.disabled = disabled;
  }
  if (!disabled) {
    elements.portableMediaFiles.disabled = referencedContentAssets(state.portable.study).length === 0;
  }
}

function portableControllerAvailable(inputSources) {
  return Array.from(inputSources ?? []).some((source) => source?.gamepad);
}

async function waitForPortableController(session, timeoutMs = PORTABLE_CONTROLLER_WAIT_MS) {
  if (portableControllerAvailable(session.inputSources)) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.removeEventListener("inputsourceschange", onSources);
      session.removeEventListener("end", onEnd);
      callback(value);
    };
    const onSources = () => {
      if (portableControllerAvailable(session.inputSources)) finish(resolve);
    };
    const onEnd = () => finish(reject, new Error("Immersive mode ended before a tracked controller became available."));
    const timer = setTimeout(
      () => finish(reject, new Error("No WebXR gamepad controller was observed. Wake a Touch controller and try again.")),
      timeoutMs,
    );
    session.addEventListener("inputsourceschange", onSources);
    session.addEventListener("end", onEnd, { once: true });
  });
}

function storePortableResult(result, partial) {
  state.portable.lastResult = result;
  const suffix = partial ? "-partial" : "";
  state.lastCsv = result.csv;
  state.lastFilename = `affect-webxr-${result.manifest.runId}${suffix}.csv`;
  state.portable.lastManifestFilename = `affect-webxr-${result.manifest.runId}${suffix}.manifest.json`;
  elements.download.hidden = false;
  elements.downloadManifest.hidden = false;
  elements.start.textContent = "Run another study";
  setStatus(
    partial
      ? "Portable study ended early. The partial authoritative CSV and result manifest are ready to export."
      : "Portable study complete. Export the authoritative CSV and result manifest together.",
  );
}

function portableAffectSnapshot() {
  return {
    currentX: state.currentX,
    currentY: state.currentY,
    phase: state.phaseRadians,
  };
}

function isCurrentPortableMedia(media) {
  return Boolean(
    media
    && !media.disposed
    && state.portable.media === media
    && state.portable.currentBlock?.blockId === media.descriptor.blockId,
  );
}

function portableMediaObservation(media) {
  const observedTime = Number(elements.video.currentTime);
  return evaluatePortableMediaObservation(media.descriptor, {
    currentTimeSeconds: Number.isFinite(observedTime)
      ? observedTime
      : media.descriptor.clip.startMs / 1_000,
    paused: elements.video.paused,
    ended: elements.video.ended,
    seeking: elements.video.seeking,
    readyState: elements.video.readyState,
    stalled: media.stalled,
  });
}

function clearPortableMediaSource(media) {
  if (!media) return;
  media.disposed = true;
  media.active = false;
  media.authorityPlaying = false;
  media.nextSampleDueMs = null;
  for (const [type, listener] of Object.entries(media.listeners ?? {})) {
    elements.video.removeEventListener(type, listener);
  }
  if (media.videoFrameHandle !== undefined && typeof elements.video.cancelVideoFrameCallback === "function") {
    elements.video.cancelVideoFrameCallback(media.videoFrameHandle);
  }
  clearTimeout(media.clipEndTimer);
  elements.video.pause();
  if (elements.video.getAttribute("src") === media.objectUrl) {
    elements.video.removeAttribute("src");
    elements.video.load();
  }
  URL.revokeObjectURL(media.objectUrl);
  if (state.portable.media === media) state.portable.media = undefined;
}

function failPortableMedia(media, message) {
  if (!isCurrentPortableMedia(media) || media.fatalError) return;
  media.errorMessage = message;
  media.fatalError = true;
  media.active = false;
  media.authorityPlaying = false;
  media.nextSampleDueMs = null;
  elements.video.pause();
  setStatus(`Portable media stopped safely: ${message}`, true);
  if (!state.portable.finishing) void stopPortableRun("portable-media-error");
}

function fencePortableEvidenceWrite(media, message) {
  if (!isCurrentPortableMedia(media)) return;
  media.evidenceWriteBlocked = true;
  media.evidenceWriteResumeReady = false;
  media.active = false;
  media.authorityPlaying = false;
  media.nextSampleDueMs = null;
  media.timelineRequest = undefined;
  media.stallRequest = undefined;
  applyEvidenceWriteSafetyFence({
    pauseLocalVideo: () => elements.video.pause(),
    stopSampling: () => { media.nextSampleDueMs = null; },
    stopTimeline: () => {
      clearTimeout(media.clipEndTimer);
      if (media.videoFrameHandle !== undefined
        && typeof elements.video.cancelVideoFrameCallback === "function") {
        elements.video.cancelVideoFrameCallback(media.videoFrameHandle);
        media.videoFrameHandle = undefined;
      }
    },
    disableControls: () => { media.evidenceWriteBlocked = true; },
  });
  media.errorMessage = message;
  setStatus(`Portable evidence writing is fenced: ${message}`, true);
}

function guardPortableEvidenceWrite(media, operation) {
  if (!isCurrentPortableMedia(media) || !media.evidenceWriteWatchdog) {
    return Promise.reject(new Error("The portable evidence adapter is unavailable."));
  }
  return media.evidenceWriteWatchdog.run(operation);
}

function failPortableEvidence(media, message) {
  if (!isCurrentPortableMedia(media) || media.evidenceWriteFailed) return;
  fencePortableEvidenceWrite(media, message);
  media.evidenceWriteFailed = true;
  media.fatalError = true;
  media.errorMessage = state.portable.browserSession?.pendingJournalCommand?.()
    ? `Right trigger: End and retain partial evidence · ${message}`
    : `End immersive mode; no outcome was staged · ${message}`;
  setStatus(`Portable evidence could not be committed: ${message}`, true);
}

function resumePortableEvidenceAfterDelay(media) {
  if (!isCurrentPortableMedia(media)
    || !media.evidenceWriteResumeReady
    || !media.evidenceWriteWatchdog?.acknowledge()) return false;
  media.evidenceWriteBlocked = false;
  media.evidenceWriteResumeReady = false;
  media.errorMessage = "";
  setStatus("The delayed portable evidence write settled. Resume was explicitly accepted; playback may restart.");
  return true;
}

async function abandonPortableEvidence(media) {
  if (!isCurrentPortableMedia(media) || media.controlPending) return;
  media.controlPending = true;
  try {
    const retained = await state.portable.browserSession.abandonPendingJournalOutcome({
      reasonCode: "webxr-evidence-write-unrecoverable",
    });
    state.portable.partialRetention = retained;
    clearPortableMediaSource(media);
    state.phase = "finished";
    setStatus(
      `Portable run retained as partial evidence. ${retained.stagedAction.commandType} is the uncommitted data-loss boundary; use Stored run evidence in the 2D study page to export committed events.`,
      true,
    );
    if (state.session && !state.portable.sessionEnded) await state.session.end().catch(() => {});
  } catch (error) {
    if (isCurrentPortableMedia(media)) {
      media.controlPending = false;
      media.errorMessage = error?.message ?? String(error);
      setStatus(`Portable partial retention failed: ${media.errorMessage}`, true);
    }
  }
}

function queuePortableTimeline(media, requestedPlaying, force = false) {
  if (!isCurrentPortableMedia(media)
    || !state.portable.browserSession
    || media.fatalError
    || media.evidenceWriteBlocked) return media?.timelinePromise ?? Promise.resolve();
  if (!requestedPlaying) {
    media.authorityPlaying = false;
    media.nextSampleDueMs = null;
  }
  media.timelineRequest = { playing: requestedPlaying === true, force: force === true };
  if (media.timelinePromise) return media.timelinePromise;

  media.timelinePromise = (async () => {
    while (media.timelineRequest
      && isCurrentPortableMedia(media)
      && !media.fatalError
      && !media.evidenceWriteBlocked) {
      const request = media.timelineRequest;
      media.timelineRequest = undefined;
      const observation = portableMediaObservation(media);
      const authorityState = state.portable.browserSession.state();
      const playing = request.playing && observation.active && authorityState.phase === "running";
      const now = performance.now();
      if (!request.force
        && playing === media.authorityPlaying
        && now - media.lastTimelineReportAt < PORTABLE_TIMELINE_HEARTBEAT_MS) continue;
      await guardPortableEvidenceWrite(
        media,
        () => state.portable.browserSession.reportMedia(
          observation.relativePositionMs,
          playing,
          elements.video.playbackRate || 1,
        ),
      );
      if (!isCurrentPortableMedia(media) || media.evidenceWriteBlocked || media.fatalError) return;
      media.authorityPlaying = playing;
      media.lastTimelineReportAt = performance.now();
      if (!playing) media.nextSampleDueMs = null;
    }
  })().catch((error) => {
    if (isCurrentPortableMedia(media)) failPortableEvidence(
      media,
      `The authoritative media timeline could not be recorded: ${error?.message ?? String(error)}`,
    );
  }).finally(() => {
    media.timelinePromise = undefined;
    if (media.timelineRequest
      && isCurrentPortableMedia(media)
      && !media.fatalError
      && !media.evidenceWriteBlocked) queuePortableTimeline(
      media,
      media.timelineRequest.playing,
      media.timelineRequest.force,
    );
  });
  return media.timelinePromise;
}

function queuePortableStall(media, stalled, code = "media-buffering", kind = "media") {
  if (!isCurrentPortableMedia(media)
    || !state.portable.browserSession
    || media.fatalError
    || media.evidenceWriteBlocked) return media?.stallPromise ?? Promise.resolve();
  media.stallRequest = { stalled: stalled === true, code, kind };
  if (media.stallPromise) return media.stallPromise;
  media.stallPromise = (async () => {
    while (media.stallRequest
      && isCurrentPortableMedia(media)
      && !media.fatalError
      && !media.evidenceWriteBlocked) {
      const request = media.stallRequest;
      media.stallRequest = undefined;
      if (request.stalled) {
        await queuePortableTimeline(media, false, true);
        if (!isCurrentPortableMedia(media)) return;
        const authorityState = state.portable.browserSession.state();
        if (!authorityState.stall) {
          await guardPortableEvidenceWrite(
            media,
            () => state.portable.browserSession.dispatch({
              type: "reportStall",
              stall: { kind: request.kind, code: request.code },
            }),
          );
        } else if (authorityState.stall.kind !== request.kind || authorityState.stall.code !== request.code) {
          throw new Error(`Cannot replace active ${authorityState.stall.kind} stall ${authorityState.stall.code}.`);
        }
        media.authorityStall = { kind: request.kind, code: request.code };
      } else {
        const authorityState = state.portable.browserSession.state();
        if (authorityState.stall
          && media.authorityStall
          && authorityState.stall.kind === media.authorityStall.kind
          && authorityState.stall.code === media.authorityStall.code) {
          await guardPortableEvidenceWrite(
            media,
            () => state.portable.browserSession.dispatch({ type: "clearStall" }),
          );
        } else if (authorityState.stall) {
          throw new Error(`Cannot clear unowned ${authorityState.stall.kind} stall ${authorityState.stall.code}.`);
        }
        media.authorityStall = undefined;
        if (portableMediaObservation(media).active) await queuePortableTimeline(media, true, true);
      }
    }
  })().catch((error) => {
    if (isCurrentPortableMedia(media)) failPortableEvidence(
      media,
      `The media stall state could not be recorded: ${error?.message ?? String(error)}`,
    );
  }).finally(() => {
    media.stallPromise = undefined;
    if (media.stallRequest
      && isCurrentPortableMedia(media)
      && !media.fatalError
      && !media.evidenceWriteBlocked) queuePortableStall(
      media,
      media.stallRequest.stalled,
      media.stallRequest.code,
      media.stallRequest.kind,
    );
  });
  return media.stallPromise;
}

function markPortableMediaComplete(media) {
  if (!isCurrentPortableMedia(media) || media.segmentComplete) return;
  media.segmentComplete = true;
  media.active = false;
  media.stalled = false;
  media.nextSampleDueMs = null;
  clearTimeout(media.clipEndTimer);
  elements.video.pause();
  const clipEndSeconds = media.descriptor.clip.endMs / 1_000;
  if (Number.isFinite(elements.video.duration)) {
    elements.video.currentTime = Math.min(clipEndSeconds, elements.video.duration);
  }
  void queuePortableTimeline(media, false, true);
}

function schedulePortableClipEnd(media) {
  if (!isCurrentPortableMedia(media) || media.segmentComplete || elements.video.paused) return;
  clearTimeout(media.clipEndTimer);
  const remainingMs = Math.max(
    0,
    (media.descriptor.clip.endMs - elements.video.currentTime * 1_000) / (elements.video.playbackRate || 1),
  );
  media.clipEndTimer = setTimeout(() => {
    if (!isCurrentPortableMedia(media) || elements.video.paused) return;
    if (portableMediaObservation(media).segmentComplete) markPortableMediaComplete(media);
    else schedulePortableClipEnd(media);
  }, Math.max(1, Math.min(60_000, Math.ceil(remainingMs))));
}

function watchPortableMediaFrames(media) {
  if (!isCurrentPortableMedia(media)
    || media.segmentComplete
    || media.videoFrameHandle !== undefined
    || typeof elements.video.requestVideoFrameCallback !== "function") return;
  media.videoFrameHandle = elements.video.requestVideoFrameCallback(() => {
    media.videoFrameHandle = undefined;
    if (!isCurrentPortableMedia(media)) return;
    if (portableMediaObservation(media).segmentComplete) markPortableMediaComplete(media);
    else watchPortableMediaFrames(media);
  });
}

async function attemptPortableMediaPlay(media, { automatic = false } = {}) {
  if (!isCurrentPortableMedia(media)
    || !media.ready
    || media.segmentComplete
    || media.controlPending) return;
  if (media.evidenceWriteBlocked) {
    if (automatic || !resumePortableEvidenceAfterDelay(media)) return;
  }
  if (media.fatalError) return;
  media.controlPending = true;
  media.errorMessage = "";
  try {
    if (state.portable.browserSession.state().phase === "paused") {
      await state.portable.browserSession.dispatch({ type: "resume" });
    }
    if (!isCurrentPortableMedia(media)) return;
    const currentMs = (elements.video.currentTime || 0) * 1_000;
    if (currentMs < media.descriptor.clip.startMs || currentMs >= media.descriptor.clip.endMs) {
      elements.video.currentTime = media.descriptor.clip.startMs / 1_000;
    }
    await elements.video.play();
    if (!isCurrentPortableMedia(media)) return;
    media.userPaused = false;
    media.activationRequired = false;
    media.active = portableMediaObservation(media).active;
    schedulePortableClipEnd(media);
    if (media.stalled || media.authorityStall || media.stallPromise) {
      media.stalled = false;
      media.stallCode = "";
      await queuePortableStall(media, false);
    } else {
      await queuePortableTimeline(media, true, true);
    }
  } catch (error) {
    if (!isCurrentPortableMedia(media)) return;
    if (error?.name === "NotAllowedError" && automatic) {
      media.activationRequired = true;
      media.errorMessage = "Press the right trigger to start this verified video.";
    } else if (error?.name === "NotAllowedError") {
      media.activationRequired = true;
      media.errorMessage = "Playback permission was denied. Press the right trigger again.";
    } else {
      failPortableMedia(media, `Verified media playback failed: ${error?.message ?? String(error)}`);
    }
  } finally {
    media.controlPending = false;
  }
}

async function pausePortableMedia(media) {
  if (!isCurrentPortableMedia(media) || media.controlPending) return;
  media.controlPending = true;
  media.userPaused = true;
  media.active = false;
  media.nextSampleDueMs = null;
  elements.video.pause();
  try {
    await queuePortableTimeline(media, false, true);
    if (!isCurrentPortableMedia(media)) return;
    if (state.portable.browserSession.state().phase === "running") {
      await state.portable.browserSession.dispatch({
        type: "pause",
        reasonCode: "participant-media-pause",
      });
    }
  } catch (error) {
    failPortableMedia(media, `The media pause could not be recorded: ${error?.message ?? String(error)}`);
  } finally {
    media.controlPending = false;
  }
}

async function advancePortableMedia(media) {
  if (!isCurrentPortableMedia(media) || !media.segmentComplete || media.controlPending) return;
  media.controlPending = true;
  try {
    await queuePortableTimeline(media, false, true);
    if (!isCurrentPortableMedia(media)) return;
    if (state.portable.browserSession.state().phase === "paused") {
      await state.portable.browserSession.dispatch({ type: "resume" });
    }
    if (!isCurrentPortableMedia(media)) return;
    await state.portable.browserSession.advance();
    clearPortableMediaSource(media);
    syncPortablePanel();
  } catch (error) {
    if (isCurrentPortableMedia(media)) {
      media.errorMessage = error?.message ?? String(error);
      setStatus(`Portable video could not advance: ${media.errorMessage}`, true);
    }
  } finally {
    media.controlPending = false;
  }
}

function enterPortableVideoBlock(block, now) {
  if (state.portable.media) clearPortableMediaSource(state.portable.media);
  const { descriptor, file } = resolvePortableVideoBlock(
    state.portable.study,
    block,
    state.portable.assetBindings,
  );
  const objectUrl = URL.createObjectURL(file);
  const media = {
    descriptor,
    objectUrl,
    ready: false,
    active: false,
    stalled: false,
    stallCode: "",
    segmentComplete: false,
    userPaused: false,
    activationRequired: false,
    authorityPlaying: false,
    authorityStall: undefined,
    timelineRequest: undefined,
    timelinePromise: undefined,
    stallRequest: undefined,
    stallPromise: undefined,
    lastTimelineReportAt: 0,
    nextSampleDueMs: null,
    samplePending: false,
    controlPending: false,
    errorMessage: "",
    fatalError: false,
    evidenceWriteBlocked: false,
    evidenceWriteResumeReady: false,
    evidenceWriteFailed: false,
    evidenceWriteWatchdog: undefined,
    disposed: false,
    videoFrameHandle: undefined,
    clipEndTimer: undefined,
    listeners: {},
  };
  media.evidenceWriteWatchdog = new EvidenceWriteWatchdog({
    deadlineMs: state.portable.evidenceWriteDeadlineMs,
    onDeadline: ({ deadlineMs }) => {
      fencePortableEvidenceWrite(
        media,
        `A journal transaction exceeded ${deadlineMs} ms. It remains active and was not cancelled.`,
      );
    },
    onQuiescent: ({ rejected }) => {
      if (!isCurrentPortableMedia(media) || rejected || media.evidenceWriteFailed) return;
      media.evidenceWriteResumeReady = true;
      media.errorMessage = "Right trigger: Resume explicitly · delayed evidence write settled";
      setStatus("The delayed portable evidence write settled. Playback remains fenced until the researcher resumes explicitly.", true);
    },
  });
  state.portable.media = media;
  state.portable.panelModel = undefined;
  state.portable.panelState = undefined;
  state.portable.questionnaire = undefined;
  state.portable.blockEnteredAt = now;

  const onLoadedMetadata = () => {
    if (!isCurrentPortableMedia(media)) return;
    const observedDurationMs = Number(elements.video.duration) * 1_000;
    try {
      validatePortableDecodedMedia(media.descriptor.asset, {
        durationMs: observedDurationMs,
        videoWidth: elements.video.videoWidth,
        videoHeight: elements.video.videoHeight,
      });
    } catch {
      failPortableMedia(
        media,
        `Decoded duration does not match the published ${media.descriptor.asset.durationMs} ms asset or its clip boundary.`,
      );
      return;
    }
    elements.video.currentTime = media.descriptor.clip.startMs / 1_000;
    if (elements.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      media.ready = true;
      void attemptPortableMediaPlay(media, { automatic: true });
    }
  };
  const onCanPlay = () => {
    if (!isCurrentPortableMedia(media)
      || media.segmentComplete
      || media.fatalError
      || media.evidenceWriteBlocked) return;
    media.ready = true;
    const mediaBufferStall = media.stallCode === "media-buffering"
      || media.authorityStall?.kind === "media"
      || media.stallRequest?.kind === "media";
    if (mediaBufferStall) {
      media.stalled = false;
      media.stallCode = "";
      void queuePortableStall(media, false);
    }
    if (!media.stalled
      && !media.authorityStall
      && !media.stallPromise
      && !media.userPaused
      && elements.video.paused) void attemptPortableMediaPlay(media, { automatic: true });
    watchPortableMediaFrames(media);
  };
  const onPlaying = () => {
    if (!isCurrentPortableMedia(media)) return;
    if (media.fatalError || media.evidenceWriteBlocked) {
      elements.video.pause();
      return;
    }
    media.active = portableMediaObservation(media).active;
    media.activationRequired = false;
    media.errorMessage = "";
    schedulePortableClipEnd(media);
    if (media.stalled || media.authorityStall || media.stallPromise) {
      media.stalled = false;
      media.stallCode = "";
      void queuePortableStall(media, false);
    } else {
      void queuePortableTimeline(media, true, true);
    }
  };
  const onPause = () => {
    if (!isCurrentPortableMedia(media)) return;
    media.active = false;
    media.nextSampleDueMs = null;
    clearTimeout(media.clipEndTimer);
    if (media.evidenceWriteBlocked || media.fatalError) return;
    void queuePortableTimeline(media, false, true);
  };
  const onWaiting = () => {
    if (!isCurrentPortableMedia(media) || media.userPaused || media.segmentComplete) return;
    media.stalled = true;
    media.stallCode = "media-buffering";
    media.active = false;
    media.authorityPlaying = false;
    media.nextSampleDueMs = null;
    clearTimeout(media.clipEndTimer);
    void queuePortableStall(media, true, "media-buffering");
  };
  const onEnded = () => {
    if (!isCurrentPortableMedia(media)) return;
    const observation = portableMediaObservation(media);
    if (observation.segmentComplete) markPortableMediaComplete(media);
    else failPortableMedia(media, "The verified media ended before the published clip boundary.");
  };
  const onTimeUpdate = () => {
    if (isCurrentPortableMedia(media) && portableMediaObservation(media).segmentComplete) {
      markPortableMediaComplete(media);
    }
  };
  const onError = () => {
    if (!isCurrentPortableMedia(media)) return;
    const code = elements.video.error?.code ? ` (media error ${elements.video.error.code})` : "";
    failPortableMedia(media, `The browser could not decode the verified media${code}.`);
  };
  media.listeners = {
    loadedmetadata: onLoadedMetadata,
    canplay: onCanPlay,
    playing: onPlaying,
    pause: onPause,
    waiting: onWaiting,
    stalled: onWaiting,
    ended: onEnded,
    timeupdate: onTimeUpdate,
    error: onError,
  };
  for (const [type, listener] of Object.entries(media.listeners)) {
    elements.video.addEventListener(type, listener);
  }
  elements.video.onended = null;
  elements.video.pause();
  elements.video.loop = false;
  elements.video.playbackRate = 1;
  elements.video.preload = "auto";
  elements.video.setAttribute("src", objectUrl);
  elements.video.load();
}

function syncPortablePanel(now = performance.now()) {
  const browserSession = state.portable.browserSession;
  if (!browserSession) return;
  const authorityState = browserSession.state();
  const block = browserSession.currentBlock();
  if (!block) {
    if (state.portable.media) clearPortableMediaSource(state.portable.media);
    state.portable.currentBlock = undefined;
    state.portable.panelModel = undefined;
    if (authorityState.phase === "awaitingFinalization" && !state.portable.finishing) {
      void finishPortableRun();
      return;
    }
    throw new Error("The WASM authority did not identify a current portable block.");
  }
  if (!["instruction", "video", "questionnaire", "break", "completion"].includes(block.type)) {
    throw new Error(`Portable WebXR reached unsupported block ${block.blockId} (${block.type}); the run was stopped.`);
  }
  if (state.portable.currentBlock?.blockId !== block.blockId) {
    if (state.portable.media) clearPortableMediaSource(state.portable.media);
    const questionnaire = questionnaireForBlock(state.portable.study, block);
    state.portable.currentBlock = block;
    if (block.type === "video") {
      enterPortableVideoBlock(block, now);
      state.portable.errorMessage = "";
      return;
    }
    state.portable.questionnaire = questionnaire;
    state.portable.panelState = createXrPanelState({ block, questionnaire });
    state.portable.blockEnteredAt = now;
    state.portable.errorMessage = "";
  }
  if (block.type === "video") return;
  const context = {
    block,
    questionnaire: state.portable.questionnaire,
    state: state.portable.panelState,
    affectSnapshot: portableAffectSnapshot(),
    elapsedMs: Math.max(0, now - state.portable.blockEnteredAt),
  };
  state.portable.panelModel = projectPortableBlockToXrPanel(context);
}

async function applyPortablePanelEffect(effect) {
  if (!effect || state.portable.commandPending || state.portable.finishing) return;
  if (effect.blockId !== state.portable.currentBlock?.blockId) {
    state.portable.errorMessage = "The requested action belonged to an earlier block and was not applied.";
    return;
  }
  state.portable.commandPending = true;
  state.portable.errorMessage = "";
  try {
    await state.portable.browserSession.dispatch(effect.command);
    if (state.portable.finishing || state.portable.sessionEnded) return;
    if (effect.command.type === "submitQuestionnaire") {
      await state.portable.browserSession.advance();
      if (state.portable.finishing || state.portable.sessionEnded) return;
    }
    const authorityState = state.portable.browserSession.state();
    if (authorityState.phase === "awaitingFinalization") await finishPortableRun();
    else syncPortablePanel();
  } catch (error) {
    state.portable.errorMessage = error?.message ?? String(error);
    setStatus(`Portable study action failed: ${state.portable.errorMessage}`, true);
  } finally {
    state.portable.commandPending = false;
  }
}

function updatePortableStudy(now, deltaSeconds) {
  const frequency = affectParameters(state.currentX, state.currentY).frequency;
  const speed = state.portable.study?.pinnedSettings?.visual?.animationSpeedMultiplier ?? 1;
  state.phaseRadians = (state.phaseRadians + deltaSeconds * Math.PI * 2 * frequency * speed) % (Math.PI * 2);
  try {
    syncPortablePanel(now);
    const current = portableControllerSnapshot(state.session?.inputSources);
    const intent = controllerIntentFromSnapshot(state.portable.previousController, current);
    state.portable.previousController = current;
    if (!current.controllerPresent) {
      state.portable.errorMessage = "Touch controller tracking is unavailable. Reconnect a controller to continue.";
      const media = state.portable.media;
      if (media && portableMediaObservation(media).active) {
        media.stalled = true;
        media.stallCode = "controller-tracking-lost";
        media.active = false;
        media.authorityPlaying = false;
        media.nextSampleDueMs = null;
        elements.video.pause();
        void queuePortableStall(media, true, "controller-tracking-lost", "input");
      }
      return;
    }
    if (state.portable.errorMessage.startsWith("Touch controller tracking")) state.portable.errorMessage = "";
    if (state.portable.currentBlock?.type === "video") {
      const media = state.portable.media;
      if (!media || !isCurrentPortableMedia(media)) {
        throw new Error("The current portable video has no verified media runtime.");
      }
      if (media.stalled && media.stallCode === "controller-tracking-lost") {
        media.stalled = false;
        media.stallCode = "";
        void queuePortableStall(media, false);
      }
      let observation = portableMediaObservation(media);
      if (observation.segmentComplete) {
        markPortableMediaComplete(media);
        observation = portableMediaObservation(media);
      }
      media.active = observation.active;
      if (media.active && media.descriptor.collectAffect) {
        const next = advanceWebXrAffect(
          state,
          { x: current.x, y: -current.y },
          deltaSeconds,
        );
        Object.assign(state, next);
      }
      if (media.active) {
        if (media.stalled) {
          media.stalled = false;
          void queuePortableStall(media, false);
        } else if (!media.stallPromise && !media.authorityStall && !media.timelinePromise && (
          !media.authorityPlaying
          || now - media.lastTimelineReportAt >= PORTABLE_TIMELINE_HEARTBEAT_MS
        )) {
          void queuePortableTimeline(media, true);
        }
      } else {
        media.nextSampleDueMs = null;
        if (media.authorityPlaying && !media.timelinePromise) void queuePortableTimeline(media, false, true);
      }

      if (media.descriptor.collectAffect && !media.evidenceWriteBlocked && !media.fatalError) {
        const schedule = portableSampleSchedule({
          nowMs: now,
          nextDueMs: media.nextSampleDueMs,
          sampleRateHz: state.portable.study.pinnedSettings.acquisition.sampleRateHz,
          active: media.active,
          authorityPlaying: media.authorityPlaying && !media.authorityStall && !media.stallPromise,
          pending: media.samplePending,
        });
        media.nextSampleDueMs = schedule.nextDueMs;
        if (schedule.due) {
          media.samplePending = true;
          const sample = {
            currentValence: state.currentX,
            currentArousal: state.currentY,
            targetValence: state.targetX,
            targetArousal: state.targetY,
          };
          void guardPortableEvidenceWrite(
            media,
            () => state.portable.browserSession.recordAffect(sample),
          ).catch((error) => {
            if (isCurrentPortableMedia(media)) failPortableEvidence(
              media,
              `An affect sample could not be committed: ${error?.message ?? String(error)}`,
            );
          }).finally(() => {
            media.samplePending = false;
          });
        }
      }

      if (!intent || media.controlPending || state.portable.commandPending) return;
      if (media.evidenceWriteFailed && intent.type === "activate") {
        void abandonPortableEvidence(media);
        return;
      }
      if (media.evidenceWriteBlocked && !media.evidenceWriteResumeReady) return;
      const action = reducePortableMediaControl(media, intent);
      if (action?.type === "play") void attemptPortableMediaPlay(media);
      else if (action?.type === "pause") void pausePortableMedia(media);
      else if (action?.type === "advance") void advancePortableMedia(media);
      return;
    }
    if (!intent || state.portable.commandPending || !state.portable.currentBlock) return;
    const reduced = reduceXrPanelController({
      block: state.portable.currentBlock,
      questionnaire: state.portable.questionnaire,
      state: state.portable.panelState,
      intent,
      affectSnapshot: portableAffectSnapshot(),
      elapsedMs: Math.max(0, now - state.portable.blockEnteredAt),
    });
    state.portable.panelState = reduced.state;
    syncPortablePanel(now);
    if (reduced.effect) void applyPortablePanelEffect(reduced.effect);
  } catch (error) {
    state.portable.errorMessage = error?.message ?? String(error);
    setStatus(`Portable WebXR stopped safely: ${state.portable.errorMessage}`, true);
    if (!state.portable.finishing) void stopPortableRun("portable-runtime-error");
  }
}

async function stopPortableRun(reasonCode = "xr-session-ended") {
  const browserSession = state.portable.browserSession;
  if (!browserSession || state.portable.finishing || state.portable.lastResult) return;
  state.portable.finishing = true;
  try {
    const media = state.portable.media;
    if (media && isCurrentPortableMedia(media)) {
      media.active = false;
      elements.video.pause();
      await queuePortableTimeline(media, false, true);
      clearPortableMediaSource(media);
    }
    await browserSession.dispatchTail?.catch?.(() => {});
    const completed = browserSession.state().phase === "awaitingFinalization";
    const result = completed
      ? await browserSession.finalize()
      : await browserSession.stop(reasonCode);
    storePortableResult(result, !completed);
    state.phase = "finished";
  } catch (error) {
    const pending = browserSession.pendingJournalCommand?.();
    setStatus(
      pending
        ? `The portable record cannot be finalized while accepted ${pending.type} evidence is uncommitted. Closing immersive mode retains the staged boundary and previously committed events as partial browser evidence.`
        : `The partial portable record could not be finalized: ${error?.message ?? String(error)}`,
      true,
    );
  } finally {
    state.portable.finishing = false;
    if (state.session && !state.portable.sessionEnded) await state.session.end().catch(() => {});
  }
}

async function finishPortableRun() {
  const browserSession = state.portable.browserSession;
  if (!browserSession || state.portable.finishing || state.portable.lastResult) return;
  state.portable.finishing = true;
  try {
    const media = state.portable.media;
    if (media && isCurrentPortableMedia(media)) {
      media.active = false;
      elements.video.pause();
      await queuePortableTimeline(media, false, true);
      clearPortableMediaSource(media);
    }
    const result = await browserSession.finalize();
    storePortableResult(result, false);
    state.phase = "finished";
  } catch (error) {
    setStatus(`The portable result could not be finalized: ${error?.message ?? String(error)}`, true);
  } finally {
    state.portable.finishing = false;
    if (state.session && !state.portable.sessionEnded) await state.session.end().catch(() => {});
  }
}

async function handlePortableSessionEnd() {
  state.portable.sessionEnded = true;
  const media = state.portable.media;
  if (media && isCurrentPortableMedia(media)) {
    media.active = false;
    elements.video.pause();
    await queuePortableTimeline(media, false, true);
    clearPortableMediaSource(media);
  }
  if (state.portable.browserSession
    && !state.portable.lastResult
    && !state.portable.partialRetention
    && !state.portable.finishing) {
    await state.portable.browserSession.dispatchTail?.catch?.(() => {});
    if (state.portable.browserSession.state().phase === "awaitingFinalization") await finishPortableRun();
    else await stopPortableRun("xr-session-ended");
  }
  await state.portable.browserSession?.close?.().catch(() => {});
  state.portable.browserSession = undefined;
  state.portable.currentBlock = undefined;
  state.portable.questionnaire = undefined;
  state.portable.panelState = undefined;
  state.portable.panelModel = undefined;
  state.portable.media = undefined;
  state.session = undefined;
  state.referenceSpace = undefined;
  state.viewerSpace = undefined;
  state.phase = "finished";
  await releaseLowLatencyWakeLock();
  setPortableControlsDisabled(false);
  elements.start.disabled = !refreshPortablePreflight()?.ok;
}

function primePortableMediaPlayback() {
  const firstAsset = referencedContentAssets(state.portable.study)[0];
  const file = firstAsset ? state.portable.assetBindings.get(firstAsset.assetId) : undefined;
  if (!file) return Promise.resolve();
  const objectUrl = URL.createObjectURL(file);
  elements.video.onended = null;
  elements.video.pause();
  elements.video.setAttribute("src", objectUrl);
  elements.video.preload = "auto";
  elements.video.load();
  let timer;
  const playbackAttempt = elements.video.play().catch(() => {});
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, PORTABLE_MEDIA_UNLOCK_TIMEOUT_MS);
  });
  return Promise.race([playbackAttempt, timeout]).finally(() => {
    clearTimeout(timer);
    elements.video.pause();
    if (elements.video.getAttribute("src") === objectUrl) {
      elements.video.removeAttribute("src");
      elements.video.load();
    }
    URL.revokeObjectURL(objectUrl);
  });
}

async function startPortableStudy() {
  if (state.session) return;
  const report = refreshPortablePreflight();
  if (!state.portable.study || !state.portable.core || !report?.ok) {
    setStatus("Portable study preflight must pass before immersive mode starts.", true);
    elements.portableStudyFile.focus();
    return;
  }
  elements.download.hidden = true;
  elements.downloadManifest.hidden = true;
  state.lastCsv = "";
  state.portable.lastResult = undefined;
  state.portable.partialRetention = undefined;
  state.portable.lastManifestFilename = "";
  state.portable.sessionEnded = false;
  state.portable.errorMessage = "";
  setPortableControlsDisabled(true);
  elements.start.disabled = true;
  setStatus("Requesting immersive VR for the portable study…");
  let requestedSession;
  try {
    await acquireLowLatencyWakeLock();
    const sessionPromise = navigator.xr.requestSession("immersive-vr", { requiredFeatures: ["local-floor"] });
    const mediaUnlock = primePortableMediaPlayback();
    requestedSession = await sessionPromise;
    await mediaUnlock;
    if (!renderer) renderer = createRenderer(elements.canvas, elements.video);
    if (typeof renderer.gl.makeXRCompatible === "function") await renderer.gl.makeXRCompatible();
    const layer = new XRWebGLLayer(requestedSession, renderer.gl, { alpha: false, antialias: true });
    requestedSession.updateRenderState({ baseLayer: layer });
    const [referenceSpace, viewerSpace] = await Promise.all([
      requestedSession.requestReferenceSpace("local-floor"),
      requestedSession.requestReferenceSpace("viewer"),
    ]);
    state.session = requestedSession;
    state.referenceSpace = referenceSpace;
    state.viewerSpace = viewerSpace;
    setStatus("Immersive access granted. Checking for a tracked Touch controller before the run starts…");
    await waitForPortableController(requestedSession);

    const randomSeed = elements.portableRandomSeed.value.trim() || undefined;
    const counterbalanceGroup = state.portable.runInputs?.counterbalanceGroupCount
      ? Number(elements.portableCounterbalanceGroup.value)
      : undefined;
    const configuration = createRunConfiguration(state.portable.study, {
      platform: "webXr",
      participantCode: elements.portableParticipantCode.value.trim() || undefined,
      randomSeed,
      counterbalanceGroup,
      capabilities: report.availableCapabilities.filter((capability) => STUDY_CORE_RUN_CAPABILITIES.has(capability)),
      storageStatus: "ready",
      inputStatus: "ready",
      lslStatus: "unavailable",
    });
    const calibrationPoint = state.portable.runInputs?.needsCalibration
      ? {
          valence: Number(elements.portableCalibrationX.value),
          arousal: Number(elements.portableCalibrationY.value),
        }
      : undefined;
    const browserSession = new BrowserStudySession({
      core: state.portable.core,
      study: state.portable.study,
      configuration,
      assetBindings: state.portable.assetBindings,
    });
    state.portable.browserSession = browserSession;
    state.sessionId = configuration.runId;
    state.runStartedAt = performance.now();
    state.previousFrameAt = 0;
    state.currentX = calibrationPoint?.valence ?? 0;
    state.currentY = calibrationPoint?.arousal ?? 0;
    state.targetX = state.currentX;
    state.targetY = state.currentY;
    state.phaseRadians = 0;
    state.phase = "running";
    state.portable.previousController = { x: 0, y: 0, select: false, back: false };
    state.portable.commandPending = false;
    state.portable.finishing = false;
    state.portable.media = undefined;
    offsets = createProjectionOffsets(`${state.portable.study.studyId}-${configuration.runId}`, profiles.waveCount);
    await browserSession.initialize({ calibrationPoint });
    syncPortablePanel();
    requestedSession.addEventListener("visibilitychange", () => {
      const media = state.portable.media;
      if (!media || !isCurrentPortableMedia(media)) return;
      if (requestedSession.visibilityState !== "visible") {
        if (media.evidenceWriteWatchdog?.snapshot().activeCount > 0) {
          media.evidenceWriteWatchdog.alarmNow("xr-session-not-visible");
          return;
        }
        if (!media.segmentComplete && (portableMediaObservation(media).active || media.authorityPlaying)) {
          media.stalled = true;
          media.stallCode = "xr-session-not-visible";
          media.active = false;
          media.authorityPlaying = false;
          media.nextSampleDueMs = null;
          elements.video.pause();
          void queuePortableStall(media, true, "xr-session-not-visible", "platform");
        }
      } else if (media.stalled && media.stallCode === "xr-session-not-visible") {
        media.stalled = false;
        media.stallCode = "";
        void queuePortableStall(media, false);
      }
    });
    requestedSession.addEventListener("end", () => { void handlePortableSessionEnd(); }, { once: true });
    requestedSession.requestAnimationFrame(renderFrame);
    setStatus(`${state.portable.study.title} is running under the shared WASM authority. Use the Touch controls shown above.`);
  } catch (error) {
    if (state.portable.browserSession && !state.portable.lastResult) {
      await stopPortableRun("portable-start-failed");
    }
    await requestedSession?.end().catch(() => {});
    await state.portable.browserSession?.close?.().catch(() => {});
    if (state.portable.media) clearPortableMediaSource(state.portable.media);
    state.portable.browserSession = undefined;
    state.session = undefined;
    state.referenceSpace = undefined;
    state.viewerSpace = undefined;
    await releaseLowLatencyWakeLock();
    setPortableControlsDisabled(false);
    elements.start.disabled = !refreshPortablePreflight()?.ok;
    setStatus(`Portable immersive mode could not start: ${error?.message ?? String(error)}`, true);
  }
}

function renderFrame(now, frame) {
  const session = frame.session;
  const pose = frame.getViewerPose(state.referenceSpace);
  const viewerPose = frame.getViewerPose(state.viewerSpace);
  const deltaSeconds = state.previousFrameAt ? Math.min(0.05, (now - state.previousFrameAt) / 1_000) : 0;
  state.previousFrameAt = now;
  if (state.runnerMode === "portable") updatePortableStudy(now, deltaSeconds);
  else {
    updateStudy(now, deltaSeconds);
    updateControllerRig(frame, pose);
  }
  if (pose) renderer.render(session, pose, viewerPose, state);
  if (state.phase !== "finished") session.requestAnimationFrame(renderFrame);
}

async function startStudy() {
  if (state.session) return;
  if (state.runnerMode === "portable") return startPortableStudy();
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
  elements.runModeLegacy.disabled = true;
  elements.runModePortable.disabled = true;
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
  elements.downloadManifest.hidden = true;
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
        elements.runModeLegacy.disabled = false;
        elements.runModePortable.disabled = false;
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
    elements.runModeLegacy.disabled = false;
    elements.runModePortable.disabled = false;
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

function drawCanvasLines(context, lines, x, y, lineHeight) {
  for (const [index, line] of lines.entries()) context.fillText(line, x, y + index * lineHeight);
}

function portableProgressText(panel) {
  const progress = panel.progress ?? {};
  const parts = [];
  if (Number.isInteger(progress.itemIndex)) parts.push(`Question ${progress.itemIndex + 1}/${progress.itemCount}`);
  if (Number.isInteger(progress.pageIndex) && progress.pageCount > 1) {
    parts.push(`Page ${progress.pageIndex + 1}/${progress.pageCount}`);
  }
  return parts.join(" · ");
}

function drawPortableFace(context, snapshot, centerX, centerY, radius) {
  const geometry = buildFaceGeometry({
    x: snapshot.currentX,
    y: snapshot.currentY,
    phase: snapshot.phase,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  });
  context.save();
  context.translate(centerX, centerY);
  context.scale(radius * geometry.headScale, radius * geometry.headScale);
  context.fillStyle = "#f3c75f";
  context.beginPath();
  context.ellipse(0, 0, 0.82, 1, 0, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "#2a230f";
  context.lineWidth = 0.045;
  context.lineCap = "round";
  context.stroke(new Path2D(geometry.leftBrowPath));
  context.stroke(new Path2D(geometry.rightBrowPath));
  context.fillStyle = "#15130e";
  context.beginPath();
  context.ellipse(-0.34, -0.18, 0.075, geometry.eyeRy, 0, 0, Math.PI * 2);
  context.ellipse(0.34, -0.18, 0.075, geometry.eyeRy, 0, 0, Math.PI * 2);
  context.fill();
  context.fill(new Path2D(geometry.mouthPath));
  context.restore();
}

function drawPortableFlubber(context, snapshot, centerX, centerY, radius, study) {
  const visual = study.portable.study?.pinnedSettings?.visual ?? {};
  const rendered = buildFlubberPath({
    profiles,
    offsets,
    x: snapshot.currentX,
    y: snapshot.currentY,
    phase: snapshot.phase,
    baseShape: visual.baseShape ?? "circle",
    palette: visual.palette,
    amplitudeScale: visual.pulseAmplitudeMultiplier ?? 1,
    disorderScale: visual.disorderMultiplier ?? 1,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  });
  context.save();
  context.translate(centerX, centerY);
  context.scale(radius, radius);
  const path = new Path2D(rendered.path);
  context.fillStyle = rendered.color;
  context.fill(path);
  context.strokeStyle = "rgba(255,255,255,0.92)";
  context.lineWidth = 0.025;
  context.stroke(path);
  context.restore();
}

function drawPortableComparison(context, panel, study, contentBottom) {
  const snapshot = panel.presentation.snapshot;
  const centerY = Math.max(360, Math.min(445, contentBottom + 84));
  const radius = contentBottom > 330 ? 78 : 92;
  context.save();
  context.globalAlpha = study.portable.study?.pinnedSettings?.visual?.opacity ?? 1;
  drawPortableFace(context, snapshot, 400, centerY, radius);
  drawPortableFlubber(context, snapshot, 800, centerY, radius, study);
  context.restore();
  context.fillStyle = "#9babbc";
  context.font = "600 18px system-ui, sans-serif";
  context.textAlign = "center";
  context.fillText("FACE", 400, centerY + radius + 24);
  context.fillText("FLUBBER", 800, centerY + radius + 24);
  context.fillStyle = "#dbe5ef";
  context.font = "600 17px system-ui, sans-serif";
  context.fillText(
    `Same snapshot · X ${snapshot.currentX.toFixed(2)} · Y ${snapshot.currentY.toFixed(2)} · presentation only, non-diagnostic`,
    600,
    centerY + radius + 50,
  );
}

function drawPortableControl(context, control, x, y, width, height, focused, compact = false) {
  const selected = control.selected === true;
  context.fillStyle = focused ? "#183b4d" : selected ? "#173629" : "#101823";
  context.fillRect(x, y, width, height);
  context.strokeStyle = focused ? "#ffd166" : selected ? "#79e2bd" : "#435064";
  context.lineWidth = focused ? 4 : 2;
  context.strokeRect(x, y, width, height);
  context.fillStyle = control.enabled === false ? "#6f7a88" : "#f4f7fb";
  const fontSize = compact ? 18 : 21;
  const lineHeight = compact ? 20 : 24;
  context.font = focused ? `700 ${fontSize}px system-ui, sans-serif` : `600 ${fontSize}px system-ui, sans-serif`;
  context.textAlign = "left";
  const marker = control.kind === "choice" || control.kind === "acknowledgement"
    ? selected ? "● " : "○ "
    : selected ? "✓ " : "";
  const lines = control.labelLines ?? [control.label];
  drawCanvasLines(
    context,
    lines.map((line, index) => `${index === 0 ? marker : "   "}${line}`),
    x + 18,
    y + (compact ? 22 : 28),
    lineHeight,
  );
}

function paintPortablePanel(context, canvas, study) {
  const panel = study.portable.panelModel;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#080d14";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#435064";
  context.lineWidth = 4;
  context.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  if (!panel) {
    context.fillStyle = "#f4f7fb";
    context.font = "700 36px system-ui, sans-serif";
    context.textAlign = "center";
    context.fillText("Preparing portable study…", canvas.width / 2, canvas.height / 2);
    return;
  }

  context.textAlign = "left";
  context.fillStyle = "#78d7ff";
  context.font = "750 39px system-ui, sans-serif";
  drawCanvasLines(context, panel.title.lines, 58, 64, 45);
  const progress = portableProgressText(panel);
  if (progress) {
    context.fillStyle = "#9babbc";
    context.font = "650 18px system-ui, sans-serif";
    context.textAlign = "right";
    context.fillText(progress, 1142, 58);
  }

  context.textAlign = "left";
  context.fillStyle = "#dce5ef";
  context.font = "500 24px system-ui, sans-serif";
  const contentY = panel.title.lines.length > 1 ? 148 : 112;
  const contentLineHeight = 29;
  drawCanvasLines(context, panel.content.lines, 58, contentY, contentLineHeight);
  const contentBottom = contentY + Math.max(1, panel.content.lines.length) * contentLineHeight;

  if (panel.presentation.type === "faceFlubberComparison") {
    drawPortableComparison(context, panel, study, contentBottom);
  } else {
    const answerControls = panel.controls.filter(({ row }) => row < 20);
    let y = Math.max(245, contentBottom + 8);
    for (const control of answerControls) {
      const lineCount = Math.max(1, control.labelLines?.length ?? 1);
      const height = Math.max(32, 10 + lineCount * 20);
      drawPortableControl(context, control, 58, y, 1084, height, control.id === panel.focusId, true);
      y += height + 5;
      if (control.help && answerControls.length === 1) {
        context.fillStyle = "#9babbc";
        context.font = "500 16px system-ui, sans-serif";
        context.fillText(control.help, 74, y + 15);
      }
    }
  }

  const navigation = panel.controls.filter(({ row }) => row >= 20);
  const gap = 14;
  const navWidth = navigation.length > 0 ? (1084 - gap * (navigation.length - 1)) / navigation.length : 0;
  navigation.forEach((control, index) => {
    drawPortableControl(
      context,
      control,
      58 + index * (navWidth + gap),
      652,
      navWidth,
      54,
      control.id === panel.focusId,
    );
  });

  if (panel.timing?.remainingMs > 0) {
    context.fillStyle = "#ffd99a";
    context.font = "650 18px system-ui, sans-serif";
    context.textAlign = "right";
    context.fillText(`Continue unlocks in ${Math.ceil(panel.timing.remainingMs / 1000)} s`, 1142, 640);
  }
  if (panel.response?.feedback?.message) {
    context.fillStyle = "#ffaaa3";
    context.font = "650 18px system-ui, sans-serif";
    context.textAlign = "left";
    context.fillText(panel.response.feedback.message, 58, 640);
  }
  if (study.portable.commandPending) {
    context.fillStyle = "#9de5b3";
    context.font = "650 18px system-ui, sans-serif";
    context.textAlign = "right";
    context.fillText("Committing to the local journal…", 1142, 640);
  } else if (study.portable.errorMessage) {
    context.fillStyle = "#ffaaa3";
    context.font = "650 17px system-ui, sans-serif";
    context.textAlign = "left";
    const message = study.portable.errorMessage.length > 110
      ? `${study.portable.errorMessage.slice(0, 107)}…`
      : study.portable.errorMessage;
    context.fillText(message, 58, 640);
  }
}

function paintPortableMediaHud(context, canvas, study) {
  const media = study.portable.media;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(8, 13, 20, 0.94)";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#435064";
  context.lineWidth = 4;
  context.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);
  if (!media) return;
  const positionMs = portableMediaPositionMs(
    media.descriptor,
    Number.isFinite(Number(elements.video.currentTime))
      ? Number(elements.video.currentTime)
      : media.descriptor.clip.startMs / 1_000,
  );
  const progress = Math.max(0, Math.min(1, positionMs / media.descriptor.clip.durationMs));
  const status = media.errorMessage
    || (media.segmentComplete
      ? "Segment complete · right trigger: Continue"
      : !media.ready
        ? "Loading and seeking verified media…"
        : media.controlPending
          ? "Applying media control…"
          : media.active
            ? "Playing · right trigger or left trigger: Pause"
            : "Paused · right trigger: Resume");

  context.textAlign = "left";
  context.fillStyle = "#78d7ff";
  context.font = "750 31px system-ui, sans-serif";
  context.fillText(`${media.descriptor.purpose.toUpperCase()} · ${media.descriptor.asset.assetId}`, 34, 48);
  context.fillStyle = media.errorMessage ? "#ffaaa3" : "#e3ebf4";
  context.font = "650 24px system-ui, sans-serif";
  context.fillText(status.length > 78 ? `${status.slice(0, 75)}…` : status, 34, 90);
  context.fillStyle = "#273241";
  context.fillRect(34, 119, 932, 18);
  context.fillStyle = media.segmentComplete ? "#79e2bd" : "#78d7ff";
  context.fillRect(34, 119, Math.round(932 * progress), 18);
  context.fillStyle = "#aeb9c7";
  context.font = "600 21px system-ui, sans-serif";
  const seconds = `${(positionMs / 1_000).toFixed(1)} / ${(media.descriptor.clip.durationMs / 1_000).toFixed(1)} s`;
  context.fillText(seconds, 34, 175);
  context.textAlign = "right";
  context.fillText(
    media.descriptor.collectAffect
      ? `Affect · X ${study.currentX.toFixed(2)} · Y ${study.currentY.toFixed(2)} · samples only while playing`
      : "Affect collection off for this block",
    966,
    175,
  );
  context.fillStyle = "#8f9baa";
  context.font = "550 18px system-ui, sans-serif";
  context.fillText(
    `${media.descriptor.asset.projection} · ${media.descriptor.asset.stereoLayout} · local SHA-256 verified`,
    966,
    217,
  );
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
    uniform vec2 u_uv_scale;
    uniform vec2 u_uv_offset;
    varying vec2 v_tex_coord;
    void main() {
      gl_Position = u_mvp * vec4(a_position, 1.0);
      v_tex_coord = a_tex_coord * u_uv_scale + u_uv_offset;
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
  const hemisphereVertices = createEquirectangularMediaVertices({ horizontalDegrees: 180 });
  const createGeometryBuffer = (vertices) => {
    const geometryBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, geometryBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    return geometryBuffer;
  };
  const quadBuffer = createGeometryBuffer(quadVertices);
  const sphereBuffer = createGeometryBuffer(sphereVertices);
  const hemisphereBuffer = createGeometryBuffer(hemisphereVertices);
  const sphereViewMatrices = [new Float32Array(16), new Float32Array(16)];
  const position = gl.getAttribLocation(program, "a_position");
  const texCoord = gl.getAttribLocation(program, "a_tex_coord");
  const mvp = gl.getUniformLocation(program, "u_mvp");
  const uvScale = gl.getUniformLocation(program, "u_uv_scale");
  const uvOffset = gl.getUniformLocation(program, "u_uv_offset");
  const videoTexture = createTexture(gl);
  const flubberTexture = createTexture(gl);
  const portablePanelTexture = createTexture(gl);
  const portableMediaHudTexture = createTexture(gl);
  const flubberCanvas = document.createElement("canvas");
  flubberCanvas.width = FLUBBER_CANVAS_WIDTH;
  flubberCanvas.height = FLUBBER_CANVAS_HEIGHT;
  const context = flubberCanvas.getContext("2d");
  const portablePanelCanvas = document.createElement("canvas");
  portablePanelCanvas.width = PORTABLE_PANEL_CANVAS_WIDTH;
  portablePanelCanvas.height = PORTABLE_PANEL_CANVAS_HEIGHT;
  const portablePanelContext = portablePanelCanvas.getContext("2d");
  const portableMediaHudCanvas = document.createElement("canvas");
  portableMediaHudCanvas.width = PORTABLE_MEDIA_HUD_CANVAS_WIDTH;
  portableMediaHudCanvas.height = PORTABLE_MEDIA_HUD_CANVAS_HEIGHT;
  const portableMediaHudContext = portableMediaHudCanvas.getContext("2d");

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
    const portableVisual = study.runnerMode === "portable"
      ? study.portable.study?.pinnedSettings?.visual ?? {}
      : {};
    const rendered = buildFlubberPath({
      profiles,
      offsets,
      x: study.currentX,
      y: study.currentY,
      phase: study.phaseRadians,
      baseShape: portableVisual.baseShape ?? study.flubberBaseShape,
      palette: portableVisual.palette,
      amplitudeScale: portableVisual.pulseAmplitudeMultiplier ?? 1,
      disorderScale: portableVisual.disorderMultiplier ?? 1,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
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
      study.runnerMode === "portable"
        ? study.portable.media?.active
          ? "Right stick: valence × arousal"
          : "Affect sampling paused with media"
        : study.paused ? "PAUSED — press Y to resume" : (study.remoteHudText || study.polarHudText || "Right stick: valence × arousal"),
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

  function uploadPortablePanel(study) {
    paintPortablePanel(portablePanelContext, portablePanelCanvas, study);
    gl.bindTexture(gl.TEXTURE_2D, portablePanelTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, portablePanelCanvas);
  }

  function uploadPortableMediaHud(study) {
    paintPortableMediaHud(portableMediaHudContext, portableMediaHudCanvas, study);
    gl.bindTexture(gl.TEXTURE_2D, portableMediaHudTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, portableMediaHudCanvas);
  }

  function bindGeometry(buffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(texCoord);
    gl.vertexAttribPointer(texCoord, 2, gl.FLOAT, false, 20, 12);
  }

  function draw(
    texture,
    projection,
    view,
    model,
    transparent,
    geometryBuffer,
    vertexCount,
    textureTransform = IDENTITY_TEXTURE_TRANSFORM,
  ) {
    const viewModel = multiplyMatrices(view, model);
    const projectionViewModel = multiplyMatrices(projection, viewModel);
    gl.uniformMatrix4fv(mvp, false, projectionViewModel);
    gl.uniform2fv(uvScale, textureTransform.scale);
    gl.uniform2fv(uvOffset, textureTransform.offset);
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
      if (study.runnerMode === "portable") {
        gl.clearColor(0.008, 0.012, 0.02, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.useProgram(program);
        const media = study.portable.media;
        if (media) {
          const hasVideoFrame = elements.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
          if (hasVideoFrame) uploadVideo();
          if (media.descriptor.collectAffect) uploadFlubber(study);
          uploadPortableMediaHud(study);
          for (let viewIndex = 0; viewIndex < pose.views.length; viewIndex += 1) {
            const view = pose.views[viewIndex];
            const panelView = viewerPose?.views?.[viewIndex] ?? view;
            const viewport = session.renderState.baseLayer.getViewport(view);
            const textureTransform = portableStereoUvTransform(
              media.descriptor.asset.stereoLayout,
              view.eye || "none",
            );
            gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
            if (hasVideoFrame && media.descriptor.asset.projection === "flat") {
              draw(
                videoTexture,
                view.projectionMatrix,
                view.transform.inverse.matrix,
                VIDEO_MODEL,
                false,
                quadBuffer,
                6,
                textureTransform,
              );
            } else if (hasVideoFrame) {
              const immersiveBuffer = media.descriptor.asset.projection === "equirectangular180"
                ? hemisphereBuffer
                : sphereBuffer;
              const immersiveVertices = media.descriptor.asset.projection === "equirectangular180"
                ? hemisphereVertices
                : sphereVertices;
              draw(
                videoTexture,
                view.projectionMatrix,
                matrixWithoutTranslation(view.transform.inverse.matrix, sphereViewMatrices[viewIndex]),
                SPHERE_MODEL,
                false,
                immersiveBuffer,
                immersiveVertices.length / 5,
                textureTransform,
              );
            }
            if (media.descriptor.collectAffect) {
              draw(
                flubberTexture,
                panelView.projectionMatrix,
                panelView.transform.inverse.matrix,
                PORTABLE_MEDIA_FLUBBER_MODEL,
                true,
                quadBuffer,
                6,
              );
            }
            draw(
              portableMediaHudTexture,
              panelView.projectionMatrix,
              panelView.transform.inverse.matrix,
              PORTABLE_MEDIA_HUD_MODEL,
              true,
              quadBuffer,
              6,
            );
          }
          return;
        }
        uploadPortablePanel(study);
        for (let viewIndex = 0; viewIndex < pose.views.length; viewIndex += 1) {
          const view = pose.views[viewIndex];
          const panelView = viewerPose?.views?.[viewIndex] ?? view;
          const viewport = session.renderState.baseLayer.getViewport(view);
          gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
          draw(
            portablePanelTexture,
            panelView.projectionMatrix,
            panelView.transform.inverse.matrix,
            PORTABLE_PANEL_MODEL,
            false,
            quadBuffer,
            6,
          );
        }
        return;
      }
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
    updateRunModeControls();
  } catch (error) {
    setStatus(`WebXR capability check failed: ${error?.message ?? String(error)}`, true);
  }
}

elements.start.addEventListener("click", startStudy);
elements.download.addEventListener("click", downloadLastCsv);
elements.downloadManifest.addEventListener("click", downloadLastManifest);
elements.stimulus.addEventListener("change", () => applyStimulus(webXrStimulusById(elements.stimulus.value)));
function updateRiggingControls() {
  const enabled = elements.controllerFollow.checked;
  elements.controllerFollowHand.disabled = !enabled;
  elements.controllerFollowControls.classList.toggle("is-disabled", !enabled);
  elements.flubberSizeOutput.value = Number(elements.flubberSize.value).toFixed(2);
}
function restoreControls() {
  elements.runModeLegacy.disabled = false;
  elements.runModePortable.disabled = false;
  if (state.runnerMode === "portable") {
    setPortableControlsDisabled(false);
    elements.start.disabled = !refreshPortablePreflight()?.ok;
    return;
  }
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
function updateRunModeControls() {
  if (state.session) return;
  const portable = elements.runModePortable.checked;
  state.runnerMode = portable ? "portable" : "legacy";
  elements.legacyStudySetup.hidden = portable;
  elements.portableStudySetup.hidden = !portable;
  elements.legacyControllerHelp.hidden = portable;
  elements.portableControllerHelp.hidden = !portable;
  elements.polarPanel.hidden = portable;
  elements.remotePanel.hidden = portable;
  elements.riggingPanel.hidden = portable;
  elements.webhookField.hidden = portable;
  elements.webhookNote.hidden = portable;
  elements.stimulusAttribution.hidden = portable;
  elements.start.textContent = portable ? "Enter VR and run portable study" : "Enter VR and start";
  elements.introduction.textContent = portable
    ? "Load a published portable study before entering VR. The shared WASM authority owns block order, responses, lifecycle, and the durable local research record."
    : "Choose a repository-hosted stimulus, enter VR, and move the affect tracker with the right Touch thumbstick. Study records stay on the headset unless you enter a webhook below; the separate incoming-signal button exchanges only anonymous Flubber X/Y coordinates after you press it.";
  elements.requirements.textContent = portable
    ? "Requires immersive WebXR, a tracked Touch controller, the shared WASM study authority, IndexedDB, and hash-verified local files for every content asset. Unsupported codecs, projections, stereo layouts, and YouTube fail before XR; physical Quest playback is not yet qualified."
    : "Requires Meta Quest Browser with WebXR. CEAP-360VR choices are one-minute, silent, noncommercial research stimuli shown on a full equirectangular sphere. The video, affect samples, and CSV processing stay in the browser unless the optional webhook is used.";
  if (portable) {
    elements.video.pause();
    const report = refreshPortablePreflight();
    setStatus(
      report?.ok
        ? "Portable study is ready for immersive logical preflight. Physical controller presence is checked before the authority starts."
        : state.portable.study
          ? "Resolve the portable study preflight issues before entering VR."
          : "Load a published StudyDefinitionV1 JSON file to prepare a portable run.",
      Boolean(state.portable.study && !report?.ok),
    );
  } else {
    updatePresentationControls();
  }
}
function updatePresentationControls() {
  if (state.runnerMode === "portable") {
    refreshPortablePreflight();
    return;
  }
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
elements.runModeLegacy.addEventListener("change", updateRunModeControls);
elements.runModePortable.addEventListener("change", updateRunModeControls);
elements.portableStudyFile.addEventListener("change", () => { void loadPortableStudyFile(); });
elements.portableMediaFiles.addEventListener("change", () => { void bindPortableMediaFiles(); });
elements.portableRandomSeed.addEventListener("input", refreshPortablePreflight);
elements.portableCounterbalanceGroup.addEventListener("input", refreshPortablePreflight);
elements.portableParticipantCode.addEventListener("input", refreshPortablePreflight);
for (const [input, output] of [
  [elements.portableCalibrationX, elements.portableCalibrationXValue],
  [elements.portableCalibrationY, elements.portableCalibrationYValue],
]) {
  input.addEventListener("input", () => {
    output.value = Number(input.value).toFixed(2);
    refreshPortablePreflight();
  });
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
