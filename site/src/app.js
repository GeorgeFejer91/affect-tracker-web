import {
  affectParameters,
  affectPaletteColor,
  buildFlubberPath,
  clamp,
  createProfiles,
  createProjectionOffsets,
  smoothToward,
} from "./math.js?v=shape-1";
import {
  applyStep,
  constrainWidgetPosition,
  continuousMovement,
  isNativeFormControl,
  normalizeWheel,
} from "./input.js";
import { AffectLogger, ExperimentCsvWriter } from "./logger.js";
import {
  computeExperimentLayout,
  DEFAULT_EXPERIMENT_CONFIG,
  DEMO_START_SECONDS,
  DEMO_VIDEO_ID,
  DEMO_VIDEO_URL,
  EXPERIMENT_SAMPLE_INTERVAL_MS,
  experimentFilename,
  normalizeExperimentConfig,
} from "./experiment.js";
import { createScreenCalibrationController } from "../screen-calibration/controller.js?v=screen-calibration-4";
import {
  fitTracePoints,
  TOUCH_FEEDBACK_CONTINUOUS,
  TOUCH_FEEDBACK_GATED,
  TOUCH_TRACE_ALGORITHM_VERSION,
  TouchTraceAnalyzer,
  TRACE_DURATION_MS,
} from "./touch-trace.js";
import { pictureInPictureOptions, pictureInPictureSupported } from "./picture-in-picture.js";
import {
  clientPointToAffectCoordinate,
  isSmartphoneTouchViewport,
  SMARTPHONE_LAYOUT_MAX_WIDTH,
  startsOnCoordinateMarker,
} from "./mobile.js?v=mobile-direct-1";
import {
  ACCORDION_PROTOCOLS,
  normalizeAccordionState,
  setAccordionProtocolOpen,
  toggleAccordionProtocol,
  touchProtocolActive,
} from "./accordion-protocols.js";
import { createVrSession, hashVideoFile, vrSessionJson } from "./vr-session.js?v=shape-1";
import {
  createPolarH10BrowserSession,
  defaultPolarMappings,
  normalizePolarMappings,
  normalizePolarMetric,
  POLAR_METRICS,
  polarMetricDefinition,
  polarWebBluetoothSupport,
} from "./polar-stream.js?v=remote-13";
import { createPolarH10ReplaySession, polarReplayEnabled } from "./polar-replay.js?v=remote-13";
import {
  createFlubberBroadcaster,
  createFlubberReceiver,
  denormalizeFlubberViewportPosition,
  normalizeFlubberViewportPosition,
  relativeFlubberViewportPosition,
} from "./flubber-remote.js?v=collaboration-3";
import {
  createSettingsSnapshotBroadcaster,
  createSettingsSnapshotReceiver,
  groundControlFilename,
  normalizeGroundControlName,
  shouldDismissGroundRadar,
} from "./ground-control.js?v=ground-control-3";
import {
  combineUniverseCoordinates,
  createFlubberParty,
  createUniverseLink,
  morphPartyBirthContours,
  oneWayGroundRole,
  partyBudVectorGeometry,
  partyFlubberPlacement,
} from "./flubber-collaboration.js?v=collaboration-8";
import { createRetroSoundboard, retroCueForMessage, RETRO_THEME_ID } from "./retro-theme.js?v=retro-1";
import {
  actionForBinding,
  ADVANCED_BINDING_LABELS,
  bindingUpdatesForCapture,
  BINDING_LABELS,
  cloneDefaultSettings,
  describeBinding,
  DIRECTION_BY_ACTION,
  mouseButtonName,
  normalizePortableSettings,
  opacityToTransparencyPercent,
  portableSettingsJson,
  transparencyPercentToOpacity,
  wheelDirection,
} from "./portable-settings.js?v=shape-1";

const STORAGE_KEY = "affect-tracker-web/preferences-v1";
const SAMPLE_INTERVAL_SECONDS = 1 / 20;
const MAX_DELTA_SECONDS = 0.05;
const FEATURE_FLUBBER_INSET_PERCENT = 7.5;
const FEATURE_DOT_INSET_PERCENT = 3;
const PARTY_BIRTH_DURATION_MS = 4000;
const PARTY_BIRTH_MORPH_START = 0.72;
const PARTY_BIRTH_TOPOLOGY_END = 0.87;

const elements = {
  stage: document.querySelector("#stage"),
  widget: document.querySelector("#affect-widget"),
  partyStage: document.querySelector("#flubber-party-stage"),
  basePath: document.querySelector("#base-path"),
  outlinePath: document.querySelector("#outline-path"),
  haloPath: document.querySelector("#halo-path"),
  panel: document.querySelector("#control-panel"),
  panelToggle: document.querySelector("#panel-toggle"),
  panelContent: document.querySelector("#panel-content"),
  toggleSymbol: document.querySelector(".toggle-symbol"),
  mobileDirectController: document.querySelector("#mobile-direct-controller"),
  mobileFlubberDragArea: document.querySelector("#mobile-flubber-drag-area"),
  mobileDirectFlubber: document.querySelector("#mobile-direct-flubber"),
  mobileDirectBasePath: document.querySelector("#mobile-direct-base-path"),
  mobileDirectOutlinePath: document.querySelector("#mobile-direct-outline-path"),
  mobileDirectHaloPath: document.querySelector("#mobile-direct-halo-path"),
  mobileDirectValenceOutput: document.querySelector("#mobile-direct-valence-output"),
  mobileDirectArousalOutput: document.querySelector("#mobile-direct-arousal-output"),
  mobileCoordinateSpace: document.querySelector("#mobile-coordinate-space"),
  mobileCoordinateCanvas: document.querySelector("#mobile-coordinate-canvas"),
  mobileCoordinatePoint: document.querySelector("#mobile-coordinate-point"),
  mobileOpenSettings: document.querySelector("#mobile-open-settings"),
  mobileCloseSettings: document.querySelector("#mobile-close-settings"),
  experimentPanel: document.querySelector("#experiment-panel"),
  experimentPanelToggle: document.querySelector("#experiment-panel-toggle"),
  experimentToggleSymbol: document.querySelector("#experiment-toggle-symbol"),
  screenCalibrationPanel: document.querySelector("#screen-calibration-panel"),
  screenCalibrationPanelToggle: document.querySelector("#screen-calibration-panel-toggle"),
  screenCalibrationToggleSymbol: document.querySelector("#screen-calibration-toggle-symbol"),
  touchPlaygroundPanel: document.querySelector("#touch-playground-panel"),
  touchPlaygroundPanelToggle: document.querySelector("#touch-playground-panel-toggle"),
  touchPlaygroundToggleSymbol: document.querySelector("#touch-playground-toggle-symbol"),
  polarStreamPanel: document.querySelector("#polar-stream-panel"),
  polarStreamPanelToggle: document.querySelector("#polar-stream-panel-toggle"),
  polarStreamToggleSymbol: document.querySelector("#polar-stream-toggle-symbol"),
  groundControlPanel: document.querySelector("#ground-control-panel"),
  groundControlPanelToggle: document.querySelector("#ground-control-panel-toggle"),
  groundControlToggleSymbol: document.querySelector("#ground-control-toggle-symbol"),
  groundControlName: document.querySelector("#ground-control-name"),
  groundJsonBroadcastButton: document.querySelector("#ground-json-broadcast-button"),
  groundJsonBroadcastStatus: document.querySelector("#ground-json-broadcast-status"),
  groundJsonBroadcastDetails: document.querySelector("#ground-json-broadcast-details"),
  groundJsonSource: document.querySelector("#ground-json-source"),
  groundJsonListeners: document.querySelector("#ground-json-listeners"),
  groundJsonScanButton: document.querySelector("#ground-json-scan-button"),
  groundLiveScanButton: document.querySelector("#ground-live-scan-button"),
  groundLiveReceiveStatus: document.querySelector("#ground-live-receive-status"),
  groundUniverseButton: document.querySelector("#ground-universe-button"),
  groundUniverseStatus: document.querySelector("#ground-universe-status"),
  groundUniverseDetails: document.querySelector("#ground-universe-details"),
  groundUniversePartner: document.querySelector("#ground-universe-partner"),
  groundUniverseListeners: document.querySelector("#ground-universe-listeners"),
  groundUniverseState: document.querySelector("#ground-universe-state"),
  groundPartyButton: document.querySelector("#ground-party-button"),
  groundPartyStatus: document.querySelector("#ground-party-status"),
  groundPartyRoster: document.querySelector("#ground-party-roster"),
  groundPartyGuests: document.querySelector("#ground-party-guests"),
  groundPartyStopButton: document.querySelector("#ground-party-stop-button"),
  groundRadarDialog: document.querySelector("#ground-radar-dialog"),
  groundRadarTitle: document.querySelector("#ground-radar-title"),
  groundRadarStatus: document.querySelector("#ground-radar-status"),
  groundRadarSources: document.querySelector("#ground-radar-sources"),
  groundRadarClose: document.querySelector("#ground-radar-close"),
  groundRadarStop: document.querySelector("#ground-radar-stop"),
  groundJsonReceived: document.querySelector("#ground-json-received"),
  groundJsonReceivedName: document.querySelector("#ground-json-received-name"),
  groundJsonReceivedShape: document.querySelector("#ground-json-received-shape"),
  groundJsonReceivedTime: document.querySelector("#ground-json-received-time"),
  groundJsonApplyButton: document.querySelector("#ground-json-apply-button"),
  polarSupportNote: document.querySelector("#polar-support-note"),
  polarDiagnosticOutputs: [...document.querySelectorAll("[data-polar-diagnostic]")],
  polarConnectButton: document.querySelector("#polar-connect-button"),
  polarDisconnectButton: document.querySelector("#polar-disconnect-button"),
  polarConnectionStatus: document.querySelector("#polar-connection-status"),
  polarEcgPort: document.querySelector("#polar-ecg-port"),
  polarEcgCanvas: document.querySelector("#polar-ecg-canvas"),
  polarEcgRate: document.querySelector("#polar-ecg-rate"),
  polarBattery: document.querySelector("#polar-battery"),
  polarSampleCount: document.querySelector("#polar-sample-count"),
  polarMetricCards: document.querySelector("#polar-metric-cards"),
  polarAxisFields: [...document.querySelectorAll("[data-polar-axis]")],
  remoteBroadcastButton: document.querySelector("#flubber-remote-broadcast-button"),
  remoteBroadcastForegroundButton: document.querySelector("#flubber-remote-foreground-button"),
  remoteBroadcastStatus: document.querySelector("#flubber-remote-broadcast-status"),
  remoteBroadcastDetails: document.querySelector("#flubber-remote-broadcast-details"),
  remoteBroadcastSource: document.querySelector("#flubber-remote-source"),
  remoteBroadcastListeners: document.querySelector("#flubber-remote-listeners"),
  remoteBroadcastRoute: document.querySelector("#flubber-remote-route"),
  valenceOutput: document.querySelector("#valence-output"),
  arousalOutput: document.querySelector("#arousal-output"),
  modeInputs: [...document.querySelectorAll("input[name='input-mode']")],
  touchTrackingToggle: document.querySelector("#touch-tracking-toggle"),
  touchFeedbackModeInputs: [...document.querySelectorAll("input[name='touch-feedback-mode']")],
  touchPointerType: document.querySelector("#touch-pointer-type"),
  touchGateStatus: document.querySelector("#touch-gate-status"),
  touchHideCursorToggles: [...document.querySelectorAll("[data-touch-hide-cursor]")],
  touchTraceFeedbackToggle: document.querySelector("#touch-trace-feedback-toggle"),
  touchPlaygroundSurface: document.querySelector("#touch-playground-surface"),
  touchPlaygroundCanvas: document.querySelector("#touch-playground-canvas"),
  playgroundShapeOutput: document.querySelector("#playground-shape-output"),
  playgroundSpeedOutput: document.querySelector("#playground-speed-output"),
  playgroundConfidenceOutput: document.querySelector("#playground-confidence-output"),
  touchAffectSpace: document.querySelector("#touch-affect-space"),
  touchAffectCanvas: document.querySelector("#touch-affect-space-canvas"),
  touchAffectPoint: document.querySelector("#touch-affect-point"),
  touchAffectValenceOutput: document.querySelector("#touch-affect-valence-output"),
  touchAffectArousalOutput: document.querySelector("#touch-affect-arousal-output"),
  touchPreviewFlubber: document.querySelector("#touch-preview-flubber"),
  touchPreviewBasePath: document.querySelector("#touch-preview-base-path"),
  touchPreviewOutlinePath: document.querySelector("#touch-preview-outline-path"),
  touchPreviewHaloPath: document.querySelector("#touch-preview-halo-path"),
  touchTracePanel: document.querySelector("#touch-trace-panel"),
  touchTraceCanvas: document.querySelector("#touch-trace-canvas"),
  touchShapeOutput: document.querySelector("#touch-shape-output"),
  touchSpeedOutput: document.querySelector("#touch-speed-output"),
  touchConfidenceOutput: document.querySelector("#touch-confidence-output"),
  directionButtons: [...document.querySelectorAll("[data-direction]")],
  resetButton: document.querySelector("#reset-button"),
  pauseButton: document.querySelector("#pause-button"),
  exportButton: document.querySelector("#export-button"),
  clearButton: document.querySelector("#clear-button"),
  eventCount: document.querySelector("#event-count"),
  sampleCount: document.querySelector("#sample-count"),
  bufferCount: document.querySelector("#buffer-count"),
  status: document.querySelector("#status-region"),
  featureSpace: document.querySelector("#web-feature-space"),
  featureCanvas: document.querySelector("#web-feature-space-canvas"),
  featurePoint: document.querySelector("#web-feature-point"),
  featureFlubberPath: document.querySelector("#web-feature-flubber-path"),
  featureValenceOutput: document.querySelector("#web-feature-valence-output"),
  featureArousalOutput: document.querySelector("#web-feature-arousal-output"),
  paletteInputs: [...document.querySelectorAll("[data-palette]")],
  bindingGrid: document.querySelector("#web-binding-grid"),
  advancedBindingGrid: document.querySelector("#web-advanced-binding-grid"),
  stepSize: document.querySelector("#web-step-size"),
  continuousSpeed: document.querySelector("#web-continuous-speed"),
  response: document.querySelector("#web-response"),
  animationSpeed: document.querySelector("#web-animation-speed"),
  amplitudeScale: document.querySelector("#web-amplitude-scale"),
  disorderScale: document.querySelector("#web-disorder-scale"),
  baseShapeButtons: [...document.querySelectorAll("[data-base-shape]")],
  widgetSize: document.querySelector("#web-widget-size"),
  transparency: document.querySelector("#web-transparency"),
  transparencyOutput: document.querySelector("#web-transparency-output"),
  widgetVisibleButton: document.querySelector("#widget-visible-button"),
  dragToggleButton: document.querySelector("#drag-toggle-button"),
  settingsExportButton: document.querySelector("#settings-export-button"),
  settingsImportButton: document.querySelector("#settings-import-button"),
  settingsImportFile: document.querySelector("#settings-import-file"),
  inputSettings: document.querySelector("#input-settings"),
  bindingCaptureDialog: document.querySelector("#binding-capture-dialog"),
  bindingCaptureTitle: document.querySelector("#binding-capture-title"),
  bindingCapturePairNote: document.querySelector("#binding-capture-pair-note"),
  bindingCaptureCurrent: document.querySelector("#binding-capture-current"),
  bindingCaptureCancel: document.querySelector("#binding-capture-cancel"),
  lslStreamName: document.querySelector("#web-lsl-stream-name"),
  lslStreamType: document.querySelector("#web-lsl-stream-type"),
  lslMarkerName: document.querySelector("#web-lsl-marker-name"),
  lslSampleRate: document.querySelector("#web-lsl-sample-rate"),
  lslSourceId: document.querySelector("#web-lsl-source-id"),
  questVideoFile: document.querySelector("#quest-video-file"),
  questVideoProjection: document.querySelector("#quest-video-projection"),
  questVideoStereo: document.querySelector("#quest-video-stereo"),
  questVideoLoop: document.querySelector("#quest-video-loop"),
  questFlubberWidth: document.querySelector("#quest-flubber-width"),
  questFlubberDistance: document.querySelector("#quest-flubber-distance"),
  questFlubberX: document.querySelector("#quest-flubber-x"),
  questFlubberY: document.querySelector("#quest-flubber-y"),
  questMixedReality: document.querySelector("#quest-mixed-reality"),
  questFollowController: document.querySelector("#quest-follow-controller"),
  questFollowControllerHand: document.querySelector("#quest-follow-controller-hand"),
  questFollowControllerDistance: document.querySelector("#quest-follow-controller-distance"),
  questStick: document.querySelector("#quest-stick"),
  questResetButton: document.querySelector("#quest-reset-button"),
  questPauseButton: document.querySelector("#quest-pause-button"),
  questShowControllerModels: document.querySelector("#quest-show-controller-models"),
  questShowAffectValues: document.querySelector("#quest-show-affect-values"),
  questExportButton: document.querySelector("#quest-export-button"),
  questExportStatus: document.querySelector("#quest-export-status"),
  pictureInPictureToggle: document.querySelector("#picture-in-picture-toggle"),
  pictureInPictureNote: document.querySelector("#picture-in-picture-note"),
  experimentStartButton: document.querySelector("#experiment-start-button"),
  experimentSource: document.querySelector("#experiment-source"),
  experimentYoutubeUrl: document.querySelector("#experiment-youtube-url"),
  experimentStartSeconds: document.querySelector("#experiment-start-seconds"),
  experimentEndSeconds: document.querySelector("#experiment-end-seconds"),
  experimentSourceNote: document.querySelector("#experiment-source-note"),
  experimentSizeWarning: document.querySelector("#experiment-size-warning"),
  experimentRetryExportButton: document.querySelector("#experiment-retry-export-button"),
  experimentLayer: document.querySelector("#experiment-layer"),
  experimentCountdown: document.querySelector("#experiment-countdown"),
  experimentPlayerShell: document.querySelector("#experiment-player-shell"),
  experimentVideo: document.querySelector("#experiment-video"),
  youtubePlayer: document.querySelector("#youtube-player"),
  retroThemeToggle: document.querySelector("#retro-theme-toggle"),
  retroThemeState: document.querySelector("#retro-theme-state"),
  retroToast: document.querySelector("#retro-toast"),
  retroToastIcon: document.querySelector("#retro-toast-icon"),
  retroToastMessage: document.querySelector("#retro-toast-message"),
};

async function loadBundledSettings() {
  try {
    const response = await fetch("./settings.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return normalizePortableSettings(await response.json());
  } catch {
    return cloneDefaultSettings();
  }
}

function readPreferences(bundledSettings) {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") ?? {};
    let settings;
    try {
      settings = normalizePortableSettings(parsed.settings ?? bundledSettings);
    } catch {
      settings = structuredClone(bundledSettings);
    }
    // Migrate the original browser-only preferences without discarding the new shared defaults.
    if (!parsed.settings) {
      if (parsed.inputMode === "step" || parsed.inputMode === "continuous") settings.inputMode = parsed.inputMode;
      if (parsed.palette) {
        try { settings.palette = normalizePortableSettings({ ...settings, palette: parsed.palette }).palette; } catch { /* retain defaults */ }
      }
      if (Number.isFinite(parsed.widgetSize)) settings.overlay.size = clamp(parsed.widgetSize, 120, 640);
    }
    return {
      widgetX: Number.isFinite(parsed.widgetX) ? parsed.widgetX : settings.overlay.x + settings.overlay.size / 2,
      widgetY: Number.isFinite(parsed.widgetY) ? parsed.widgetY : settings.overlay.y + settings.overlay.size / 2,
      panelOpen: typeof parsed.panelOpen === "boolean" ? parsed.panelOpen : !parsed.seenIntro,
      experimentPanelOpen: typeof parsed.experimentPanelOpen === "boolean" ? parsed.experimentPanelOpen : false,
      screenCalibrationPanelOpen: typeof parsed.screenCalibrationPanelOpen === "boolean" ? parsed.screenCalibrationPanelOpen : false,
      touchPlaygroundPanelOpen: typeof parsed.touchPlaygroundPanelOpen === "boolean" ? parsed.touchPlaygroundPanelOpen : false,
      polarStreamPanelOpen: typeof parsed.polarStreamPanelOpen === "boolean" ? parsed.polarStreamPanelOpen : false,
      groundControlPanelOpen: typeof parsed.groundControlPanelOpen === "boolean" ? parsed.groundControlPanelOpen : false,
      groundControlName: typeof parsed.groundControlName === "string" ? parsed.groundControlName : "",
      polarMappings: normalizePolarMappings(parsed.polarMappings),
      inputSource: parsed.inputSource === "touch-trace" ? "touch-trace" : "manual",
      touchFeedbackMode: parsed.touchFeedbackMode === TOUCH_FEEDBACK_CONTINUOUS
        ? TOUCH_FEEDBACK_CONTINUOUS
        : TOUCH_FEEDBACK_GATED,
      touchHideCursor: parsed.touchHideCursor === true,
      touchTraceFeedback: parsed.touchTraceFeedback === true,
      retroTheme: parsed.retroTheme === true,
      mobileTouchIntroSeen: parsed.mobileTouchIntroSeen === true,
      settings,
      seenIntro: true,
    };
  } catch {
    return {
      widgetX: bundledSettings.overlay.x + bundledSettings.overlay.size / 2,
      widgetY: bundledSettings.overlay.y + bundledSettings.overlay.size / 2,
      panelOpen: true,
      experimentPanelOpen: false,
      screenCalibrationPanelOpen: false,
      touchPlaygroundPanelOpen: false,
      polarStreamPanelOpen: false,
      groundControlPanelOpen: false,
      groundControlName: "",
      polarMappings: defaultPolarMappings(),
      inputSource: "manual",
      touchFeedbackMode: TOUCH_FEEDBACK_GATED,
      touchHideCursor: false,
      touchTraceFeedback: false,
      retroTheme: false,
      mobileTouchIntroSeen: false,
      settings: structuredClone(bundledSettings),
      seenIntro: true,
    };
  }
}

const bundledSettings = await loadBundledSettings();
const preferences = readPreferences(bundledSettings);
const smartphoneTouchViewport = isSmartphoneTouchViewport({
  width: window.innerWidth,
  height: window.innerHeight,
  coarsePointer: window.matchMedia("(pointer: coarse)").matches,
  maxTouchPoints: navigator.maxTouchPoints,
});
const smartphoneLayoutActive = (Number.isFinite(window.innerWidth)
  && window.innerWidth > 0
  && window.innerWidth <= SMARTPHONE_LAYOUT_MAX_WIDTH)
  || smartphoneTouchViewport;
document.body.classList.toggle("is-smartphone-layout", smartphoneLayoutActive);
const state = {
  currentX: 0,
  currentY: 0,
  targetX: 0,
  targetY: 0,
  inputMode: preferences.settings.inputMode,
  inputSource: preferences.inputSource,
  touchFeedbackMode: preferences.touchFeedbackMode,
  stepSize: preferences.settings.stepSize,
  continuousSpeed: preferences.settings.continuousSpeed,
  response: preferences.settings.response,
  bindings: preferences.settings.bindings,
  advancedBindings: preferences.settings.advancedBindings,
  visual: preferences.settings.visual,
  animationActive: true,
  widgetX: preferences.widgetX,
  widgetY: preferences.widgetY,
  widgetSize: preferences.settings.overlay.size,
  widgetOpacity: preferences.settings.overlay.opacity,
  widgetVisible: preferences.settings.overlay.visible,
  widgetDragEnabled: true,
  panelOpen: preferences.panelOpen,
  experimentPanelOpen: preferences.experimentPanelOpen,
  screenCalibrationPanelOpen: preferences.screenCalibrationPanelOpen,
  touchPlaygroundPanelOpen: preferences.touchPlaygroundPanelOpen,
  polarStreamPanelOpen: preferences.polarStreamPanelOpen,
  groundControlPanelOpen: preferences.groundControlPanelOpen,
  groundControlName: preferences.groundControlName,
  polarMappings: preferences.polarMappings,
  polarConnected: false,
  polarConnecting: false,
  polarDriveActive: false,
  touchDriveActive: false,
  polarMetrics: {},
  polarAxisValues: {
    valence: { value: "", normalized: "" },
    arousal: { value: "", normalized: "" },
  },
  palette: preferences.settings.palette,
  lsl: preferences.settings.lsl,
  heldDirections: new Set(),
  phase: 0,
  dragging: false,
  touchHideCursor: preferences.touchHideCursor,
  touchTraceFeedback: preferences.touchTraceFeedback,
  retroTheme: preferences.retroTheme,
  mobileTouchIntroSeen: preferences.mobileTouchIntroSeen,
};
Object.assign(state, normalizeAccordionState(state));
if (smartphoneTouchViewport && !state.mobileTouchIntroSeen) {
  state.panelOpen = true;
  state.experimentPanelOpen = false;
  state.screenCalibrationPanelOpen = false;
  state.touchPlaygroundPanelOpen = false;
  state.polarStreamPanelOpen = false;
  state.groundControlPanelOpen = false;
  state.mobileTouchIntroSeen = true;
}

const experiment = {
  phase: "idle",
  id: "",
  adapter: undefined,
  config: { ...DEFAULT_EXPERIMENT_CONFIG },
  sampleTimer: undefined,
  restore: undefined,
  videoTimeSeconds: "",
  ownsFullscreen: false,
  writer: undefined,
  playbackActive: false,
  activeElapsedMs: 0,
  activeStartedAt: undefined,
  lastExport: undefined,
  displayWidgetSize: undefined,
  traceRect: undefined,
};

const screenCalibration = createScreenCalibrationController({
  announce,
  canStart: () => experiment.phase === "idle",
  onStateChange: () => updateExperimentSourceControls(),
});

function touchTrackingActive() {
  return touchProtocolActive({
    inputSource: state.inputSource,
    touchPlaygroundPanelOpen: state.touchPlaygroundPanelOpen,
    experimentPhase: experiment.phase,
  });
}

function liveRemoteSnapshot() {
  return flubberReceiver.snapshot();
}

function liveRemoteOwnsAxes(snapshot = liveRemoteSnapshot()) {
  return Boolean(snapshot.selectedStreamId && snapshot.latest
    && (snapshot.phase === "live" || snapshot.phase === "stale"));
}

function currentExperimentActiveElapsedMs(now = performance.now()) {
  const active = experiment.playbackActive && experiment.activeStartedAt !== undefined
    ? now - experiment.activeStartedAt
    : 0;
  return Math.round((experiment.activeElapsedMs + active) * 1000) / 1000;
}

function experimentRecordContext() {
  if (!experiment.writer) return {};
  let videoTime = experiment.videoTimeSeconds;
  try {
    const current = experiment.adapter?.currentTime?.();
    if (Number.isFinite(current)) videoTime = Math.round(current * 1000) / 1000;
  } catch { /* the media adapter may be resetting */ }
  return {
    experimentId: experiment.id,
    stimulusId: experiment.adapter?.stimulusId ?? DEMO_VIDEO_ID,
    stimulusTimeSeconds: videoTime,
    activeElapsedMs: currentExperimentActiveElapsedMs(),
    playbackActive: experiment.playbackActive,
    algorithmVersion: touchTrackingActive() ? TOUCH_TRACE_ALGORITHM_VERSION : "",
    ...screenCalibration.recordContext(),
  };
}

const logger = new AffectLogger();
const touchTrace = new TouchTraceAnalyzer({
  width: window.innerWidth,
  height: window.innerHeight,
  feedbackMode: state.touchFeedbackMode,
});
const polarReplay = polarReplayEnabled();
const polarSession = polarReplay ? createPolarH10ReplaySession() : createPolarH10BrowserSession();
const flubberBroadcaster = createFlubberBroadcaster();
const flubberReceiver = createFlubberReceiver();
const universeLink = createUniverseLink();
const flubberParty = createFlubberParty();
const settingsSnapshotBroadcaster = createSettingsSnapshotBroadcaster();
const settingsSnapshotReceiver = createSettingsSnapshotReceiver();
let groundRadarMode = "";
let groundRadarPendingSourceId = "";
let pendingSettingsSnapshot;
let universeLocalCurrent = { currentX: state.currentX, currentY: state.currentY };
const partyGuestViews = new Map();
let partyBirthGuestId = "";
let partyBirthAnimation;
let partyBirthVectorView;
let polarEcgWindow = [];
let polarBatteryPercent;
let polarObservedSampleRate = 130;
const profiles = createProfiles();
let offsets = createProjectionOffsets(logger.sessionId, profiles.waveCount);
let previousTimestamp;
let sampleAccumulator = 0;
let dragOffsetX = 0;
let dragOffsetY = 0;
let featurePointerId;
let mobileCoordinatePointerId;
let mobileFlubberPointerId;
let mobileFlubberDragOffsetX = 0;
let mobileFlubberDragOffsetY = 0;
const liveRemotePositionSync = {
  streamId: "",
  senderAnchor: undefined,
  localAnchor: undefined,
  lastSequence: undefined,
};
let captureInput;
let pictureInPictureWindow;
let pictureInPictureView;
let broadcastWakeLock;
let broadcastOwnsPictureInPicture = false;
let animationFrameOwner;
let animationFrameId;
let activeTracePointerId;
let lastLoggedGateCommitSequence = 0;
let retroToastTimer;
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const retroSoundboard = createRetroSoundboard();

function savePreferences() {
  const savedX = experiment.restore?.widgetX ?? state.widgetX;
  const savedY = experiment.restore?.widgetY ?? state.widgetY;
  const settings = settingsFromState();
  if (experiment.restore) {
    settings.overlay.x = Math.round(savedX - state.widgetSize / 2);
    settings.overlay.y = Math.round(savedY - state.widgetSize / 2);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    widgetX: savedX,
    widgetY: savedY,
    panelOpen: state.panelOpen,
    experimentPanelOpen: state.experimentPanelOpen,
    screenCalibrationPanelOpen: state.screenCalibrationPanelOpen,
    touchPlaygroundPanelOpen: state.touchPlaygroundPanelOpen,
    polarStreamPanelOpen: state.polarStreamPanelOpen,
    groundControlPanelOpen: state.groundControlPanelOpen,
    groundControlName: state.groundControlName,
    polarMappings: state.polarMappings,
    inputSource: state.inputSource,
    touchFeedbackMode: state.touchFeedbackMode,
    touchHideCursor: state.touchHideCursor,
    touchTraceFeedback: state.touchTraceFeedback,
    retroTheme: state.retroTheme,
    mobileTouchIntroSeen: state.mobileTouchIntroSeen,
    settings,
    seenIntro: true,
  }));
}

function settingsFromState() {
  return normalizePortableSettings({
    version: 1,
    inputMode: state.inputMode,
    stepSize: state.stepSize,
    continuousSpeed: state.continuousSpeed,
    response: state.response,
    bindings: state.bindings,
    advancedBindings: state.advancedBindings,
    visual: state.visual,
    palette: state.palette,
    overlay: {
      x: Math.round(state.widgetX - state.widgetSize / 2),
      y: Math.round(state.widgetY - state.widgetSize / 2),
      size: Math.round(state.widgetSize),
      opacity: state.widgetOpacity,
      visible: state.widgetVisible,
    },
    lsl: state.lsl,
  });
}

function announce(message) {
  elements.status.textContent = "";
  requestAnimationFrame(() => {
    elements.status.textContent = message;
  });
  if (state.retroTheme) showRetroToast(message);
}

function showRetroToast(message) {
  const cue = retroCueForMessage(message);
  clearTimeout(retroToastTimer);
  elements.retroToast.dataset.cue = cue;
  elements.retroToastIcon.textContent = cue === "alert" ? "!" : cue === "confirm" ? "✓" : "i";
  elements.retroToastMessage.textContent = message;
  elements.retroToast.hidden = false;
  retroSoundboard.play(cue);
  retroToastTimer = setTimeout(() => {
    elements.retroToast.hidden = true;
  }, cue === "alert" ? 5200 : 3400);
}

function applyRetroTheme() {
  document.documentElement.dataset.theme = state.retroTheme ? RETRO_THEME_ID : "modern";
  document.body.classList.toggle("theme-windows-95", state.retroTheme);
  elements.retroThemeToggle.setAttribute("aria-pressed", String(state.retroTheme));
  elements.retroThemeToggle.setAttribute("aria-label", `${state.retroTheme ? "Disable" : "Enable"} Windows 95 visual and sound skin`);
  elements.retroThemeState.textContent = state.retroTheme ? "skin on" : "skin off";
  if (!state.retroTheme) {
    clearTimeout(retroToastTimer);
    elements.retroToast.hidden = true;
  }
}

function activeLogger() {
  return experiment.writer ?? logger;
}

function recordEvent(source, action, control = "", value = "") {
  activeLogger().record("event", { source, action, control, value }, state);
  updateLoggerDisplay();
}

function recordSample() {
  activeLogger().record("sample", { source: "timer", action: "sample" }, state);
  updateLoggerDisplay();
}

function recordTouchMetric() {
  if (!experiment.writer || !touchTrackingActive()) return;
  const metric = touchTrace.snapshot();
  experiment.writer.record("touch_metric", {
    source: "touch-trace",
    action: "feature-sample",
    algorithmVersion: metric.algorithmVersion,
    pointerType: metric.pointerType,
    strokeId: metric.strokeId,
    rawSpeed: metric.rawSpeed,
    filteredSpeed: metric.filteredSpeed,
    speedFeature: metric.speedFeature,
    shapeFeature: metric.shapeFeature,
    turnActivity: metric.turnActivity,
    turnCoherence: metric.turnCoherence,
    signFlipRate: metric.signFlipRate,
    roughness: metric.roughness,
    directionReversal: metric.directionReversal,
    circleScore: metric.circleScore,
    angularScore: metric.angularScore,
    windingTurns: metric.windingTurns,
    radialVariation: metric.radialVariation,
    directionEntropy: metric.directionEntropy,
    dominantCornerCount: metric.dominantCornerCount,
    speedLower: metric.speedLower,
    speedUpper: metric.speedUpper,
    shapeLower: metric.shapeLower,
    shapeUpper: metric.shapeUpper,
    mappedX: metric.mappedX,
    mappedY: metric.mappedY,
    speedConfidence: metric.speedConfidence,
    shapeConfidence: metric.shapeConfidence,
    speedContinuityActive: metric.speedContinuityActive,
    motionActive: metric.motionActive,
    feedbackHeld: metric.feedbackHeld,
    gateId: metric.gateId,
    gateOpen: metric.gateOpen,
    gateCommitSequence: metric.gateCommitSequence,
    gateDurationMs: metric.gateDurationMs,
    gateDeltaX: metric.gateDeltaX,
    gateDeltaY: metric.gateDeltaY,
    gateLiveActive: metric.gateLiveActive,
    gateLiveRateX: metric.gateLiveRateX,
    gateLiveRateY: metric.gateLiveRateY,
    gateLiveDeltaX: metric.gateLiveDeltaX,
    gateLiveDeltaY: metric.gateLiveDeltaY,
    speedCalibrationSamples: metric.speedCalibrationSamples,
    shapeCalibrationSamples: metric.shapeCalibrationSamples,
    traceFeedbackVisible: state.touchTraceFeedback,
  }, state);
}

function recordTouchGateCommit(metric) {
  activeLogger().record("event", {
    source: "touch-trace",
    action: "gate-commit",
    control: `gate-${metric.gateId}`,
    value: `live-dx=${metric.gateLiveDeltaX.toFixed(4)},live-dy=${metric.gateLiveDeltaY.toFixed(4)}`,
    algorithmVersion: metric.algorithmVersion,
    pointerType: metric.pointerType,
    strokeId: metric.strokeId,
    speedFeature: metric.speedFeature,
    shapeFeature: metric.shapeFeature,
    directionReversal: metric.directionReversal,
    speedLower: metric.speedLower,
    speedUpper: metric.speedUpper,
    shapeLower: metric.shapeLower,
    shapeUpper: metric.shapeUpper,
    mappedX: metric.mappedX,
    mappedY: metric.mappedY,
    speedConfidence: metric.speedConfidence,
    shapeConfidence: metric.shapeConfidence,
    speedContinuityActive: metric.speedContinuityActive,
    motionActive: metric.motionActive,
    feedbackHeld: metric.feedbackHeld,
    gateId: metric.gateId,
    gateOpen: metric.gateOpen,
    gateCommitSequence: metric.gateCommitSequence,
    gateDurationMs: metric.gateDurationMs,
    gateDeltaX: metric.gateDeltaX,
    gateDeltaY: metric.gateDeltaY,
    gateLiveActive: metric.gateLiveActive,
    gateLiveRateX: metric.gateLiveRateX,
    gateLiveRateY: metric.gateLiveRateY,
    gateLiveDeltaX: metric.gateLiveDeltaX,
    gateLiveDeltaY: metric.gateLiveDeltaY,
    speedCalibrationSamples: metric.speedCalibrationSamples,
    shapeCalibrationSamples: metric.shapeCalibrationSamples,
    traceFeedbackVisible: state.touchTraceFeedback,
  }, state);
  updateLoggerDisplay();
}

function applyTouchTraceState(metric) {
  state.targetX = clamp(metric.targetX);
  state.targetY = clamp(metric.targetY);
  if (metric.gateCommitSequence < lastLoggedGateCommitSequence) {
    lastLoggedGateCommitSequence = metric.gateCommitSequence;
  }
  if (metric.gateCommitSequence > lastLoggedGateCommitSequence) {
    lastLoggedGateCommitSequence = metric.gateCommitSequence;
    recordTouchGateCommit(metric);
  }
}

function updateLoggerDisplay() {
  const active = activeLogger();
  elements.eventCount.textContent = active.eventCount.toLocaleString();
  elements.sampleCount.textContent = active.sampleCount.toLocaleString();
  elements.bufferCount.textContent = experiment.writer
    ? `${experiment.writer.length.toLocaleString()} / append-only`
    : `${logger.buffer.length.toLocaleString()} / ${logger.buffer.capacity.toLocaleString()}`;
}

function updatePanelState() {
  elements.panel.classList.toggle("is-collapsed", !state.panelOpen);
  elements.panelToggle.setAttribute("aria-expanded", String(state.panelOpen));
  elements.toggleSymbol.textContent = state.panelOpen ? "−" : "+";
}

function updateExperimentPanelState() {
  elements.experimentPanel.classList.toggle("is-collapsed", !state.experimentPanelOpen);
  elements.experimentPanelToggle.setAttribute("aria-expanded", String(state.experimentPanelOpen));
  elements.experimentToggleSymbol.textContent = state.experimentPanelOpen ? "−" : "+";
}

function updateScreenCalibrationPanelState() {
  elements.screenCalibrationPanel.classList.toggle("is-collapsed", !state.screenCalibrationPanelOpen);
  elements.screenCalibrationPanelToggle.setAttribute("aria-expanded", String(state.screenCalibrationPanelOpen));
  elements.screenCalibrationToggleSymbol.textContent = state.screenCalibrationPanelOpen ? "−" : "+";
}

function updateTouchPlaygroundPanelState() {
  elements.touchPlaygroundPanel.classList.toggle("is-collapsed", !state.touchPlaygroundPanelOpen);
  elements.touchPlaygroundPanelToggle.setAttribute("aria-expanded", String(state.touchPlaygroundPanelOpen));
  elements.touchPlaygroundToggleSymbol.textContent = state.touchPlaygroundPanelOpen ? "−" : "+";
}

function updatePolarPanelState() {
  elements.polarStreamPanel.classList.toggle("is-collapsed", !state.polarStreamPanelOpen);
  elements.polarStreamPanelToggle.setAttribute("aria-expanded", String(state.polarStreamPanelOpen));
  elements.polarStreamToggleSymbol.textContent = state.polarStreamPanelOpen ? "−" : "+";
}

function updateGroundControlPanelState() {
  elements.groundControlPanel.classList.toggle("is-collapsed", !state.groundControlPanelOpen);
  elements.groundControlPanelToggle.setAttribute("aria-expanded", String(state.groundControlPanelOpen));
  elements.groundControlToggleSymbol.textContent = state.groundControlPanelOpen ? "−" : "+";
}

function updateAccordionPanelStates() {
  updatePanelState();
  updateExperimentPanelState();
  updateScreenCalibrationPanelState();
  updateTouchPlaygroundPanelState();
  updatePolarPanelState();
  updateGroundControlPanelState();
}

function toggleTopLevelProtocol(protocolId) {
  const protocol = ACCORDION_PROTOCOLS[protocolId];
  Object.assign(state, toggleAccordionProtocol(state, protocolId));
  updateAccordionPanelStates();
  updateInputSourceControls();
  applyPolarMappings();
  updateExperimentSourceControls();
  constrainAndRenderWidget();
  savePreferences();
  recordEvent(
    "panel",
    state[protocol.stateKey] ? "expand" : "collapse",
    protocol.panelId,
    state[protocol.stateKey],
  );
}

function polarAxisField(axis, field) {
  return elements.polarAxisFields
    .find((fieldset) => fieldset.dataset.polarAxis === axis)
    ?.querySelector(`[data-polar-field='${field}']`);
}

function polarAxisDriven(axis) {
  const mapping = state.polarMappings[axis];
  return !touchTrackingActive()
    && state.polarConnected
    && mapping.metric !== "manual"
    && normalizePolarMetric(state.polarMetrics[mapping.metric], mapping) !== undefined;
}

function manualAxisAvailable(axis) {
  return !liveRemoteOwnsAxes() && !touchTrackingActive() && !polarAxisDriven(axis);
}

function directionAxis(direction) {
  return direction === "left" || direction === "right" ? "valence" : "arousal";
}

function formatPolarMetric(metricId, value) {
  if (!Number.isFinite(value)) return "—";
  const definition = polarMetricDefinition(metricId);
  if (metricId === "ecg_local_power") return `${Math.round(value).toLocaleString()} ${definition?.unit ?? ""}`.trim();
  const digits = ["excitement_score", "excitometer"].includes(metricId)
    ? 3
    : (metricId === "ln_rmssd" ? 2 : (metricId === "heart_rate" ? 0 : 1));
  return `${value.toFixed(digits)} ${definition?.unit ?? ""}`.trim();
}

function updatePolarMappingControls() {
  for (const axis of ["valence", "arousal"]) {
    const mapping = state.polarMappings[axis];
    const metric = polarAxisField(axis, "metric");
    const minimum = polarAxisField(axis, "minimum");
    const maximum = polarAxisField(axis, "maximum");
    const invert = polarAxisField(axis, "invert");
    const output = polarAxisField(axis, "value");
    metric.value = mapping.metric;
    minimum.value = mapping.minimum;
    maximum.value = mapping.maximum;
    invert.checked = mapping.invert;
    const manual = mapping.metric === "manual";
    minimum.disabled = manual;
    maximum.disabled = manual;
    invert.disabled = manual;
    if (manual) output.value = "Manual";
    else if (touchTrackingActive()) output.value = "Paused by Touch/Trackpad";
    else if (!state.polarConnected) output.value = "Waiting for H10";
    else {
      const value = state.polarMetrics[mapping.metric];
      const normalized = normalizePolarMetric(value, mapping);
      output.value = normalized === undefined
        ? "Waiting for metric"
        : `${formatPolarMetric(mapping.metric, value)} → ${formatCoordinate(normalized)}`;
    }
  }
  for (const card of elements.polarMetricCards.querySelectorAll("[data-polar-metric]")) {
    const metricId = card.dataset.polarMetric;
    const assigned = ["valence", "arousal"].some((axis) => state.polarMappings[axis].metric === metricId);
    card.classList.toggle("is-assigned", assigned);
    for (const button of card.querySelectorAll("[data-polar-quick-axis]")) {
      button.setAttribute("aria-pressed", String(state.polarMappings[button.dataset.polarQuickAxis].metric === metricId));
    }
  }
}

function updatePolarConnectionUi(message = state.polarConnected ? "Polar H10 connected" : "Not connected", error = false) {
  const support = polarReplay ? { supported: true } : polarWebBluetoothSupport();
  elements.polarConnectButton.hidden = state.polarConnected;
  elements.polarConnectButton.disabled = !support.supported || state.polarConnecting;
  elements.polarDisconnectButton.hidden = !state.polarConnected;
  elements.polarConnectionStatus.value = message;
  elements.polarConnectionStatus.classList.toggle("is-error", error);
  elements.polarBattery.value = Number.isFinite(polarBatteryPercent) ? `${polarBatteryPercent}%` : "—";
  elements.polarBattery.hidden = !Number.isFinite(polarBatteryPercent);
  elements.polarStreamPanel.classList.toggle("is-connected", state.polarConnected);
}

function renderPolarDiagnostics(snapshot = polarSession.diagnosticSnapshot()) {
  const stageLabels = {
    idle: "Idle",
    chooser: "Chrome chooser",
    GATT_CONNECT: "GATT link",
    PMD_SERVICE: "PMD service",
    PMD_CONTROL: "PMD control",
    PMD_DATA: "PMD data",
    PMD_DATA_NOTIFY: "ECG notifications",
    PMD_CONTROL_NOTIFY: "PMD indications",
    ECG_START: "ECG startup",
    recovering: "ECG recovery",
    live: "Live ECG",
    disconnecting: "Disconnecting",
    disconnected: "Link lost",
    failed: "Failed",
  };
  const activation = snapshot.userActivationAtRequest === true
    ? "Present"
    : snapshot.userActivationAtRequest === false ? "Missing" : "Not checked";
  const api = snapshot.secureContext && snapshot.apiAvailable
    ? "HTTPS · Web Bluetooth ready"
    : snapshot.secureContext ? "Web Bluetooth API missing" : "Insecure page";
  const pmd = snapshot.firstEcgFrame
    ? `${snapshot.pmdResponse} · ECG frame received`
    : `${snapshot.pmdResponse} · no ECG frame`;
  const stageLabel = stageLabels[snapshot.stage] ?? snapshot.stage ?? "Idle";
  const stage = snapshot.streamSetupAttempt > 0
    ? `${stageLabel} · setup ${snapshot.streamSetupAttempt}/${snapshot.streamSetupAttemptsTotal ?? 2}`
    : stageLabel;
  const values = snapshot.mock ? {
    api: "Synthetic replay · no Bluetooth",
    adapter: "Not used",
    activation: snapshot.userActivationAtRequest === true ? "Explicit start" : "Not started",
    chooser: "Not used",
    stage: snapshot.firstEcgFrame ? "Synthetic ECG live" : "Idle",
    gatt: "0 / 0",
    pmd: snapshot.firstEcgFrame ? "Synthetic 130 Hz fixture active" : "Not started",
    error: "None",
  } : {
    api,
    adapter: snapshot.adapterAvailability === "available"
      ? "Available"
      : snapshot.adapterAvailability === "unavailable" ? "Unavailable / blocked" : "Not checked",
    activation,
    chooser: snapshot.chooser || "Idle",
    stage,
    gatt: `${snapshot.gattAttempt ?? 0} / ${snapshot.gattAttemptsTotal ?? 4}`,
    pmd,
    error: snapshot.lastErrorCode
      ? `${snapshot.lastErrorCode} — ${snapshot.lastErrorMessage}`
      : "None",
  };
  for (const output of elements.polarDiagnosticOutputs) {
    output.value = values[output.dataset.polarDiagnostic] ?? "—";
  }
}

function updateRemoteBroadcastUi(detail = flubberBroadcaster.snapshot()) {
  const broadcasting = detail.phase === "broadcasting";
  const connecting = detail.phase === "connecting";
  const stopping = detail.phase === "stopping";
  const pictureInPictureAvailable = pictureInPictureSupported(window);
  const foregroundWindowActive = Boolean(pictureInPictureWindow && !pictureInPictureWindow.closed);
  const wakeLockAvailable = Boolean(navigator.wakeLock?.request);
  const wakeLockActive = Boolean(broadcastWakeLock && !broadcastWakeLock.released);
  elements.remoteBroadcastButton.disabled = connecting || stopping;
  elements.remoteBroadcastButton.classList.toggle("is-active", broadcasting);
  elements.remoteBroadcastButton.setAttribute("aria-pressed", String(broadcasting));
  elements.remoteBroadcastButton.setAttribute("aria-label", broadcasting
    ? "Stop broadcasting live FLUBBER coordinates"
    : "Broadcast live FLUBBER coordinates");
  updateBroadcastForegroundButton({ busy: connecting || stopping });
  elements.remoteBroadcastDetails.hidden = !detail.streamId;
  elements.remoteBroadcastSource.value = detail.sourceLabel || "—";
  elements.remoteBroadcastListeners.value = String(detail.listenerCount ?? 0);
  const routeParts = [];
  if (detail.forceTurnRequested) routeParts.push("TURN relay-only test requested");
  if (detail.directListeners) routeParts.push(`${detail.directListeners} direct`);
  if (detail.relayedListeners) routeParts.push(`${detail.relayedListeners} relayed`);
  if (Number.isFinite(detail.rttMs)) routeParts.push(`${detail.rttMs} ms RTT`);
  if (detail.sequence) routeParts.push(`sequence ${detail.sequence}`);
  if (detail.droppedBackpressure) routeParts.push(`${detail.droppedBackpressure} backpressure drops`);
  if (foregroundWindowActive) routeParts.push("foreground Flubber window");
  if (wakeLockActive) routeParts.push("wake lock");
  elements.remoteBroadcastRoute.value = routeParts.join(" · ") || (broadcasting ? "Waiting for listeners" : "Waiting");
  const foregroundMessage = broadcasting && !foregroundWindowActive
    ? pictureInPictureAvailable
      ? "LOW-LATENCY FOREGROUND MODE CLOSED — keep this Chrome tab visible or restore it."
      : "Broadcast live — keep this Chrome tab visible; this browser has no floating foreground helper."
    : broadcasting && wakeLockAvailable && !wakeLockActive
      ? "SCREEN WAKE LOCK INACTIVE — restore low-latency foreground mode before a soak."
      : "";
  elements.remoteBroadcastStatus.textContent = foregroundMessage || detail.message
    || (broadcasting
      ? `${detail.sourceLabel} is public and ready.`
      : connecting ? "Connecting to VDO.Ninja signaling…"
        : stopping ? "Stopping remote broadcast…" : "Continuous stream off");
  elements.remoteBroadcastStatus.classList.toggle("is-error", Boolean(detail.error || detail.phase === "error"));
  elements.remoteBroadcastStatus.classList.toggle("is-warning", Boolean(foregroundMessage));
  updateGroundRoleGate();
}

function updateBroadcastForegroundButton({ busy = false } = {}) {
  const continuousSending = flubberBroadcaster.snapshot().phase === "broadcasting"
    || universeLink.snapshot().enabled;
  const pictureInPictureAvailable = pictureInPictureSupported(window);
  const foregroundWindowActive = Boolean(pictureInPictureWindow && !pictureInPictureWindow.closed);
  const wakeLockAvailable = Boolean(navigator.wakeLock?.request);
  const wakeLockActive = Boolean(broadcastWakeLock && !broadcastWakeLock.released);
  const degraded = continuousSending && (!foregroundWindowActive || (wakeLockAvailable && !wakeLockActive));
  elements.remoteBroadcastForegroundButton.hidden = !degraded
    || (!pictureInPictureAvailable && (!wakeLockAvailable || wakeLockActive));
  elements.remoteBroadcastForegroundButton.disabled = busy;
}

function requiredGroundControlName() {
  const name = normalizeGroundControlName(elements.groundControlName.value);
  state.groundControlName = name;
  elements.groundControlName.value = name;
  savePreferences();
  return name;
}

function updateSettingsBroadcastUi(detail = settingsSnapshotBroadcaster.snapshot()) {
  const broadcasting = detail.phase === "broadcasting";
  const busy = detail.phase === "connecting" || detail.phase === "stopping";
  elements.groundJsonBroadcastButton.disabled = busy;
  elements.groundJsonBroadcastButton.classList.toggle("is-active", broadcasting);
  elements.groundJsonBroadcastButton.setAttribute("aria-pressed", String(broadcasting));
  elements.groundJsonBroadcastButton.setAttribute("aria-label", broadcasting
    ? "Stop broadcasting the JSON settings snapshot"
    : "Broadcast a frozen JSON settings snapshot");
  elements.groundJsonBroadcastStatus.textContent = detail.message
    || (broadcasting ? `${detail.sourceLabel} is public.` : busy ? "Changing beacon state…" : "Static beacon off");
  elements.groundJsonBroadcastStatus.classList.toggle("is-error", Boolean(detail.error || detail.phase === "error"));
  elements.groundJsonBroadcastDetails.hidden = !detail.streamId;
  elements.groundJsonSource.value = detail.sourceLabel || "—";
  elements.groundJsonListeners.value = String(detail.listenerCount ?? 0);
  updateGroundRoleGate();
}

function updateLiveReceiveUi(detail = liveRemoteSnapshot()) {
  const enabled = detail.phase !== "idle";
  const scanning = detail.phase === "discovering" || detail.phase === "selecting" || detail.phase === "connecting";
  const owning = liveRemoteOwnsAxes(detail);
  elements.groundLiveScanButton.classList.toggle("is-scanning", scanning);
  elements.groundLiveScanButton.classList.toggle("is-active", owning);
  elements.groundLiveScanButton.setAttribute("aria-pressed", String(enabled));
  elements.groundLiveReceiveStatus.textContent = detail.message
    || (owning
      ? `${detail.sourceLabel} · ${detail.phase === "stale" ? "signal lost, holding X/Y" : "live X/Y connected"}`
      : enabled ? "Radar active; choose a live signal" : "Continuous receiver off");
  elements.groundLiveReceiveStatus.classList.toggle("is-error", detail.phase === "error");
  elements.groundLiveReceiveStatus.classList.toggle("is-warning", detail.phase === "stale");
  updateGroundRoleGate();
}

function groundTransportActive(phase) {
  return phase !== "idle" && phase !== "error";
}

function currentOneWayRole() {
  return oneWayGroundRole({
    jsonBroadcastPhase: settingsSnapshotBroadcaster.snapshot().phase,
    liveBroadcastPhase: flubberBroadcaster.snapshot().phase,
    jsonReceivePhase: settingsSnapshotReceiver.snapshot().phase,
    liveReceivePhase: flubberReceiver.snapshot().phase,
  });
}

function updateGroundRoleGate() {
  const role = currentOneWayRole();
  const jsonSend = groundTransportActive(settingsSnapshotBroadcaster.snapshot().phase);
  const liveSend = groundTransportActive(flubberBroadcaster.snapshot().phase);
  const jsonReceive = groundTransportActive(settingsSnapshotReceiver.snapshot().phase);
  const liveReceive = groundTransportActive(flubberReceiver.snapshot().phase);
  const universeEnabled = universeLink.snapshot().enabled;
  const partyEnabled = flubberParty.snapshot().enabled;
  const collaborationEnabled = universeEnabled || partyEnabled;

  const jsonSendBusy = ["connecting", "stopping"].includes(settingsSnapshotBroadcaster.snapshot().phase);
  const liveSendBusy = ["connecting", "stopping"].includes(flubberBroadcaster.snapshot().phase);
  elements.groundJsonBroadcastButton.disabled = jsonSendBusy
    || (!jsonSend && (role === "receive" || collaborationEnabled));
  elements.remoteBroadcastButton.disabled = liveSendBusy
    || (!liveSend && (role === "receive" || collaborationEnabled));
  elements.groundJsonScanButton.disabled = !jsonReceive
    && (role === "send" || liveReceive || collaborationEnabled);
  elements.groundLiveScanButton.disabled = !liveReceive
    && (role === "send" || jsonReceive || collaborationEnabled);
  elements.groundUniverseButton.disabled = !universeEnabled
    && (role !== "idle" || partyEnabled);
  elements.groundPartyButton.disabled = !partyEnabled
    && (role !== "idle" || universeEnabled);

  const gateMessage = role === "send"
    ? "Stop sending before receiving from this browser."
    : role === "receive" ? "Disconnect receiving before broadcasting from this browser."
      : collaborationEnabled ? "Stop the active collaboration mode before changing ordinary roles." : "";
  for (const button of [
    elements.groundJsonBroadcastButton,
    elements.remoteBroadcastButton,
    elements.groundJsonScanButton,
    elements.groundLiveScanButton,
    elements.groundUniverseButton,
    elements.groundPartyButton,
  ]) {
    button.title = button.disabled ? gateMessage : "";
  }
}

function dismissGroundRadarAfterSuccess(message) {
  if (!groundRadarMode) return;
  groundRadarMode = "";
  groundRadarPendingSourceId = "";
  if (elements.groundRadarDialog.open) elements.groundRadarDialog.close();
  announce(`${message} Radar closed.`);
}

function updateUniverseUi(detail = universeLink.snapshot()) {
  const enabled = detail.enabled;
  const active = detail.phase === "live" || detail.phase === "stale" || detail.phase === "awaiting-reciprocal";
  elements.groundUniverseButton.classList.toggle("is-scanning", enabled && !active);
  elements.groundUniverseButton.classList.toggle("is-active", active);
  elements.groundUniverseButton.setAttribute("aria-pressed", String(enabled));
  const foregroundWindowActive = Boolean(pictureInPictureWindow && !pictureInPictureWindow.closed);
  const wakeLockAvailable = Boolean(navigator.wakeLock?.request);
  const wakeLockActive = Boolean(broadcastWakeLock && !broadcastWakeLock.released);
  const foregroundMessage = enabled && !foregroundWindowActive
    ? pictureInPictureSupported(window)
      ? "LOW-LATENCY FOREGROUND MODE CLOSED — restore it for a stable Universe link."
      : "Universe link live — keep this browser visible for reliable timing."
    : enabled && wakeLockAvailable && !wakeLockActive
      ? "SCREEN WAKE LOCK INACTIVE — restore low-latency foreground mode."
      : "";
  elements.groundUniverseStatus.textContent = [detail.message, foregroundMessage].filter(Boolean).join(" ")
    || "Two-way co-control off";
  elements.groundUniverseStatus.classList.toggle("is-warning", Boolean(foregroundMessage)
    || detail.phase === "stale" || detail.phase === "awaiting-reciprocal");
  elements.groundUniverseStatus.classList.toggle("is-error", detail.phase === "error");
  elements.groundUniverseDetails.hidden = !enabled;
  elements.groundUniversePartner.value = detail.sourceLabel || "Choose a partner";
  elements.groundUniverseListeners.value = String(detail.sending?.listenerCount ?? 0);
  elements.groundUniverseState.value = detail.phase;
  if (groundRadarMode === "universe") {
    elements.groundRadarStatus.textContent = detail.message;
    updateRadarSources();
    if (shouldDismissGroundRadar({ mode: "universe", phase: detail.phase })) {
      dismissGroundRadarAfterSuccess(`Universe synchronized with ${detail.sourceLabel}.`);
    }
  }
  updateBroadcastForegroundButton();
  updateGroundRoleGate();
}

function constrainPartyGuestPosition(view, x, y) {
  const size = view.size ?? 108;
  const margin = size / 2 + 8;
  return {
    x: window.innerWidth <= margin * 2 ? window.innerWidth / 2 : clamp(x, margin, window.innerWidth - margin),
    y: window.innerHeight <= margin * 2 ? window.innerHeight / 2 : clamp(y, margin, window.innerHeight - margin),
  };
}

function movePartyGuest(view, x, y) {
  view.position = constrainPartyGuestPosition(view, x, y);
  view.root.style.setProperty("--party-x", `${view.position.x}px`);
  view.root.style.setProperty("--party-y", `${view.position.y}px`);
}

function normalizedPartyGuestPosition(view) {
  return normalizeFlubberViewportPosition({
    x: view.position?.x,
    y: view.position?.y,
    size: (view.size ?? 108) + 16,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });
}

function reanchorPartyGuestPosition(view, latest) {
  if (!view.position || !Number.isFinite(latest?.viewportX) || !Number.isFinite(latest?.viewportY)) return;
  view.remotePositionSync = {
    senderAnchor: { viewportX: latest.viewportX, viewportY: latest.viewportY },
    localAnchor: normalizedPartyGuestPosition(view),
    lastSequence: latest.positionSequence,
  };
}

function applyPartyGuestRemotePosition(view, latest) {
  if (!view.position || !Number.isFinite(latest?.positionSequence)
    || !Number.isFinite(latest?.viewportX) || !Number.isFinite(latest?.viewportY)) return;
  if (view.root.classList.contains("is-party-budding") || view.drag) return;
  if (!view.remotePositionSync?.senderAnchor || !view.remotePositionSync?.localAnchor) {
    reanchorPartyGuestPosition(view, latest);
    return;
  }
  if (view.remotePositionSync.lastSequence === latest.positionSequence) return;
  const normalized = relativeFlubberViewportPosition({
    sender: latest,
    senderAnchor: view.remotePositionSync.senderAnchor,
    localAnchor: view.remotePositionSync.localAnchor,
  });
  const position = denormalizeFlubberViewportPosition({
    ...normalized,
    size: (view.size ?? 108) + 16,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });
  view.remotePositionSync.lastSequence = latest.positionSequence;
  movePartyGuest(view, position.x, position.y);
}

function beginPartyGuestDrag(event, view) {
  if (event.isPrimary === false || (event.pointerType === "mouse" && event.button !== 0)) return;
  if (!view.position || view.root.classList.contains("is-party-budding")) return;
  event.preventDefault();
  event.stopPropagation();
  view.drag = {
    pointerId: event.pointerId,
    offsetX: event.clientX - view.position.x,
    offsetY: event.clientY - view.position.y,
  };
  view.root.classList.add("is-dragging");
  view.root.focus({ preventScroll: true });
  view.root.setPointerCapture(event.pointerId);
}

function movePartyGuestDrag(event, view) {
  if (view.drag?.pointerId !== event.pointerId) return;
  event.preventDefault();
  movePartyGuest(view, event.clientX - view.drag.offsetX, event.clientY - view.drag.offsetY);
}

function finishPartyGuestDrag(event, view) {
  if (view.drag?.pointerId !== event.pointerId) return;
  view.drag = undefined;
  view.root.classList.remove("is-dragging");
  if (view.root.hasPointerCapture(event.pointerId)) view.root.releasePointerCapture(event.pointerId);
  const guest = flubberParty.snapshot().guests.find((item) => item.streamId === view.root.dataset.streamId);
  reanchorPartyGuestPosition(view, guest?.latest);
  recordEvent("ground-control", "party-guest-position", view.root.dataset.streamId, `${view.position.x.toFixed(1)},${view.position.y.toFixed(1)}`);
}

function movePartyGuestWithKeyboard(event, view) {
  const step = event.shiftKey ? 20 : 10;
  const delta = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  }[event.key];
  if (!delta || !view.position || view.root.classList.contains("is-party-budding")) return;
  event.preventDefault();
  event.stopPropagation();
  movePartyGuest(view, view.position.x + delta[0], view.position.y + delta[1]);
  const guest = flubberParty.snapshot().guests.find((item) => item.streamId === view.root.dataset.streamId);
  reanchorPartyGuestPosition(view, guest?.latest);
  recordEvent("ground-control", "party-guest-position", view.root.dataset.streamId, `${view.position.x.toFixed(1)},${view.position.y.toFixed(1)}`);
}

function createPartyGuestView(streamId, label) {
  const root = document.createElement("div");
  root.className = "party-guest-flubber";
  root.dataset.streamId = streamId;
  root.setAttribute("role", "img");
  root.tabIndex = 0;
  root.hidden = true;
  root.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown ArrowLeft ArrowRight");
  root.setAttribute("aria-label", `Draggable invited ${label}. Waiting for its first coordinate frame.`);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "-1.62 -1.62 3.24 3.24");
  svg.setAttribute("aria-hidden", "true");
  const halo = document.createElementNS(svg.namespaceURI, "path");
  const base = document.createElementNS(svg.namespaceURI, "path");
  const outline = document.createElementNS(svg.namespaceURI, "path");
  halo.setAttribute("class", "shape-halo");
  base.setAttribute("class", "shape-base");
  outline.setAttribute("class", "shape-outline");
  svg.append(halo, base, outline);
  const caption = document.createElement("span");
  caption.textContent = label.replace(/\s*·\s*Live FLUBBER\s*$/i, "");
  root.append(svg, caption);
  elements.partyStage.append(root);
  const view = {
    root,
    paths: [halo, base, outline],
    offsets: createProjectionOffsets(streamId, profiles.waveCount),
    position: undefined,
    size: 108,
    drag: undefined,
    remotePositionSync: undefined,
  };
  partyGuestViews.set(streamId, view);
  root.addEventListener("pointerdown", (event) => beginPartyGuestDrag(event, view));
  root.addEventListener("pointermove", (event) => movePartyGuestDrag(event, view));
  root.addEventListener("pointerup", (event) => finishPartyGuestDrag(event, view));
  root.addEventListener("pointercancel", (event) => finishPartyGuestDrag(event, view));
  root.addEventListener("keydown", (event) => movePartyGuestWithKeyboard(event, view));
  return view;
}

function syncPartyGuestViews(detail = flubberParty.snapshot()) {
  const present = new Set(detail.guests.map((guest) => guest.streamId));
  for (const [streamId, view] of partyGuestViews) {
    if (present.has(streamId)) continue;
    view.root.remove();
    partyGuestViews.delete(streamId);
  }
  for (const guest of detail.guests) {
    if (!partyGuestViews.has(guest.streamId)) createPartyGuestView(guest.streamId, guest.label);
  }
  elements.partyStage.hidden = detail.guests.length === 0;
}

function applyPartyGuestPlacement(view, placement, { resetPosition = false } = {}) {
  view.size = placement.size;
  if (resetPosition || !view.position) {
    view.position = { x: placement.x, y: placement.y };
    view.remotePositionSync = undefined;
  }
  movePartyGuest(view, view.position.x, view.position.y);
  view.root.style.setProperty("--party-size", `${placement.size}px`);
  view.root.style.setProperty("--party-bud-x", `${placement.budX}px`);
  view.root.style.setProperty("--party-bud-y", `${placement.budY}px`);
  view.root.style.setProperty("--party-angle", `${placement.angle}rad`);
}

function createPartyBirthVectorView() {
  if (partyBirthVectorView) return partyBirthVectorView;
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("class", "party-birth-vector");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("hidden", "");
  const definitions = document.createElementNS(namespace, "defs");
  const gradient = document.createElementNS(namespace, "linearGradient");
  gradient.id = "party-cellular-gradient";
  gradient.setAttribute("gradientUnits", "userSpaceOnUse");
  const mainStop = document.createElementNS(namespace, "stop");
  const guestStop = document.createElementNS(namespace, "stop");
  mainStop.setAttribute("offset", "0%");
  guestStop.setAttribute("offset", "100%");
  gradient.append(mainStop, guestStop);
  definitions.append(gradient);
  const halo = document.createElementNS(namespace, "path");
  const surface = document.createElementNS(namespace, "path");
  const outline = document.createElementNS(namespace, "path");
  halo.setAttribute("class", "party-birth-vector-halo");
  surface.setAttribute("class", "party-birth-vector-surface");
  outline.setAttribute("class", "party-birth-vector-outline");
  svg.append(definitions, halo, surface, outline);
  elements.partyStage.prepend(svg);
  partyBirthVectorView = { svg, gradient, mainStop, guestStop, paths: [halo, surface, outline] };
  return partyBirthVectorView;
}

function renderPartyBirthVector(mainRendered) {
  if (!partyBirthAnimation) return;
  const guest = flubberParty.snapshot().guests.find((item) => item.streamId === partyBirthAnimation.guestId);
  if (!guest?.latest) {
    clearPartyBirthAnimation();
    return;
  }
  const progress = clamp((performance.now() - partyBirthAnimation.startedAt) / PARTY_BIRTH_DURATION_MS, 0, 1);
  const topologyProgress = Math.min(
    PARTY_BIRTH_TOPOLOGY_END,
    progress / PARTY_BIRTH_MORPH_START * PARTY_BIRTH_TOPOLOGY_END,
  );
  const geometry = partyBudVectorGeometry({
    progress: topologyProgress,
    originX: partyBirthAnimation.originX,
    originY: partyBirthAnimation.originY,
    centerX: partyBirthAnimation.centerX,
    centerY: partyBirthAnimation.centerY,
    finalX: partyBirthAnimation.finalX,
    finalY: partyBirthAnimation.finalY,
    mainRadius: partyBirthAnimation.mainRadius,
    guestRadius: partyBirthAnimation.guestRadius,
  });
  const vectorView = createPartyBirthVectorView();
  vectorView.svg.removeAttribute("hidden");
  vectorView.svg.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);
  vectorView.gradient.setAttribute("x1", String(geometry.main.x));
  vectorView.gradient.setAttribute("y1", String(geometry.main.y));
  vectorView.gradient.setAttribute("x2", String(geometry.guest.x));
  vectorView.gradient.setAttribute("y2", String(geometry.guest.y));
  vectorView.mainStop.setAttribute("stop-color", mainRendered.color);
  vectorView.guestStop.setAttribute("stop-color", affectPaletteColor(guest.latest.currentX, guest.latest.currentY, state.palette));
  let surfacePath = geometry.surfacePath;
  let morphProgress = 0;
  if (progress >= PARTY_BIRTH_MORPH_START && geometry.contours.length >= 2) {
    morphProgress = clamp((progress - PARTY_BIRTH_MORPH_START) / (1 - PARTY_BIRTH_MORPH_START), 0, 1);
    const liveGuests = flubberParty.snapshot().guests.filter((item) => item.latest
      && (item.phase === "live" || item.phase === "stale"));
    const guestIndex = Math.max(0, liveGuests.findIndex((item) => item.streamId === guest.streamId));
    const guestRendered = buildFlubberPath({
      profiles,
      offsets: partyGuestViews.get(guest.streamId)?.offsets ?? createProjectionOffsets(guest.streamId, profiles.waveCount),
      x: guest.latest.currentX,
      y: guest.latest.currentY,
      phase: state.phase + guestIndex * 0.47,
      palette: state.palette,
      amplitudeScale: state.visual.amplitudeScale,
      disorderScale: state.visual.disorderScale,
      baseShape: state.visual.baseShape,
      reducedMotion: reducedMotionQuery.matches,
    });
    surfacePath = morphPartyBirthContours({
      contours: geometry.contours,
      mainPath: mainRendered.path,
      guestPath: guestRendered.path,
      mainCenter: { x: partyBirthAnimation.centerX, y: partyBirthAnimation.centerY },
      guestCenter: { x: partyBirthAnimation.finalX, y: partyBirthAnimation.finalY },
      mainSize: partyBirthAnimation.mainRadius * 2,
      guestSize: partyBirthAnimation.guestRadius * 2,
      progress: morphProgress,
    }).path || geometry.surfacePath;
  }
  for (const path of vectorView.paths) path.setAttribute("d", surfacePath);
  vectorView.svg.dataset.contours = String(geometry.contourCount);
  vectorView.svg.dataset.morph = morphProgress.toFixed(3);
  if (progress >= 1) clearPartyBirthAnimation();
}

function clearPartyBirthAnimation() {
  partyBirthAnimation = undefined;
  if (partyBirthVectorView) partyBirthVectorView.svg.setAttribute("hidden", "");
  elements.widget.classList.remove("is-party-budding");
  if (partyBirthGuestId) partyGuestViews.get(partyBirthGuestId)?.root.classList.remove("is-party-budding");
  partyBirthGuestId = "";
}

function startPartyBirthAnimation(guest, detail) {
  clearPartyBirthAnimation();
  const view = partyGuestViews.get(guest.streamId) ?? createPartyGuestView(guest.streamId, guest.label);
  const liveGuests = detail.guests.filter((item) => item.latest && (item.phase === "live" || item.phase === "stale"));
  const index = Math.max(0, liveGuests.findIndex((item) => item.streamId === guest.streamId));
  const originX = state.widgetX;
  const originY = state.widgetY;
  state.widgetX = window.innerWidth / 2;
  state.widgetY = window.innerHeight / 2;
  const placement = partyFlubberPlacement({
    index,
    count: liveGuests.length,
    widgetX: state.widgetX,
    widgetY: state.widgetY,
    widgetSize: state.widgetSize,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });
  applyPartyGuestPlacement(view, placement, { resetPosition: true });
  view.root.hidden = false;
  constrainAndRenderWidget();
  if (reducedMotionQuery.matches || elements.widget.hidden) return;
  partyBirthGuestId = guest.streamId;
  partyBirthAnimation = {
    guestId: guest.streamId,
    startedAt: performance.now(),
    originX,
    originY,
    centerX: state.widgetX,
    centerY: state.widgetY,
    finalX: placement.x,
    finalY: placement.y,
    mainRadius: state.widgetSize / 2,
    guestRadius: placement.size / 2,
  };
  elements.widget.classList.add("is-party-budding");
  view.root.classList.add("is-party-budding");
}

function updatePartyUi(detail = flubberParty.snapshot()) {
  const guestCount = detail.guests.length;
  const enabled = detail.enabled;
  elements.groundPartyButton.classList.toggle("is-scanning", enabled && detail.phase !== "idle");
  elements.groundPartyButton.classList.toggle("is-active", guestCount > 0);
  elements.groundPartyButton.setAttribute("aria-pressed", String(enabled));
  elements.groundPartyStatus.textContent = guestCount
    ? `${guestCount} invited FLUBBER${guestCount === 1 ? "" : "s"} sharing the stage`
    : enabled ? "Radar active; invite named FLUBBER signals" : "Party off";
  elements.groundPartyRoster.hidden = guestCount === 0;
  elements.groundPartyGuests.replaceChildren();
  for (const guest of detail.guests) {
    const row = document.createElement("div");
    row.className = "ground-party-guest";
    const label = document.createElement("strong");
    label.textContent = `${guest.label} · ${guest.phase === "stale" ? "holding" : guest.phase}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      if (partyBirthGuestId === guest.streamId) clearPartyBirthAnimation();
      void flubberParty.remove(guest.streamId);
    });
    row.append(label, remove);
    elements.groundPartyGuests.append(row);
  }
  syncPartyGuestViews(detail);
  if (groundRadarMode === "party") {
    updateRadarSources();
    const pendingGuest = detail.guests.find((guest) => guest.streamId === groundRadarPendingSourceId);
    if (pendingGuest && shouldDismissGroundRadar({ mode: "party", phase: pendingGuest.phase })) {
      startPartyBirthAnimation(pendingGuest, detail);
      dismissGroundRadarAfterSuccess(`${pendingGuest.label} joined the FLUBBER party.`);
    }
  }
  updateGroundRoleGate();
}

function updateRadarSources() {
  if (!groundRadarMode) return;
  const snapshot = groundRadarMode === "json"
    ? settingsSnapshotReceiver.snapshot()
    : groundRadarMode === "live" ? liveRemoteSnapshot()
      : groundRadarMode === "universe" ? universeLink.snapshot()
        : flubberParty.snapshot();
  const sources = snapshot.sources ?? [];
  elements.groundRadarSources.replaceChildren();
  if (sources.length === 0) {
    const empty = document.createElement("p");
    empty.className = "ground-radar-empty";
    empty.textContent = groundRadarMode === "json"
      ? "No public JSON settings beacons are visible yet. Radar remains active."
      : groundRadarMode === "universe"
        ? "No other Universe partners are visible yet. Ask the other browser to press Synch with Universe."
        : "No public live FLUBBER streams are visible yet. Radar remains active.";
    elements.groundRadarSources.append(empty);
  } else {
    for (const source of sources) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ground-radar-source";
      button.dataset.streamId = source.streamId;
      const copy = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = groundRadarMode === "json" ? source.name : source.label;
      const meta = document.createElement("small");
      meta.textContent = groundRadarMode === "json"
        ? "Static version-1 settings snapshot"
        : groundRadarMode === "universe" ? "Reciprocal two-person co-control"
          : groundRadarMode === "party" ? "Add as a separate stage companion" : "Continuous X/Y stream";
      copy.append(title, meta);
      const action = document.createElement("span");
      const alreadyInvited = groundRadarMode === "party"
        && flubberParty.snapshot().guests.some((guest) => guest.streamId === source.streamId);
      action.textContent = groundRadarMode === "json"
        ? "Receive"
        : groundRadarMode === "universe" ? "Synchronize"
          : groundRadarMode === "party" ? (alreadyInvited ? "Invited" : "Invite") : "Connect";
      button.disabled = alreadyInvited;
      button.append(copy, action);
      button.addEventListener("click", async () => {
        button.disabled = true;
        groundRadarPendingSourceId = source.streamId;
        if (groundRadarMode === "json") await settingsSnapshotReceiver.selectSource(source.streamId);
        else if (groundRadarMode === "live") await flubberReceiver.selectSource(source.streamId);
        else if (groundRadarMode === "universe") await universeLink.selectSource(source.streamId);
        else if (groundRadarMode === "party") await flubberParty.invite(source.streamId);
      });
      elements.groundRadarSources.append(button);
    }
  }
  if (snapshot.message) elements.groundRadarStatus.textContent = snapshot.message;
}

function updateSettingsRadar(detail = settingsSnapshotReceiver.snapshot()) {
  const scanning = detail.phase !== "idle";
  elements.groundJsonScanButton.classList.toggle("is-scanning", scanning && detail.phase !== "ready");
  elements.groundJsonScanButton.classList.toggle("is-active", detail.phase === "ready");
  elements.groundJsonScanButton.setAttribute("aria-pressed", String(scanning));
  if (groundRadarMode === "json") {
    elements.groundRadarStatus.textContent = detail.message
      || (detail.phase === "ready" ? "Snapshot received. Review it before applying." : "Scanning for public JSON settings beacons…");
    updateRadarSources();
  }
  updateGroundRoleGate();
}

function showReceivedSettings(detail) {
  pendingSettingsSnapshot = detail.received;
  if (!pendingSettingsSnapshot) return;
  elements.groundJsonReceived.hidden = false;
  elements.groundJsonReceivedName.value = pendingSettingsSnapshot.name;
  elements.groundJsonReceivedShape.value = pendingSettingsSnapshot.settings.visual.baseShape;
  elements.groundJsonReceivedTime.value = new Date(pendingSettingsSnapshot.createdAt).toLocaleString();
  elements.groundRadarStatus.textContent = `${pendingSettingsSnapshot.name} passed validation. Apply remains a separate action.`;
  if (shouldDismissGroundRadar({ mode: groundRadarMode, phase: "ready" })) {
    dismissGroundRadarAfterSuccess(`${pendingSettingsSnapshot.name} settings received and ready to apply.`);
  }
}

async function startGroundRadar(mode) {
  groundRadarMode = mode;
  groundRadarPendingSourceId = "";
  pendingSettingsSnapshot = undefined;
  elements.groundJsonReceived.hidden = true;
  elements.groundRadarTitle.textContent = mode === "json"
    ? "Scanning JSON settings beacons"
    : mode === "universe" ? "Synch with Universe"
      : mode === "party" ? "Invite FLUBBERs to the party" : "Scanning live FLUBBER streams";
  elements.groundRadarStatus.textContent = mode === "json"
    ? "Connecting to the public settings discovery room…"
    : mode === "universe" ? "Announcing your local control and scanning for a reciprocal partner…"
      : mode === "party" ? "Scanning for public FLUBBERs you can explicitly invite…"
        : "Connecting to the public live-coordinate discovery room…";
  elements.groundRadarSources.replaceChildren();
  if (!elements.groundRadarDialog.open) elements.groundRadarDialog.showModal();
  try {
    if (mode === "json") {
      await settingsSnapshotReceiver.startDiscovery();
      updateSettingsRadar();
    } else if (mode === "live") {
      await flubberReceiver.startDiscovery();
      updateLiveReceiveUi();
      updateRadarSources();
    } else if (mode === "universe") {
      const sourceName = requiredGroundControlName();
      universeLocalCurrent = { currentX: state.currentX, currentY: state.currentY };
      await acquireBroadcastLatencyMode();
      await universeLink.start({ sourceName });
      updateUniverseUi();
      updateRadarSources();
    } else if (mode === "party") {
      await flubberParty.startDiscovery();
      updatePartyUi();
      updateRadarSources();
    }
  } catch (error) {
    if (mode === "universe") {
      await universeLink.stop();
      await releaseBroadcastLatencyMode();
    }
    elements.groundRadarStatus.textContent = error?.message ?? String(error);
    announce(elements.groundRadarStatus.textContent);
  }
}

async function stopGroundRadar() {
  if (groundRadarMode === "json") await settingsSnapshotReceiver.stop();
  if (groundRadarMode === "live") await flubberReceiver.stop();
  if (groundRadarMode === "universe") {
    await universeLink.stop();
    await releaseBroadcastLatencyMode();
  }
  if (groundRadarMode === "party") {
    clearPartyBirthAnimation();
    await flubberParty.stop();
  }
  groundRadarMode = "";
  groundRadarPendingSourceId = "";
  pendingSettingsSnapshot = undefined;
  elements.groundJsonReceived.hidden = true;
  elements.groundRadarSources.replaceChildren();
  elements.groundRadarStatus.textContent = "Radar stopped.";
  updateSettingsRadar();
  updateLiveReceiveUi();
}

function drawPolarEcg() {
  const canvas = elements.polarEcgCanvas;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#05090b";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "rgba(126, 225, 194, 0.11)";
  context.lineWidth = 1;
  for (let index = 1; index < 4; index += 1) {
    const y = index * canvas.height / 4;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(canvas.width, y);
    context.stroke();
  }
  if (polarEcgWindow.length < 2) {
    context.fillStyle = "#789098";
    context.font = "14px system-ui";
    context.textAlign = "center";
    context.fillText(state.polarConnected ? "Waiting for ECG samples…" : "ECG preview appears after connection", canvas.width / 2, canvas.height / 2);
    return;
  }
  const sorted = [...polarEcgWindow].sort((a, b) => a - b);
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

function applyPolarMappings() {
  let active = false;
  const experimentAllowsDrive = experiment.phase === "idle"
    || (experiment.phase === "running" && experiment.playbackActive);
  for (const axis of ["valence", "arousal"]) {
    const mapping = state.polarMappings[axis];
    const value = mapping.metric === "manual" ? undefined : state.polarMetrics[mapping.metric];
    const normalized = normalizePolarMetric(value, mapping);
    const driven = experimentAllowsDrive
      && !touchTrackingActive()
      && state.polarConnected
      && normalized !== undefined;
    state.polarAxisValues[axis] = {
      value: Number.isFinite(value) ? value : "",
      normalized: driven ? normalized : "",
    };
    if (driven) {
      if (axis === "valence") state.targetX = normalized;
      else state.targetY = normalized;
      active = true;
    }
  }
  state.polarDriveActive = active;
  updatePolarMappingControls();
  updateInputSourceControls();
}

function renderPolarMetrics() {
  for (const card of elements.polarMetricCards.querySelectorAll("[data-polar-metric]")) {
    const metricId = card.dataset.polarMetric;
    card.querySelector(".polar-metric-value").value = formatPolarMetric(metricId, state.polarMetrics[metricId]);
  }
  elements.polarEcgRate.value = `${Math.round(polarObservedSampleRate)} Hz`;
}

function clearPolarLiveReadout() {
  polarBatteryPercent = undefined;
  polarEcgWindow = [];
  polarObservedSampleRate = 130;
  state.polarMetrics = {};
  elements.polarSampleCount.value = "0";
  elements.polarEcgPort.hidden = true;
  renderPolarMetrics();
  drawPolarEcg();
}

function handlePolarEvent(event) {
  if (event.kind === "diagnostic") {
    renderPolarDiagnostics(event.snapshot);
    return;
  }
  if (event.kind === "status") {
    updatePolarConnectionUi(event.message);
    return;
  }
  if (event.kind === "connection") {
    state.polarConnecting = Boolean(event.recovering);
    state.polarConnected = event.connected;
    if (Number.isFinite(event.batteryPercent)) polarBatteryPercent = event.batteryPercent;
    if (!event.connected) {
      clearPolarLiveReadout();
    }
    applyPolarMappings();
    updatePolarConnectionUi(event.message, Boolean(event.error));
    const action = event.recovering ? "recovering" : event.recovered ? "recovered" : event.connected ? "connect" : "disconnect";
    recordEvent("polar-stream", action, "polar-h10", event.batteryPercent ?? "");
    announce(event.message);
    return;
  }
  if (event.kind === "ecg") {
    polarEcgWindow.push(...event.microvolts);
    if (polarEcgWindow.length > 650) polarEcgWindow.splice(0, polarEcgWindow.length - 650);
    polarObservedSampleRate = Number.isFinite(event.streamHealth?.observedSampleRateHz)
      ? event.streamHealth.observedSampleRateHz
      : 130;
    elements.polarSampleCount.value = event.snapshot.totalEcgSamples.toLocaleString();
    elements.polarEcgPort.hidden = false;
    renderPolarMetrics();
    drawPolarEcg();
    return;
  }
  if (event.kind === "metrics") {
    state.polarMetrics = { ...event.snapshot.values };
    renderPolarMetrics();
    applyPolarMappings();
    return;
  }
  if (event.kind === "error") updatePolarConnectionUi(event.message, true);
}

function commitPolarMapping(axis) {
  const metricId = polarAxisField(axis, "metric").value;
  if (metricId === "manual") {
    state.polarMappings[axis] = { ...defaultPolarMappings()[axis] };
  } else {
    const definition = polarMetricDefinition(metricId);
    const minimum = Number(polarAxisField(axis, "minimum").value);
    const maximum = Number(polarAxisField(axis, "maximum").value);
    if (!definition || !Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) {
      updatePolarMappingControls();
      announce("Polar metric bounds require a finite high value greater than the low value.");
      return;
    }
    state.polarMappings[axis] = {
      metric: metricId,
      minimum,
      maximum,
      invert: polarAxisField(axis, "invert").checked,
    };
  }
  state.heldDirections.clear();
  clearHeldButtonStyles();
  applyPolarMappings();
  savePreferences();
  recordEvent("polar-stream", "mapping-change", axis, JSON.stringify(state.polarMappings[axis]));
  announce(`${axis === "valence" ? "Valence" : "Arousal"} Polar assignment updated.`);
}

function togglePolarQuickAssignment(axis, metricId) {
  const definition = polarMetricDefinition(metricId);
  if (!definition) return;
  const alreadyAssigned = state.polarMappings[axis].metric === metricId;
  state.polarMappings[axis] = alreadyAssigned
    ? { ...defaultPolarMappings()[axis] }
    : { metric: metricId, minimum: definition.minimum, maximum: definition.maximum, invert: false };
  state.heldDirections.clear();
  clearHeldButtonStyles();
  applyPolarMappings();
  savePreferences();
  recordEvent("polar-stream", "mapping-change", axis, JSON.stringify(state.polarMappings[axis]));
  const axisLabel = axis === "valence" ? "X / valence" : "Y / arousal";
  announce(alreadyAssigned ? `${definition.label} removed from ${axisLabel}.` : `${definition.label} assigned to ${axisLabel}.`);
}

function initializePolarUi() {
  for (const fieldset of elements.polarAxisFields) {
    const select = fieldset.querySelector("[data-polar-field='metric']");
    select.append(new Option("Manual / unassigned", "manual"));
    for (const definition of POLAR_METRICS) select.append(new Option(`${definition.label} (${definition.unit})`, definition.id));
  }
  for (const definition of POLAR_METRICS) {
    const card = document.createElement("div");
    card.className = "polar-metric-card";
    card.dataset.polarMetric = definition.id;
    const heading = document.createElement("div");
    heading.className = "polar-metric-heading";
    const label = document.createElement("strong");
    label.textContent = definition.shortLabel ?? definition.label;
    label.title = definition.label;
    const group = document.createElement("small");
    group.textContent = definition.group;
    heading.append(label, group);
    const output = document.createElement("output");
    output.className = "polar-metric-value";
    output.value = "—";
    const detail = document.createElement("span");
    detail.className = "polar-metric-detail";
    detail.textContent = definition.detail;
    detail.title = definition.detail;
    const buttons = document.createElement("div");
    buttons.className = "polar-axis-quick-buttons";
    for (const [axis, buttonLabel] of [["valence", "X · Valence"], ["arousal", "Y · Arousal"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.polarQuickAxis = axis;
      button.textContent = buttonLabel;
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-label", `Assign ${definition.label} to ${buttonLabel.replace(" · ", " ")}`);
      button.addEventListener("click", () => togglePolarQuickAssignment(axis, definition.id));
      buttons.append(button);
    }
    card.append(heading, output, detail, buttons);
    elements.polarMetricCards.append(card);
  }
  const support = polarReplay ? {
    supported: true,
    reason: "Deterministic synthetic 130 Hz ECG replay is enabled for bridge qualification. No Bluetooth or real physiology is used.",
  } : polarWebBluetoothSupport();
  elements.polarSupportNote.textContent = support.reason;
  elements.polarSupportNote.classList.toggle("is-unsupported", !support.supported);
  renderPolarDiagnostics();
  if (polarReplay) elements.polarConnectButton.textContent = "Start synthetic replay";
  updatePolarConnectionUi();
  updatePolarMappingControls();
  drawPolarEcg();
}

function updateModeControls() {
  for (const input of elements.modeInputs) input.checked = input.value === state.inputMode;
}

function updateInputSourceControls() {
  const selected = state.inputSource === "touch-trace";
  const active = touchTrackingActive();
  state.touchDriveActive = active;
  elements.touchTrackingToggle.checked = selected;
  for (const input of elements.touchFeedbackModeInputs) input.checked = input.value === state.touchFeedbackMode;
  for (const input of elements.touchHideCursorToggles) {
    input.checked = state.touchHideCursor;
    input.disabled = !selected;
  }
  elements.touchTraceFeedbackToggle.checked = state.touchTraceFeedback;
  elements.touchTraceFeedbackToggle.disabled = !selected;
  elements.touchPlaygroundSurface.classList.toggle("is-active", active);
  elements.touchPlaygroundPanel.classList.toggle("is-tracking", active);
  elements.touchTracePanel.hidden = !(active && state.touchTraceFeedback && state.widgetVisible);
  elements.featureSpace.setAttribute("aria-disabled", "false");
  for (const button of elements.directionButtons) button.disabled = false;
  document.body.classList.toggle("is-touch-source", active);
  document.body.classList.toggle("is-touch-cursor-hidden", active && state.touchHideCursor);
  elements.experimentLayer.classList.toggle("is-touch-capture-active", active && experiment.phase !== "idle");
  elements.dragToggleButton.disabled = active || experiment.phase !== "idle";
  positionTracePanel();
}

function finishBindingCapture(value) {
  if (!captureInput) return;
  const { action, group, trigger } = captureInput;
  const updates = bindingUpdatesForCapture(action, value);
  const updatedActions = new Set(Object.keys(updates));
  const updatedValues = new Set(Object.values(updates).map((binding) => binding.toLowerCase()));
  const assignments = { ...state.bindings, ...state.advancedBindings };
  const conflict = Object.entries(assignments).find(
    ([candidate, binding]) => !updatedActions.has(candidate) && updatedValues.has(binding.toLowerCase()),
  );
  if (conflict) {
    cancelBindingCapture();
    announce(`That input is already assigned to ${BINDING_LABELS[conflict[0]] ?? ADVANCED_BINDING_LABELS[conflict[0]]}.`);
    return;
  }

  for (const [updatedAction, binding] of Object.entries(updates)) {
    const updatedGroup = updatedAction in state.bindings ? "bindings" : group;
    state[updatedGroup][updatedAction] = binding;
  }
  trigger.classList.remove("is-capturing");
  captureInput = undefined;
  if (elements.bindingCaptureDialog.open) elements.bindingCaptureDialog.close();
  createBindingInputs();
  savePreferences();
  for (const [updatedAction, binding] of Object.entries(updates)) {
    recordEvent("settings", "binding-change", updatedAction, binding);
  }
  if (Object.keys(updates).length > 1) {
    const oppositeAction = Object.keys(updates).find((candidate) => candidate !== action);
    announce(`${describeBinding(value)} assigned to ${BINDING_LABELS[action]}; ${describeBinding(updates[oppositeAction])} assigned to ${BINDING_LABELS[oppositeAction]}.`);
  } else {
    announce(`${describeBinding(value)} assigned to ${BINDING_LABELS[action] ?? ADVANCED_BINDING_LABELS[action]}.`);
  }
}

function cancelBindingCapture() {
  if (!captureInput) return;
  captureInput.trigger.classList.remove("is-capturing");
  captureInput = undefined;
  if (elements.bindingCaptureDialog.open) elements.bindingCaptureDialog.close();
}

function beginBindingCapture(action, group, trigger) {
  cancelBindingCapture();
  captureInput = { action, group, trigger };
  trigger.classList.add("is-capturing");
  elements.bindingCaptureTitle.textContent = BINDING_LABELS[action] ?? ADVANCED_BINDING_LABELS[action];
  elements.bindingCaptureCurrent.value = describeBinding(
    group === "advancedBindings" ? state.advancedBindings[action] ?? "Unassigned" : state.bindings[action],
  );
  elements.bindingCapturePairNote.hidden = !(action in DIRECTION_BY_ACTION);
  elements.bindingCaptureDialog.showModal();
  announce("Waiting for a keyboard, mouse-button, or wheel input.");
}

function createBindingButton(action, label, group) {
  const button = document.createElement("button");
  const value = group === "advancedBindings" ? state.advancedBindings[action] ?? "" : state.bindings[action];
  button.type = "button";
  button.className = "binding-assignment-button";
  button.dataset.binding = action;
  const name = document.createElement("span");
  name.textContent = label;
  const assignment = document.createElement("output");
  assignment.textContent = value ? describeBinding(value) : "Unassigned";
  button.setAttribute("aria-label", `Assign ${label}. Current input: ${assignment.textContent}.`);
  button.append(name, assignment);
  button.addEventListener("click", () => beginBindingCapture(action, group, button));
  return button;
}

function describeDirectionBinding(value) {
  const [kind, control = ""] = value.split(":");
  if (kind === "key") {
    const compactKey = {
      ArrowUp: "↑",
      ArrowDown: "↓",
      ArrowLeft: "←",
      ArrowRight: "→",
    }[control] ?? control.replace(/^Key/, "");
    return `Key · ${compactKey}`;
  }
  if (kind === "mouse") return `Mouse · ${control}`;
  if (kind === "wheel") return `Wheel · ${control}`;
  return describeBinding(value);
}

function createBindingInputs() {
  for (const button of elements.directionButtons) {
    const action = button.dataset.binding;
    const assignment = button.querySelector("[data-binding-value]");
    assignment.value = describeDirectionBinding(state.bindings[action]);
    button.setAttribute("aria-label", `Assign ${BINDING_LABELS[action]}. Current input: ${describeBinding(state.bindings[action])}.`);
  }

  elements.bindingGrid.replaceChildren();
  for (const [action, label] of Object.entries(BINDING_LABELS)) {
    if (action in DIRECTION_BY_ACTION) continue;
    elements.bindingGrid.append(createBindingButton(action, label, "bindings"));
  }

  elements.advancedBindingGrid.replaceChildren();
  for (const [action, label] of Object.entries(ADVANCED_BINDING_LABELS)) {
    const row = document.createElement("div");
    row.className = "advanced-binding-field";
    const assignment = createBindingButton(action, label, "advancedBindings");
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear";
    clear.disabled = !state.advancedBindings[action];
    clear.addEventListener("click", () => {
      delete state.advancedBindings[action];
      savePreferences();
      createBindingInputs();
      recordEvent("settings", "advanced-binding-clear", action, "");
      announce(`${label} assignment cleared.`);
    });
    row.append(assignment, clear);
    elements.advancedBindingGrid.append(row);
  }
}

function updateCustomizationControls() {
  elements.stepSize.value = state.stepSize;
  elements.continuousSpeed.value = state.continuousSpeed;
  elements.response.value = state.response;
  elements.animationSpeed.value = state.visual.animationSpeed;
  elements.amplitudeScale.value = state.visual.amplitudeScale;
  elements.disorderScale.value = state.visual.disorderScale;
  for (const button of elements.baseShapeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.baseShape === state.visual.baseShape));
  }
  elements.widgetSize.value = state.widgetSize;
  elements.transparency.value = opacityToTransparencyPercent(state.widgetOpacity);
  elements.transparencyOutput.value = `${elements.transparency.value}%`;
  elements.widgetVisibleButton.textContent = state.widgetVisible ? "Hide flubber" : "Show flubber";
  elements.dragToggleButton.textContent = state.widgetDragEnabled ? "Disable dragging" : "Enable dragging";
  elements.dragToggleButton.disabled = touchTrackingActive() || experiment.phase !== "idle";
  elements.lslStreamName.value = state.lsl.streamName;
  elements.lslStreamType.value = state.lsl.streamType;
  elements.lslMarkerName.value = state.lsl.markerName;
  elements.lslSampleRate.value = state.lsl.sampleRate;
  elements.lslSourceId.value = state.lsl.sourceId;
  createBindingInputs();
  updateInputSourceControls();
}

function applyPortableSettings(value, applyPosition = true) {
  const normalized = normalizePortableSettings(value);
  state.inputMode = normalized.inputMode;
  state.stepSize = normalized.stepSize;
  state.continuousSpeed = normalized.continuousSpeed;
  state.response = normalized.response;
  state.bindings = normalized.bindings;
  state.advancedBindings = normalized.advancedBindings;
  state.visual = normalized.visual;
  state.palette = normalized.palette;
  state.widgetSize = normalized.overlay.size;
  state.widgetOpacity = normalized.overlay.opacity;
  state.widgetVisible = normalized.overlay.visible;
  state.lsl = normalized.lsl;
  if (applyPosition) {
    state.widgetX = normalized.overlay.x + normalized.overlay.size / 2;
    state.widgetY = normalized.overlay.y + normalized.overlay.size / 2;
  }
  state.heldDirections.clear();
  updateModeControls();
  updateCustomizationControls();
  updateFeatureSpace();
  constrainAndRenderWidget();
  savePreferences();
  return normalized;
}

function formatCoordinate(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function updateCoordinateDisplay() {
  elements.valenceOutput.textContent = formatCoordinate(state.currentX);
  elements.arousalOutput.textContent = formatCoordinate(state.currentY);
  elements.widget.setAttribute(
    "aria-label",
    `${touchTrackingActive() ? "Experimental movement-responsive" : "Draggable"} affect shape. Valence ${state.currentX.toFixed(2)}, arousal ${state.currentY.toFixed(2)}.`,
  );
}

function renderPaletteCanvas(canvas, paletteKey) {
  if (canvas.dataset.palette !== paletteKey) {
    const context = canvas.getContext("2d");
    const image = context.createImageData(canvas.width, canvas.height);
    for (let py = 0; py < canvas.height; py += 1) {
      for (let px = 0; px < canvas.width; px += 1) {
        const color = affectPaletteColor(px / (canvas.width - 1) * 2 - 1, 1 - py / (canvas.height - 1) * 2, state.palette);
        const [red, green, blue] = color.match(/\d+/g).map(Number);
        const offset = (py * canvas.width + px) * 4;
        image.data.set([red, green, blue, 255], offset);
      }
    }
    context.putImageData(image, 0, 0);
    canvas.dataset.palette = paletteKey;
  }
}

function coordinateToFeaturePercent(value, insetPercent) {
  return insetPercent + (clamp(value, -1, 1) + 1) * 0.5 * (100 - insetPercent * 2);
}

function updateFeatureSpace() {
  for (const [name, color] of Object.entries(state.palette)) elements.featureSpace.style.setProperty(`--palette-${name}`, color);
  const paletteKey = JSON.stringify(state.palette);
  renderPaletteCanvas(elements.featureCanvas, paletteKey);
  renderPaletteCanvas(elements.touchAffectCanvas, paletteKey);
  renderPaletteCanvas(elements.mobileCoordinateCanvas, paletteKey);
  elements.featurePoint.style.left = `${coordinateToFeaturePercent(state.currentX, FEATURE_FLUBBER_INSET_PERCENT)}%`;
  elements.featurePoint.style.top = `${coordinateToFeaturePercent(-state.currentY, FEATURE_FLUBBER_INSET_PERCENT)}%`;
  elements.touchAffectPoint.style.left = `${coordinateToFeaturePercent(state.currentX, FEATURE_DOT_INSET_PERCENT)}%`;
  elements.touchAffectPoint.style.top = `${coordinateToFeaturePercent(-state.currentY, FEATURE_DOT_INSET_PERCENT)}%`;
  elements.mobileCoordinatePoint.style.left = `${coordinateToFeaturePercent(state.currentX, 0)}%`;
  elements.mobileCoordinatePoint.style.top = `${coordinateToFeaturePercent(-state.currentY, 0)}%`;
  const currentColor = affectPaletteColor(state.currentX, state.currentY, state.palette);
  elements.featurePoint.style.setProperty("--preview-color", currentColor);
  elements.touchAffectPoint.style.background = currentColor;
  elements.mobileCoordinatePoint.style.setProperty("--point-color", currentColor);
  elements.featureValenceOutput.value = formatCoordinate(state.currentX);
  elements.featureArousalOutput.value = formatCoordinate(state.currentY);
  elements.touchAffectValenceOutput.value = formatCoordinate(state.currentX);
  elements.touchAffectArousalOutput.value = formatCoordinate(state.currentY);
  elements.mobileDirectValenceOutput.value = formatCoordinate(state.currentX);
  elements.mobileDirectArousalOutput.value = formatCoordinate(state.currentY);
  elements.touchAffectSpace.setAttribute(
    "aria-label",
    `Experimental movement mapping. Valence ${state.currentX.toFixed(2)}, arousal ${state.currentY.toFixed(2)}.`,
  );
  for (const input of elements.paletteInputs) input.value = state.palette[input.dataset.palette];
  elements.featureSpace.setAttribute("aria-valuetext", `Valence ${state.targetX.toFixed(2)}, arousal ${state.targetY.toFixed(2)}`);
  elements.mobileCoordinateSpace.setAttribute(
    "aria-valuetext",
    `Valence ${state.targetX.toFixed(2)}, arousal ${state.targetY.toFixed(2)}`,
  );
}

function claimFeatureSpaceControl() {
  if (liveRemoteOwnsAxes()) {
    announce("Disconnect incoming live FLUBBER in Ground Control before choosing a local grid point.");
    return false;
  }
  const releasedAxes = [];
  for (const axis of ["valence", "arousal"]) {
    if (state.polarMappings[axis].metric === "manual") continue;
    state.polarMappings[axis] = { ...defaultPolarMappings()[axis] };
    releasedAxes.push(axis);
  }
  if (releasedAxes.length === 0) return true;
  applyPolarMappings();
  savePreferences();
  for (const axis of releasedAxes) {
    recordEvent("feature-space", "mapping-change", axis, JSON.stringify(state.polarMappings[axis]));
  }
  announce("The 2D grid returned valence and arousal to manual control.");
  return true;
}

function chooseFeatureCoordinate(event) {
  const bounds = elements.featureSpace.getBoundingClientRect();
  state.targetX = clamp(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -1, 1);
  state.targetY = clamp(1 - ((event.clientY - bounds.top) / bounds.height) * 2, -1, 1);
  state.currentX = state.targetX;
  state.currentY = state.targetY;
  updateCoordinateDisplay();
  updateFeatureSpace();
}

function chooseMobileCoordinate(event) {
  const coordinate = clientPointToAffectCoordinate({
    clientX: event.clientX,
    clientY: event.clientY,
    bounds: elements.mobileCoordinateSpace.getBoundingClientRect(),
  });
  if (!coordinate) return;
  state.targetX = coordinate.x;
  state.targetY = coordinate.y;
  state.currentX = state.targetX;
  state.currentY = state.targetY;
  updateCoordinateDisplay();
  updateFeatureSpace();
}

function chooseMobileFlubberPosition(event) {
  const areaBounds = elements.mobileFlubberDragArea.getBoundingClientRect();
  const flubberBounds = elements.mobileDirectFlubber.getBoundingClientRect();
  const size = Math.min(flubberBounds.width, flubberBounds.height);
  if (!areaBounds.width || !areaBounds.height || !size) return;
  const normalized = normalizeFlubberViewportPosition({
    x: event.clientX - areaBounds.left - mobileFlubberDragOffsetX,
    y: event.clientY - areaBounds.top - mobileFlubberDragOffsetY,
    size,
    viewportWidth: areaBounds.width,
    viewportHeight: areaBounds.height,
  });
  setWidgetFromNormalizedPosition(normalized);
}

function tracePanelDimensions() {
  const width = Math.min(Math.max(220, state.widgetSize * 1.35), 360, Math.max(1, window.innerWidth - 32));
  return { width, height: width / 2 + 30 };
}

function positionTracePanel() {
  if (elements.touchTracePanel.hidden) return;
  if (experiment.phase !== "idle" && experiment.traceRect) {
    Object.assign(elements.touchTracePanel.style, {
      left: `${experiment.traceRect.left}px`,
      top: `${experiment.traceRect.top}px`,
      width: `${experiment.traceRect.width}px`,
    });
    return;
  }
  const dimensions = tracePanelDimensions();
  const left = clamp(state.widgetX - dimensions.width / 2, 16, Math.max(16, window.innerWidth - dimensions.width - 16));
  const top = state.widgetY + state.widgetSize / 2 + 12;
  Object.assign(elements.touchTracePanel.style, {
    left: `${left}px`,
    top: `${top}px`,
    width: `${dimensions.width}px`,
  });
}

function drawTouchTraceCanvas(canvas, snapshot, timestamp) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const pixelWidth = Math.max(1, Math.round(rect.width * ratio));
  const pixelHeight = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  const points = fitTracePoints(snapshot.tracePoints, rect.width, rect.height);
  context.lineCap = "butt";
  context.lineJoin = "miter";
  context.miterLimit = 8;
  context.lineWidth = 1.75;
  for (let index = 1; index < points.length; index += 1) {
    const before = points[index - 1];
    const current = points[index];
    if (before.strokeId !== current.strokeId) continue;
    const age = clamp((timestamp - current.time) / TRACE_DURATION_MS, 0, 1);
    const hue = reducedMotionQuery.matches
      ? index / Math.max(1, points.length - 1) * 300
      : ((1 - age) * 300 + timestamp * 0.02) % 360;
    context.strokeStyle = `hsl(${hue} 90% 64% / ${Math.max(0.08, 1 - age)})`;
    context.beginPath();
    context.moveTo(before.x, before.y);
    context.lineTo(current.x, current.y);
    context.stroke();
  }
}

function renderTouchTrace(timestamp) {
  const snapshot = touchTrace.snapshot();
  const pointerType = snapshot.pointerType === "unknown" ? "waiting" : snapshot.pointerType;
  const gated = state.touchFeedbackMode === TOUCH_FEEDBACK_GATED;
  const feedbackVisible = gated
    ? snapshot.gateOpen || snapshot.gateCommitSequence > 0
    : snapshot.motionActive || snapshot.feedbackHeld;
  const heldSuffix = gated && !snapshot.gateOpen && snapshot.gateCommitSequence > 0
    ? " · held"
    : !snapshot.motionActive && snapshot.feedbackHeld ? " · held" : "";
  const shapeLabel = feedbackVisible
    ? `${snapshot.mappedX < -0.15 ? "angular/random" : snapshot.mappedX > 0.15 ? "circular" : "neutral"}${heldSuffix}`
    : "inactive";
  const speedCommand = snapshot.mappedY < -0.15
    ? "slow → lower arousal"
    : snapshot.mappedY > 0.15
      ? "fast → higher arousal"
      : "mid → hold arousal";
  const speedLabel = feedbackVisible
    ? `${speedCommand} · ${snapshot.filteredSpeed.toFixed(2)} D/s${heldSuffix}`
    : "still";
  const confidenceLabel = `${Math.round((snapshot.speedConfidence + snapshot.shapeConfidence) * 50)}%`;

  elements.touchPointerType.value = pointerType;
  elements.touchShapeOutput.value = shapeLabel;
  elements.touchSpeedOutput.value = speedLabel;
  elements.touchConfidenceOutput.value = confidenceLabel;
  elements.playgroundShapeOutput.value = shapeLabel;
  elements.playgroundSpeedOutput.value = speedLabel;
  elements.playgroundConfidenceOutput.value = confidenceLabel;
  elements.touchGateStatus.value = !touchTrackingActive()
    ? "tracking off"
    : !gated
      ? "continuous response"
      : snapshot.gateOpen
        ? snapshot.gateLiveActive
          ? `live ΔV ${snapshot.gateLiveDeltaX >= 0 ? "+" : ""}${snapshot.gateLiveDeltaX.toFixed(2)}, ΔA ${snapshot.gateLiveDeltaY >= 0 ? "+" : ""}${snapshot.gateLiveDeltaY.toFixed(2)} · keep moving`
          : `measuring swipe ${snapshot.gateId}…`
        : snapshot.gateCommitSequence > 0
          ? `held · last movement ΔV ${snapshot.gateDeltaX >= 0 ? "+" : ""}${snapshot.gateDeltaX.toFixed(2)}, ΔA ${snapshot.gateDeltaY >= 0 ? "+" : ""}${snapshot.gateDeltaY.toFixed(2)}`
          : "ready for an occasional swipe";

  if (state.touchPlaygroundPanelOpen) {
    drawTouchTraceCanvas(elements.touchPlaygroundCanvas, snapshot, timestamp);
  }
  if (!elements.touchTracePanel.hidden) {
    positionTracePanel();
    drawTouchTraceCanvas(elements.touchTraceCanvas, snapshot, timestamp);
  }
}

function layoutExperiment() {
  if (experiment.phase === "idle") return;
  const traceSize = touchTrackingActive() && state.touchTraceFeedback && state.widgetVisible ? tracePanelDimensions() : undefined;
  const layout = computeExperimentLayout(window.innerWidth, window.innerHeight, state.widgetSize, 24, traceSize);
  const { left, top, width, height } = layout.videoRect;
  Object.assign(elements.experimentPlayerShell.style, {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
  });
  state.widgetX = layout.widget.x;
  state.widgetY = layout.widget.y;
  experiment.displayWidgetSize = layout.widgetSize;
  experiment.traceRect = layout.traceRect;
}

function constrainAndRenderWidget() {
  layoutExperiment();
  const renderedWidgetSize = experiment.phase === "idle"
    ? state.widgetSize
    : (experiment.displayWidgetSize ?? state.widgetSize);
  const constrained = constrainWidgetPosition(
    state.widgetX,
    state.widgetY,
    renderedWidgetSize,
    window.innerWidth,
    window.innerHeight,
  );
  state.widgetX = constrained.x;
  state.widgetY = constrained.y;
  if (experiment.phase === "idle" && touchTrackingActive() && state.touchTraceFeedback) {
    const trace = tracePanelDimensions();
    const maximumY = window.innerHeight - trace.height - 12 - state.widgetSize / 2;
    state.widgetY = clamp(state.widgetY, state.widgetSize / 2, Math.max(state.widgetSize / 2, maximumY));
  }
  elements.widget.style.left = `${state.widgetX}px`;
  elements.widget.style.top = `${state.widgetY}px`;
  elements.widget.style.setProperty("--widget-size", `${renderedWidgetSize}px`);
  elements.widget.style.opacity = String(state.widgetOpacity);
  elements.widget.hidden = !state.widgetVisible || Boolean(pictureInPictureWindow);
  elements.widget.classList.toggle("is-drag-disabled", !state.widgetDragEnabled || touchTrackingActive());
  positionTracePanel();
  if (pictureInPictureView) {
    pictureInPictureView.root.hidden = !state.widgetVisible;
    pictureInPictureView.root.style.opacity = String(state.widgetOpacity);
  }
  renderMobileFlubberPosition();
}

function normalizedWidgetPosition() {
  return normalizeFlubberViewportPosition({
    x: state.widgetX,
    y: state.widgetY,
    size: state.widgetSize,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });
}

function setWidgetFromNormalizedPosition(position) {
  const point = denormalizeFlubberViewportPosition({
    ...position,
    size: state.widgetSize,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });
  state.widgetX = point.x;
  state.widgetY = point.y;
  constrainAndRenderWidget();
}

function renderMobileFlubberPosition() {
  const areaBounds = elements.mobileFlubberDragArea?.getBoundingClientRect();
  const flubberBounds = elements.mobileDirectFlubber?.getBoundingClientRect();
  if (!areaBounds?.width || !areaBounds?.height || !flubberBounds?.width || !flubberBounds?.height) return;
  const normalized = normalizedWidgetPosition();
  const local = denormalizeFlubberViewportPosition({
    ...normalized,
    size: Math.min(flubberBounds.width, flubberBounds.height),
    viewportWidth: areaBounds.width,
    viewportHeight: areaBounds.height,
  });
  elements.mobileDirectFlubber.style.left = `${local.x}px`;
  elements.mobileDirectFlubber.style.top = `${local.y}px`;
}

function resetLiveRemotePositionSync() {
  liveRemotePositionSync.streamId = "";
  liveRemotePositionSync.senderAnchor = undefined;
  liveRemotePositionSync.localAnchor = undefined;
  liveRemotePositionSync.lastSequence = undefined;
}

function reanchorLiveRemotePosition(snapshot = liveRemoteSnapshot()) {
  const latest = snapshot.latest;
  if (!latest || !Number.isFinite(latest.viewportX) || !Number.isFinite(latest.viewportY)) {
    resetLiveRemotePositionSync();
    return;
  }
  liveRemotePositionSync.streamId = snapshot.selectedStreamId;
  liveRemotePositionSync.senderAnchor = { viewportX: latest.viewportX, viewportY: latest.viewportY };
  liveRemotePositionSync.localAnchor = normalizedWidgetPosition();
  liveRemotePositionSync.lastSequence = latest.positionSequence;
}

function applyLiveRemoteViewportPosition(snapshot = liveRemoteSnapshot()) {
  const latest = snapshot.latest;
  if (!snapshot.selectedStreamId || !latest
    || !Number.isFinite(latest.positionSequence)
    || !Number.isFinite(latest.viewportX)
    || !Number.isFinite(latest.viewportY)) {
    if (!snapshot.selectedStreamId) resetLiveRemotePositionSync();
    return;
  }
  if (liveRemotePositionSync.streamId !== snapshot.selectedStreamId
    || !liveRemotePositionSync.senderAnchor || !liveRemotePositionSync.localAnchor) {
    reanchorLiveRemotePosition(snapshot);
    return;
  }
  if (liveRemotePositionSync.lastSequence === latest.positionSequence) return;
  if (state.dragging || mobileFlubberPointerId !== undefined || experiment.phase !== "idle") return;
  const position = relativeFlubberViewportPosition({
    sender: latest,
    senderAnchor: liveRemotePositionSync.senderAnchor,
    localAnchor: liveRemotePositionSync.localAnchor,
  });
  liveRemotePositionSync.lastSequence = latest.positionSequence;
  setWidgetFromNormalizedPosition(position);
}

function renderPictureInPicture(rendered) {
  if (!pictureInPictureView) return;
  for (const path of pictureInPictureView.paths) path.setAttribute("d", rendered.path);
  pictureInPictureView.root.style.setProperty("--affect-color", rendered.color);
  pictureInPictureView.root.style.opacity = String(state.widgetOpacity);
  pictureInPictureView.root.hidden = !state.widgetVisible;
  pictureInPictureView.root.setAttribute(
    "aria-label",
    `Floating affect shape. Valence ${state.currentX.toFixed(2)}, arousal ${state.currentY.toFixed(2)}.`,
  );
}

function renderPartyFlubbers() {
  const guests = flubberParty.snapshot().guests.filter((guest) => guest.latest
    && (guest.phase === "live" || guest.phase === "stale"));
  for (let index = 0; index < guests.length; index += 1) {
    const guest = guests[index];
    const view = partyGuestViews.get(guest.streamId) ?? createPartyGuestView(guest.streamId, guest.label);
    const placement = partyFlubberPlacement({
      index,
      count: guests.length,
      widgetX: state.widgetX,
      widgetY: state.widgetY,
      widgetSize: state.widgetSize,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    const rendered = buildFlubberPath({
      profiles,
      offsets: view.offsets,
      x: guest.latest.currentX,
      y: guest.latest.currentY,
      phase: state.phase + index * 0.47,
      palette: state.palette,
      amplitudeScale: state.visual.amplitudeScale,
      disorderScale: state.visual.disorderScale,
      baseShape: state.visual.baseShape,
      reducedMotion: reducedMotionQuery.matches,
    });
    for (const path of view.paths) path.setAttribute("d", rendered.path);
    view.root.hidden = false;
    applyPartyGuestPlacement(view, placement);
    applyPartyGuestRemotePosition(view, guest.latest);
    view.root.style.setProperty("--party-color", rendered.color);
    view.root.setAttribute("aria-label", `Draggable invited ${guest.label}. Valence ${guest.latest.currentX.toFixed(2)}, arousal ${guest.latest.currentY.toFixed(2)}${guest.phase === "stale" ? ", signal stale and holding" : ""}. Drag independently or use arrow keys to move this Flubber on screen.`);
  }
  const liveIds = new Set(guests.map((guest) => guest.streamId));
  for (const [streamId, view] of partyGuestViews) view.root.hidden = !liveIds.has(streamId);
}

function finishPictureInPicture(childWindow) {
  if (pictureInPictureWindow !== childWindow) return;
  broadcastOwnsPictureInPicture = false;
  pictureInPictureWindow = undefined;
  pictureInPictureView = undefined;
  if (animationFrameOwner === childWindow) {
    childWindow.cancelAnimationFrame(animationFrameId);
    animationFrameOwner = undefined;
    animationFrameId = undefined;
    scheduleAnimationFrame();
  }
  elements.pictureInPictureToggle.checked = false;
  state.heldDirections.clear();
  clearHeldButtonStyles();
  constrainAndRenderWidget();
  recordEvent("picture-in-picture", "close", "flubber", false);
  const broadcasting = flubberBroadcaster.snapshot().phase === "broadcasting";
  const universeSending = universeLink.snapshot().enabled;
  if (broadcasting || universeSending) {
    recordEvent("remote-flubber", "remote-foreground-lost", "floating-flubber", 0);
    updateRemoteBroadcastUi();
    updateUniverseUi();
    announce("Low-latency foreground mode closed. Keep this Chrome tab visible or restore foreground mode.");
  } else {
    announce("Floating Flubber closed and restored to the page.");
  }
}

function scheduleAnimationFrame() {
  const owner = pictureInPictureWindow && !pictureInPictureWindow.closed ? pictureInPictureWindow : window;
  animationFrameOwner = owner;
  animationFrameId = owner.requestAnimationFrame(animationFrame);
}

async function openPictureInPicture() {
  if (!pictureInPictureSupported(window)) {
    elements.pictureInPictureToggle.checked = false;
    announce("This browser does not support interactive Picture-in-Picture.");
    return;
  }
  if (pictureInPictureWindow && !pictureInPictureWindow.closed) return;

  try {
    const childWindow = await window.documentPictureInPicture.requestWindow(pictureInPictureOptions(state.widgetSize));
    pictureInPictureWindow = childWindow;
    const childDocument = childWindow.document;
    childDocument.title = "Affect Tracker Flubber";
    const stylesheet = childDocument.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("./styles.css", document.baseURI).href;
    childDocument.head.append(stylesheet);
    childDocument.body.className = "pip-body";

    const root = childDocument.createElement("main");
    root.className = "pip-widget";
    root.tabIndex = 0;
    root.setAttribute("role", "img");
    const svg = elements.widget.querySelector("svg").cloneNode(true);
    svg.removeAttribute("aria-hidden");
    root.append(svg);
    childDocument.body.replaceChildren(root);
    pictureInPictureView = {
      root,
      paths: [root.querySelector("#base-path"), root.querySelector("#outline-path"), root.querySelector("#halo-path")],
    };

    childWindow.addEventListener("keydown", handleGlobalKeyDown);
    childWindow.addEventListener("keyup", handleGlobalKeyUp);
    childWindow.addEventListener("wheel", handleWheel, { passive: false });
    childWindow.addEventListener("blur", () => state.heldDirections.clear());
    childWindow.addEventListener("pagehide", () => finishPictureInPicture(childWindow), { once: true });
    elements.pictureInPictureToggle.checked = true;
    constrainAndRenderWidget();
    recordEvent("picture-in-picture", "open", "flubber", true);
    announce("Flubber is floating over other applications. Keep this page open.");
    return true;
  } catch (error) {
    elements.pictureInPictureToggle.checked = false;
    pictureInPictureWindow = undefined;
    pictureInPictureView = undefined;
    constrainAndRenderWidget();
    announce(error?.name === "NotAllowedError"
      ? "The browser blocked Picture-in-Picture. Try the checkbox again."
      : `Picture-in-Picture could not open: ${error?.message ?? String(error)}`);
    return false;
  }
}

async function acquireBroadcastWakeLock() {
  if (!navigator.wakeLock?.request || document.visibilityState !== "visible") return false;
  if (broadcastWakeLock && !broadcastWakeLock.released) return true;
  try {
    const wakeLock = await navigator.wakeLock.request("screen");
    broadcastWakeLock = wakeLock;
    wakeLock.addEventListener("release", () => {
      if (broadcastWakeLock === wakeLock) broadcastWakeLock = undefined;
      updateRemoteBroadcastUi();
      updateUniverseUi();
    }, { once: true });
    updateRemoteBroadcastUi();
    updateUniverseUi();
    return true;
  } catch {
    broadcastWakeLock = undefined;
    updateRemoteBroadcastUi();
    updateUniverseUi();
    return false;
  }
}

async function releaseBroadcastLatencyMode() {
  const wakeLock = broadcastWakeLock;
  broadcastWakeLock = undefined;
  if (wakeLock && !wakeLock.released) await wakeLock.release().catch(() => {});
  if (broadcastOwnsPictureInPicture && pictureInPictureWindow && !pictureInPictureWindow.closed) {
    broadcastOwnsPictureInPicture = false;
    pictureInPictureWindow.close();
  }
  updateRemoteBroadcastUi();
  updateUniverseUi();
}

async function acquireBroadcastLatencyMode() {
  if (!pictureInPictureWindow && pictureInPictureSupported(window)) {
    broadcastOwnsPictureInPicture = await openPictureInPicture();
  }
  await acquireBroadcastWakeLock();
  updateRemoteBroadcastUi();
  updateUniverseUi();
}

function updatePictureInPictureSupport() {
  const supported = pictureInPictureSupported(window);
  elements.pictureInPictureToggle.disabled = !supported;
  elements.pictureInPictureNote.textContent = supported
    ? "The floating window stays above other apps while this page remains open. Its position is controlled by the browser."
    : "Interactive Picture-in-Picture is not supported by this browser. Use the desktop app for an always-on-top overlay.";
}

function resetAffect(source = "keyboard") {
  if (touchTrackingActive()) {
    touchTrace.reset({ width: window.innerWidth, height: window.innerHeight });
    lastLoggedGateCommitSequence = 0;
    state.targetX = 0;
    state.targetY = 0;
    recordEvent(source, "reset", "touch-trace-neutral", 0);
    announce("Experimental movement feedback and calibration returned to neutral.");
    return;
  }
  if (manualAxisAvailable("valence")) state.targetX = 0;
  if (manualAxisAvailable("arousal")) state.targetY = 0;
  state.heldDirections.clear();
  clearHeldButtonStyles();
  recordEvent(source, "reset", "neutral", 0);
  announce("Affect target returned to neutral.");
}

function toggleAnimation(source = "keyboard") {
  state.animationActive = !state.animationActive;
  elements.pauseButton.textContent = state.animationActive ? "Pause motion" : "Resume motion";
  recordEvent(source, state.animationActive ? "resume" : "pause", "animation", state.animationActive);
  announce(state.animationActive ? "Animation resumed." : "Animation paused.");
}

function setMode(mode, source = "panel") {
  if (mode !== "continuous" && mode !== "step") return;
  if (mode === state.inputMode) return;
  state.inputMode = mode;
  state.heldDirections.clear();
  clearHeldButtonStyles();
  updateModeControls();
  savePreferences();
  recordEvent(source, "mode-change", "input-mode", mode);
  announce(`${mode === "step" ? "Step" : "Continuous"} input mode selected.`);
}

function setInputSource(inputSource, source = "panel") {
  if (inputSource !== "manual" && inputSource !== "touch-trace") return;
  if (inputSource === state.inputSource) return;
  state.inputSource = inputSource;
  state.heldDirections.clear();
  clearHeldButtonStyles();
  state.targetX = 0;
  state.targetY = 0;
  touchTrace.reset({ width: window.innerWidth, height: window.innerHeight });
  lastLoggedGateCommitSequence = 0;
  updateInputSourceControls();
  updateExperimentSourceControls();
  applyPolarMappings();
  constrainAndRenderWidget();
  savePreferences();
  recordEvent(source, "source-change", "input-source", inputSource);
  announce(inputSource === "touch-trace"
    ? "Experimental Touch/Trackpad control selected. Page movement now drives the affect display."
    : "Manual affect controls selected.");
}

function setTouchFeedbackMode(mode, source = "playground") {
  if (mode !== TOUCH_FEEDBACK_GATED && mode !== TOUCH_FEEDBACK_CONTINUOUS) return;
  if (mode === state.touchFeedbackMode) return;
  state.touchFeedbackMode = mode;
  touchTrace.setFeedbackMode(mode, { targetX: state.targetX, targetY: state.targetY });
  lastLoggedGateCommitSequence = 0;
  updateInputSourceControls();
  savePreferences();
  recordEvent(source, "feedback-mode-change", "touch-feedback-mode", mode);
  announce(mode === TOUCH_FEEDBACK_GATED
    ? "Gated move-and-hold selected. Keep drawing to move the point, then stop to hold its exact position."
    : "Continuous touch feedback selected. Movement is followed live and returns gradually toward neutral.");
}

function moveTarget(direction, source, amount = state.stepSize) {
  if (!manualAxisAvailable(directionAxis(direction))) return;
  const next = applyStep(state.targetX, state.targetY, direction, amount);
  if (directionAxis(direction) === "valence") state.targetX = next.x;
  else state.targetY = next.y;
  recordEvent(source, "step", direction, amount);
}

function updateContinuousInput(deltaSeconds) {
  if (touchTrackingActive() || state.inputMode !== "continuous" || state.heldDirections.size === 0) return;
  const movement = continuousMovement(state.heldDirections, deltaSeconds, state.continuousSpeed);
  if (manualAxisAvailable("valence")) state.targetX = clamp(state.targetX + movement.x);
  if (manualAxisAvailable("arousal")) state.targetY = clamp(state.targetY + movement.y);
}

function clearHeldButtonStyles() {
  for (const button of elements.directionButtons) button.classList.remove("is-held");
}

function targetIsEditable(event) {
  return isNativeFormControl(event.target);
}

function applyAdvancedFeatureAction(action, pressed, source) {
  if (!(action in ADVANCED_BINDING_LABELS)) return false;
  if (!pressed) return true;
  const changes = {
    increaseAnimationSpeed: () => { state.visual.animationSpeed = clamp(state.visual.animationSpeed + 0.1, 0.25, 4); },
    decreaseAnimationSpeed: () => { state.visual.animationSpeed = clamp(state.visual.animationSpeed - 0.1, 0.25, 4); },
    increaseAmplitude: () => { state.visual.amplitudeScale = clamp(state.visual.amplitudeScale + 0.1, 0, 2); },
    decreaseAmplitude: () => { state.visual.amplitudeScale = clamp(state.visual.amplitudeScale - 0.1, 0, 2); },
    increaseDisorder: () => { state.visual.disorderScale = clamp(state.visual.disorderScale + 0.1, 0, 2); },
    decreaseDisorder: () => { state.visual.disorderScale = clamp(state.visual.disorderScale - 0.1, 0, 2); },
    increaseTransparency: () => { state.widgetOpacity = clamp(state.widgetOpacity - 0.05, 0, 1); },
    decreaseTransparency: () => { state.widgetOpacity = clamp(state.widgetOpacity + 0.05, 0, 1); },
    increaseSize: () => { state.widgetSize = clamp(state.widgetSize + 10, 120, 640); },
    decreaseSize: () => { state.widgetSize = clamp(state.widgetSize - 10, 120, 640); },
  };
  changes[action]();
  updateCustomizationControls();
  constrainAndRenderWidget();
  savePreferences();
  recordEvent(source, "advanced-feature", action, JSON.stringify({
    visual: state.visual,
    opacity: state.widgetOpacity,
    size: state.widgetSize,
  }));
  announce(`${ADVANCED_BINDING_LABELS[action]} applied.`);
  return true;
}

function applyBoundAction(action, pressed, source, impulse = false) {
  if (applyAdvancedFeatureAction(action, pressed, source)) return true;
  if (touchTrackingActive() && action === "reset") {
    if (pressed) resetAffect(source);
    return true;
  }
  const direction = DIRECTION_BY_ACTION[action];
  if (direction) {
    if (touchTrackingActive()) {
      if (pressed) {
        recordEvent(source, "ignored-control", direction, "touch-trace");
        announce("Manual direction was logged but movement remains in control.");
      }
      return true;
    }
    if (!manualAxisAvailable(directionAxis(direction))) {
      if (pressed) {
        recordEvent(source, "ignored-control", direction, "polar-stream");
        announce(`${directionAxis(direction) === "valence" ? "Valence" : "Arousal"} is currently assigned to Polar Stream.`);
      }
      return true;
    }
    if (impulse || state.inputMode === "step") {
      if (pressed) moveTarget(direction, source);
    } else if (pressed) {
      if (!state.heldDirections.has(direction)) {
        state.heldDirections.add(direction);
        recordEvent(source, "press", direction, true);
      }
    } else if (state.heldDirections.delete(direction)) {
      recordEvent(source, "release", direction, false);
    }
    return true;
  }
  if (!pressed && !impulse) return Boolean(action);
  if (action === "reset") resetAffect(source);
  else if (action === "togglePause") toggleAnimation(source);
  else if (action === "showSettings") {
    Object.assign(state, setAccordionProtocolOpen(state, "settings", true));
    elements.inputSettings.open = true;
    updateAccordionPanelStates();
    applyPolarMappings();
    constrainAndRenderWidget();
    savePreferences();
  } else if (action === "toggleOverlayEditing") {
    state.widgetDragEnabled = !state.widgetDragEnabled;
    updateCustomizationControls();
    constrainAndRenderWidget();
    announce(state.widgetDragEnabled ? "Flubber dragging enabled." : "Flubber dragging disabled.");
  }
  return Boolean(action);
}

function handleGlobalKeyDown(event) {
  if (targetIsEditable(event) || captureInput) return;
  const action = actionForBinding(state.bindings, `key:${event.code}`, state.advancedBindings);
  if (action) {
    event.preventDefault();
    if (!event.repeat) applyBoundAction(action, true, "keyboard");
  }
}

function handleGlobalKeyUp(event) {
  if (targetIsEditable(event) || captureInput) return;
  const action = actionForBinding(state.bindings, `key:${event.code}`, state.advancedBindings);
  if (action) {
    event.preventDefault();
    applyBoundAction(action, false, "keyboard");
  }
}

function handleWheel(event) {
  if (targetIsEditable(event) || elements.panelContent.contains(event.target) || captureInput) return;
  const action = actionForBinding(state.bindings, `wheel:${wheelDirection(event.deltaX, event.deltaY)}`, state.advancedBindings);
  if (action) {
    event.preventDefault();
    applyBoundAction(action, true, "wheel", true);
    return;
  }
  const wheelAxis = event.shiftKey ? "valence" : "arousal";
  if (!manualAxisAvailable(wheelAxis)) return;
  event.preventDefault();
  // Keep the original browser gesture as a fallback when no wheel direction is explicitly assigned.
  const amount = normalizeWheel(event.deltaY);
  if (event.shiftKey) state.targetX = clamp(state.targetX + amount);
  else state.targetY = clamp(state.targetY + amount);
  recordEvent("wheel", "move", event.shiftKey ? "valence" : "arousal", amount);
}

function handleGlobalMouseDown(event) {
  if (targetIsEditable(event) || captureInput || elements.widget.contains(event.target)) return;
  const action = actionForBinding(state.bindings, `mouse:${mouseButtonName(event.button)}`, state.advancedBindings);
  if (action) applyBoundAction(action, true, "mouse");
}

function handleGlobalMouseUp(event) {
  if (captureInput) return;
  const action = actionForBinding(state.bindings, `mouse:${mouseButtonName(event.button)}`, state.advancedBindings);
  if (action) applyBoundAction(action, false, "mouse");
}

function handleWidgetPointerDown(event) {
  if (event.button !== 0 || !state.widgetDragEnabled || touchTrackingActive()) return;
  state.dragging = true;
  dragOffsetX = event.clientX - state.widgetX;
  dragOffsetY = event.clientY - state.widgetY;
  elements.widget.classList.add("is-dragging");
  elements.widget.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function handleWidgetPointerMove(event) {
  if (!state.dragging) return;
  state.widgetX = event.clientX - dragOffsetX;
  state.widgetY = event.clientY - dragOffsetY;
  constrainAndRenderWidget();
}

function finishWidgetDrag(event) {
  if (!state.dragging) return;
  state.dragging = false;
  elements.widget.classList.remove("is-dragging");
  if (elements.widget.hasPointerCapture?.(event.pointerId)) {
    elements.widget.releasePointerCapture(event.pointerId);
  }
  savePreferences();
  reanchorLiveRemotePosition();
  recordEvent("pointer", "drag-complete", "widget", `${Math.round(state.widgetX)}:${Math.round(state.widgetY)}`);
}

function touchTraceTargetExcluded(target) {
  if (experiment.phase !== "idle") return false;
  if (target?.closest?.("#touch-playground-surface")) return false;
  return Boolean(target?.closest?.(".control-panel, .touch-trace-panel, button, input, select, textarea, [contenteditable='true']"));
}

function touchTraceCaptureEnabled(event, phase) {
  if (!touchTrackingActive() || captureInput || document.hidden) return false;
  if (experiment.phase === "running" && !experiment.playbackActive) return false;
  if (experiment.phase !== "idle" && experiment.phase !== "running") return false;
  // Mouse and OS-accelerated touchpad hover is the page-wide signal. Analyze
  // every movement, including motion over controls, without treating clicks
  // as stroke boundaries or preventing the control's ordinary behavior.
  if (event.pointerType === "mouse") return phase === "move";
  return !touchTraceTargetExcluded(event.target);
}

function recordRawPointer(event, phase, coalescedIndex, result) {
  if (!experiment.writer || experiment.phase !== "running" || !experiment.playbackActive) return;
  const diagonal = Math.hypot(window.innerWidth, window.innerHeight);
  const metric = touchTrace.snapshot();
  experiment.writer.record("pointer_raw", {
    source: "pointer",
    action: phase,
    control: event.pointerType,
    value: result.accepted ? "" : result.reason,
    algorithmVersion: TOUCH_TRACE_ALGORITHM_VERSION,
    pointerTimeMs: event.timeStamp,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    pointerPhase: phase,
    strokeId: metric.strokeId,
    coalescedIndex,
    clientX: event.clientX,
    clientY: event.clientY,
    normalizedX: event.clientX / diagonal,
    normalizedY: event.clientY / diagonal,
    pressure: event.pressure,
    buttons: event.buttons,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    rawSpeed: result.rawSpeed ?? "",
    filteredSpeed: result.filteredSpeed ?? "",
    gateId: metric.gateId,
    gateOpen: metric.gateOpen,
    gateCommitSequence: metric.gateCommitSequence,
    gateDurationMs: metric.gateDurationMs,
    gateDeltaX: metric.gateDeltaX,
    gateDeltaY: metric.gateDeltaY,
    gateLiveActive: metric.gateLiveActive,
    gateLiveRateX: metric.gateLiveRateX,
    gateLiveRateY: metric.gateLiveRateY,
    gateLiveDeltaX: metric.gateLiveDeltaX,
    gateLiveDeltaY: metric.gateLiveDeltaY,
    speedCalibrationSamples: metric.speedCalibrationSamples,
    shapeCalibrationSamples: metric.shapeCalibrationSamples,
    traceFeedbackVisible: state.touchTraceFeedback,
  }, state);
}

function ingestPointerEvent(event, phase) {
  if (!touchTraceCaptureEnabled(event, phase)) return;
  if (event.isPrimary === false) {
    if (phase === "down") recordEvent("pointer", "ignored-multitouch", event.pointerType, event.pointerId);
    return;
  }
  if (
    activeTracePointerId !== undefined
    && event.pointerType !== "mouse"
    && event.pointerId !== activeTracePointerId
    && touchTrace.pointerType !== "mouse"
  ) {
    if (phase === "down") recordEvent("pointer", "ignored-multitouch", event.pointerType, event.pointerId);
    return;
  }
  if (phase === "down") {
    activeTracePointerId = event.pointerId;
    const preserveSpeed = event.pointerType !== "mouse" && touchTrace.shouldPreserveSpeed(event.timeStamp);
    touchTrace.beginStroke(event.pointerType, { preserveSpeed });
    try { elements.stage.setPointerCapture(event.pointerId); } catch { /* implicit capture remains available */ }
  } else if (phase === "move" && activeTracePointerId === undefined) {
    activeTracePointerId = event.pointerId;
  }
  const coalesced = phase === "move" ? event.getCoalescedEvents?.() : undefined;
  const points = coalesced?.length ? coalesced : [event];
  points.forEach((point, index) => {
    const result = touchTrace.ingest({
      clientX: point.clientX,
      clientY: point.clientY,
      time: point.timeStamp,
      pointerType: event.pointerType,
    });
    recordRawPointer(point, phase, index, result);
  });
  if (event.pointerType !== "mouse" && event.cancelable) event.preventDefault();
  if (phase === "up" || phase === "cancel") {
    if (elements.stage.hasPointerCapture?.(event.pointerId)) elements.stage.releasePointerCapture(event.pointerId);
    activeTracePointerId = undefined;
    touchTrace.endStroke();
    if (phase === "cancel") touchTrace.resetSegment();
  }
}

function downloadCsvParts(parts, filename) {
  const blob = new Blob(parts, { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { parts, filename, bytes: blob.size };
}

function downloadLog(filename) {
  return downloadCsvParts([logger.exportCsv()], filename);
}

function exportLog() {
  recordEvent("panel", "export", "csv", logger.buffer.length);
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  downloadLog(`affect-tracker-${logger.sessionId}-${timestamp}.csv`);
  announce(`CSV exported with ${logger.buffer.length.toLocaleString()} records.`);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let youtubeApiPromise;

function setExperimentPlayback(active, source) {
  if (experiment.playbackActive === active) return;
  const now = performance.now();
  if (experiment.playbackActive && experiment.activeStartedAt !== undefined) {
    experiment.activeElapsedMs += now - experiment.activeStartedAt;
  }
  experiment.playbackActive = active;
  experiment.activeStartedAt = active ? now : undefined;
  applyPolarMappings();
  if (experiment.writer) recordEvent(source, "state-change", "player", active ? "playing" : "buffering");
}

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApiPromise) return youtubeApiPromise;
  youtubeApiPromise = new Promise((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      resolve(window.YT);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => reject(new Error("The YouTube player API could not be loaded."));
    document.head.append(script);
  });
  return youtubeApiPromise;
}

function createLocalExperimentAdapter() {
  const video = elements.experimentVideo;
  elements.youtubePlayer.hidden = true;
  video.hidden = false;
  video.onended = () => finishExperiment("video-ended");
  video.onpause = () => {
    if (experiment.phase === "running") {
      setExperimentPlayback(false, "local-video");
      video.play().catch(() => {});
    }
  };
  video.onplaying = () => {
    if (experiment.phase === "running") setExperimentPlayback(true, "local-video");
  };
  video.onwaiting = () => {
    if (experiment.phase === "running") setExperimentPlayback(false, "local-video");
  };
  return {
    stimulusId: "dictator-3-study.mp4",
    source: "local-video",
    async prepare() {
      video.controls = false;
      video.muted = true;
      video.currentTime = 0;
      if (!video.getAttribute("src")) video.src = DEMO_VIDEO_URL;
      await video.play();
    },
    async start() {
      video.currentTime = 0;
      video.muted = false;
      if (video.paused) await video.play();
    },
    stop() {
      video.pause();
      video.currentTime = 0;
      video.muted = true;
    },
    currentTime: () => DEMO_START_SECONDS + video.currentTime,
    duration: () => DEMO_START_SECONDS + video.duration,
  };
}

function createYouTubeExperimentAdapter(config) {
  let player;
  let resolvePlaying;
  let rejectPlaying;
  elements.experimentVideo.hidden = true;
  elements.youtubePlayer.hidden = false;
  elements.youtubePlayer.replaceChildren();
  const waitForPlaying = () => new Promise((resolve, reject) => {
    resolvePlaying = resolve;
    rejectPlaying = reject;
  });
  return {
    stimulusId: config.videoId,
    source: "youtube",
    async prepare() {
      await loadYouTubeApi();
      const playing = waitForPlaying();
      if (!player) {
        const mount = document.createElement("div");
        mount.id = `youtube-player-${Date.now()}`;
        elements.youtubePlayer.append(mount);
        player = new window.YT.Player(mount, {
          videoId: config.videoId,
          host: "https://www.youtube.com",
          playerVars: {
            autoplay: 1,
            controls: 0,
            disablekb: 1,
            fs: 0,
            iv_load_policy: 3,
            playsinline: 1,
            rel: 0,
            start: config.startSeconds,
            end: config.endSeconds,
            mute: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: (event) => {
              const iframe = event.target.getIframe();
              iframe.tabIndex = -1;
              iframe.setAttribute("aria-hidden", "true");
              iframe.setAttribute("allow", "autoplay; encrypted-media");
              iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
              event.target.mute();
              event.target.playVideo();
            },
            onStateChange: (event) => {
              if (event.data === window.YT.PlayerState.PLAYING) resolvePlaying?.();
              if (experiment.phase !== "running") return;
              const stateName = {
                [window.YT.PlayerState.ENDED]: "ended",
                [window.YT.PlayerState.PLAYING]: "playing",
                [window.YT.PlayerState.PAUSED]: "paused",
                [window.YT.PlayerState.BUFFERING]: "buffering",
                [window.YT.PlayerState.CUED]: "cued",
              }[event.data] ?? String(event.data);
              if (event.data === window.YT.PlayerState.PLAYING) setExperimentPlayback(true, "youtube");
              else if ([window.YT.PlayerState.BUFFERING, window.YT.PlayerState.PAUSED, window.YT.PlayerState.ENDED].includes(event.data)) {
                setExperimentPlayback(false, "youtube");
              }
              else recordEvent("youtube", "state-change", "player", stateName);
              if (event.data === window.YT.PlayerState.ENDED) finishExperiment("video-ended");
              else if (event.data === window.YT.PlayerState.PAUSED) event.target.playVideo();
            },
            onAutoplayBlocked: () => rejectPlaying?.(new DOMException("Playback requires another click.", "NotAllowedError")),
            onError: (event) => {
              const message = [101, 150].includes(event.data)
                ? "This YouTube video does not permit embedded playback. Enable embedding or choose another video."
                : `YouTube could not play the stimulus (error ${event.data}).`;
              rejectPlaying?.(new Error(message));
            },
          },
        });
      } else {
        player.mute();
        player.playVideo();
      }
      await playing;
    },
    async start() {
      const playing = waitForPlaying();
      player.loadVideoById({
        videoId: config.videoId,
        startSeconds: config.startSeconds,
        endSeconds: config.endSeconds,
      });
      player.unMute();
      await playing;
    },
    stop() {
      player?.destroy?.();
      player = undefined;
      elements.youtubePlayer.replaceChildren();
    },
    currentTime: () => player?.getCurrentTime?.() ?? config.startSeconds,
    duration: () => config.endSeconds,
  };
}

function readExperimentConfig() {
  return normalizeExperimentConfig({
    source: elements.experimentSource.value,
    youtubeUrl: elements.experimentYoutubeUrl.value,
    startSeconds: elements.experimentStartSeconds.value,
    endSeconds: elements.experimentEndSeconds.value,
  });
}

function updateExperimentSourceControls() {
  const youtube = elements.experimentSource.value === "youtube";
  for (const element of [elements.experimentYoutubeUrl, elements.experimentStartSeconds, elements.experimentEndSeconds]) {
    element.disabled = !youtube || experiment.phase !== "idle";
  }
  elements.experimentSource.disabled = experiment.phase !== "idle";
  screenCalibration.setAvailable(experiment.phase === "idle");
  elements.experimentSourceNote.textContent = youtube
    ? "YouTube playback sends the requested video and normal embed metadata to YouTube. Recording remains local. Videos whose owners disable embedding cannot run here."
    : "The preloaded video and recording remain in this page. Physical key, mouse-button, and wheel identifiers—not typed text—are recorded locally during the experiment.";
  if (state.inputSource === "touch-trace") {
    elements.experimentSourceNote.textContent += " Experimental pointer trajectories, derived movement metrics, adaptive bounds, and displayed affect values will also be included in the local CSV.";
  }
  if (state.polarConnected || Object.values(state.polarMappings).some((mapping) => mapping.metric !== "manual")) {
    elements.experimentSourceNote.textContent += " Polar connection, assigned metric values, bounds, and normalized affect context will be included; raw ECG will not.";
  }
  updateExperimentSizeWarning();
}

function updateExperimentSizeWarning() {
  const start = elements.experimentSource.value === "local" ? DEMO_START_SECONDS : Number(elements.experimentStartSeconds.value);
  const end = elements.experimentSource.value === "local" ? DEFAULT_EXPERIMENT_CONFIG.endSeconds : Number(elements.experimentEndSeconds.value);
  const duration = end - start;
  const visible = state.inputSource === "touch-trace" && Number.isFinite(duration) && duration > 1_800;
  elements.experimentSizeWarning.hidden = !visible;
  if (visible) {
    const estimateMb = Math.round(duration * 300 * 320 / 1_000_000);
    elements.experimentSizeWarning.textContent = `Long experimental segment: browser-delivered pointer rows may produce roughly ${estimateMb.toLocaleString()} MB of local CSV data. Recording remains append-only and is not capped.`;
  }
}

async function requestExperimentFullscreen() {
  if (!document.fullscreenEnabled || document.fullscreenElement || !document.documentElement.requestFullscreen) {
    return false;
  }
  try {
    await document.documentElement.requestFullscreen();
    experiment.ownsFullscreen = document.fullscreenElement === document.documentElement;
    return experiment.ownsFullscreen;
  } catch {
    announce("Fullscreen permission was not granted. The experiment will continue in this window.");
    return false;
  }
}

function exitExperimentFullscreen() {
  const shouldExit = experiment.ownsFullscreen && document.fullscreenElement === document.documentElement;
  experiment.ownsFullscreen = false;
  if (shouldExit) document.exitFullscreen?.().catch(() => {});
}

function teardownExperimentPresentation() {
  clearInterval(experiment.sampleTimer);
  experiment.sampleTimer = undefined;
  experiment.adapter?.stop?.();
  experiment.adapter = undefined;
  elements.experimentPlayerShell.hidden = true;
  elements.experimentLayer.classList.remove("is-preloading", "is-video-visible");
  elements.experimentCountdown.value = "";
  elements.experimentLayer.hidden = true;
  document.body.classList.remove("is-experiment-running");
  elements.experimentLayer.classList.remove("is-touch-capture-active");
  if (experiment.restore) {
    state.widgetX = experiment.restore.widgetX;
    state.widgetY = experiment.restore.widgetY;
    state.widgetDragEnabled = experiment.restore.widgetDragEnabled;
    state.panelOpen = experiment.restore.panelOpen;
  }
  experiment.restore = undefined;
  experiment.videoTimeSeconds = "";
  experiment.id = "";
  experiment.writer = undefined;
  experiment.playbackActive = false;
  experiment.activeElapsedMs = 0;
  experiment.activeStartedAt = undefined;
  experiment.displayWidgetSize = undefined;
  experiment.traceRect = undefined;
  experiment.phase = "idle";
  applyPolarMappings();
  offsets = createProjectionOffsets(logger.sessionId, profiles.waveCount);
  exitExperimentFullscreen();
  elements.experimentStartButton.disabled = false;
  elements.experimentStartButton.textContent = "Start experiment";
  updateExperimentSourceControls();
  updatePanelState();
  updateCustomizationControls();
  constrainAndRenderWidget();
}

function abortExperiment(message) {
  if (experiment.writer?.length) {
    recordEvent("experiment", "abort", "partial", message);
    const filename = experimentFilename(experiment.writer.sessionId).replace(".csv", "-partial.csv");
    experiment.lastExport = downloadCsvParts(experiment.writer.exportParts(), filename);
    elements.experimentRetryExportButton.hidden = false;
  }
  teardownExperimentPresentation();
  announce(message);
}

function finishExperiment(reason = "video-ended") {
  if (experiment.phase !== "running") return;
  experiment.phase = "finishing";
  clearInterval(experiment.sampleTimer);
  experiment.sampleTimer = undefined;
  if (touchTrackingActive() && state.touchFeedbackMode === TOUCH_FEEDBACK_GATED) {
    touchTrace.commitGate(performance.now());
    applyTouchTraceState(touchTrace.snapshot());
  }
  recordTouchMetric();
  recordSample();
  recordEvent("experiment", "stop", reason, experiment.adapter?.duration?.() ?? "");
  const writer = experiment.writer;
  const completed = reason === "configured-end" || reason === "video-ended";
  const filename = completed
    ? experimentFilename(writer.sessionId)
    : experimentFilename(writer.sessionId).replace(".csv", "-partial.csv");
  const recordCount = writer.length;
  experiment.lastExport = downloadCsvParts(writer.exportParts(), filename);
  elements.experimentRetryExportButton.hidden = false;
  teardownExperimentPresentation();
  announce(`${completed ? "Experiment complete" : "Experiment stopped early"}. CSV downloaded with ${recordCount.toLocaleString()} timestamped records.`);
}

function recordExperimentSample() {
  if (experiment.phase !== "running") return;
  const stimulusTime = experiment.adapter?.currentTime?.();
  if (Number.isFinite(stimulusTime) && stimulusTime >= experiment.config.endSeconds - 0.02) {
    finishExperiment("configured-end");
    return;
  }
  if (!experiment.playbackActive) return;
  recordTouchMetric();
  recordSample();
}

async function runExperimentCountdown() {
  document.body.classList.add("is-experiment-running");
  elements.touchTracePanel.hidden = true;
  elements.experimentLayer.classList.remove("is-preloading", "is-video-visible");
  elements.experimentLayer.hidden = false;
  elements.experimentPlayerShell.hidden = false;
  state.widgetDragEnabled = false;
  layoutExperiment();
  constrainAndRenderWidget();
  for (const number of [3, 2, 1]) {
    elements.experimentCountdown.value = String(number);
    announce(`${number}`);
    await wait(1000);
  }

  experiment.id = globalThis.crypto?.randomUUID?.() ?? `experiment-${Date.now()}`;
  experiment.phase = "starting";
  experiment.videoTimeSeconds = experiment.config.startSeconds;
  state.currentX = 0;
  state.currentY = 0;
  state.targetX = 0;
  state.targetY = 0;
  state.heldDirections.clear();
  clearHeldButtonStyles();
  touchTrace.reset({ width: window.innerWidth, height: window.innerHeight });
  lastLoggedGateCommitSequence = 0;
  sampleAccumulator = 0;
  await experiment.adapter.start();
  experiment.phase = "running";
  experiment.activeElapsedMs = 0;
  experiment.activeStartedAt = performance.now();
  experiment.playbackActive = true;
  experiment.writer = new ExperimentCsvWriter({ context: experimentRecordContext });
  offsets = createProjectionOffsets(experiment.writer.sessionId, profiles.waveCount);
  elements.experimentCountdown.value = "";
  elements.experimentLayer.classList.add("is-video-visible");
  updateInputSourceControls();
  recordEvent(
    "experiment",
    "start",
    experiment.adapter.source,
    `${experiment.adapter.stimulusId}@${experiment.config.startSeconds}-${experiment.config.endSeconds}`,
  );
  recordExperimentSample();
  experiment.sampleTimer = setInterval(recordExperimentSample, EXPERIMENT_SAMPLE_INTERVAL_MS);
  announce("Experiment recording started at neutral.");
}

async function startExperiment() {
  if (experiment.phase === "awaiting-gesture") {
    elements.experimentStartButton.disabled = true;
    elements.experimentStartButton.textContent = "Preparing video…";
    try {
      await experiment.adapter.prepare();
      experiment.phase = "preloading";
      await runExperimentCountdown();
    } catch (error) {
      abortExperiment(error?.message ?? String(error));
    }
    return;
  }
  if (experiment.phase !== "idle") return;
  if (universeLink.snapshot().enabled || flubberParty.snapshot().enabled) {
    announce("Stop Universe synchronization or the FLUBBER party before starting an experiment.");
    return;
  }
  try {
    experiment.config = readExperimentConfig();
  } catch (error) {
    announce(error?.message ?? String(error));
    return;
  }
  experiment.lastExport = undefined;
  elements.experimentRetryExportButton.hidden = true;
  await requestExperimentFullscreen();
  experiment.phase = "loading";
  applyPolarMappings();
  experiment.adapter = experiment.config.source === "youtube"
    ? createYouTubeExperimentAdapter(experiment.config)
    : createLocalExperimentAdapter();
  experiment.restore = {
    widgetX: state.widgetX,
    widgetY: state.widgetY,
    widgetDragEnabled: state.widgetDragEnabled,
    panelOpen: state.panelOpen,
  };
  elements.experimentStartButton.disabled = true;
  elements.experimentStartButton.textContent = "Loading video…";
  elements.experimentLayer.hidden = false;
  elements.experimentLayer.classList.add("is-preloading");
  elements.experimentPlayerShell.hidden = false;
  layoutExperiment();
  updateExperimentSourceControls();
  if (pictureInPictureWindow && !pictureInPictureWindow.closed) pictureInPictureWindow.close();
  try {
    experiment.phase = "preloading";
    elements.experimentStartButton.textContent = "Preparing video…";
    await experiment.adapter.prepare();
    await runExperimentCountdown();
  } catch (error) {
    if (error?.name === "NotAllowedError") {
      experiment.phase = "awaiting-gesture";
      elements.experimentStartButton.disabled = false;
      elements.experimentStartButton.textContent = "Continue video playback";
      announce("The browser requires one more click before video playback.");
    } else {
      abortExperiment(error?.message ?? String(error));
    }
  }
}

function physicalModifiers(event) {
  return {
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
  };
}

function recordPhysicalInput(source, action, control, value = "") {
  if (experiment.phase !== "running") return;
  recordEvent(source, action, control, value);
}

function exportSettings() {
  const name = requiredGroundControlName();
  const blob = new Blob([portableSettingsJson(settingsFromState())], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = groundControlFilename(name);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  recordEvent("ground-control", "export", groundControlFilename(name), 1);
  announce(`${groundControlFilename(name)} downloaded.`);
}

function downloadJson(contents, filename) {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function updateQuestControllerFollowControls() {
  const disabled = !elements.questFollowController.checked;
  elements.questFollowControllerHand.disabled = disabled;
  elements.questFollowControllerDistance.disabled = disabled;
}

async function exportQuestSession() {
  const file = elements.questVideoFile.files?.[0];
  if (!file) throw new Error("Select the video that will be copied to the headset.");
  elements.questExportButton.disabled = true;
  elements.questExportStatus.textContent = `Hashing ${file.name} locally…`;
  try {
    const sha256 = await hashVideoFile(file);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const session = createVrSession({
      sessionId: `quest-${timestamp}`,
      file,
      sha256,
      projection: elements.questVideoProjection.value,
      stereo: elements.questVideoStereo.value,
      loop: elements.questVideoLoop.checked,
      affectSettings: settingsFromState(),
      environment: elements.questMixedReality.checked ? "passthrough" : "dark",
      flubber: {
        widthMeters: Number(elements.questFlubberWidth.value),
        distanceMeters: Number(elements.questFlubberDistance.value),
        horizontalOffsetMeters: Number(elements.questFlubberX.value),
        verticalOffsetMeters: Number(elements.questFlubberY.value),
        showAffectValues: elements.questShowAffectValues.checked,
        controllerFollow: {
          enabled: elements.questFollowController.checked,
          hand: elements.questFollowControllerHand.value,
          distanceMeters: Number(elements.questFollowControllerDistance.value),
        },
      },
      controls: {
        stick: elements.questStick.value,
        resetButton: elements.questResetButton.value,
        pauseButton: elements.questPauseButton.value,
        grabTrigger: "either",
        showControllerModels: elements.questShowControllerModels.checked,
      },
    });
    downloadJson(vrSessionJson(session), "active-session.json");
    elements.questExportStatus.textContent = `Ready. Copy ${file.name} first, then active-session.json last.`;
    recordEvent("settings", "export", "quest-session-json", 1);
    announce("Quest session JSON exported.");
  } finally {
    elements.questExportButton.disabled = false;
  }
}

async function importSettings(file) {
  if (!file) return;
  if (file.size > 256 * 1024) throw new Error("Settings JSON must be smaller than 256 KB.");
  const imported = normalizePortableSettings(JSON.parse(await file.text()));
  applyPortableSettings(imported, true);
  const fileStem = file.name.replace(/\.json$/i, "").replace(/[-_]+/g, " ").trim();
  if (!state.groundControlName && fileStem) {
    try {
      state.groundControlName = normalizeGroundControlName(fileStem);
      elements.groundControlName.value = state.groundControlName;
      savePreferences();
    } catch { /* keep the operator-entered name requirement */ }
  }
  recordEvent("ground-control", "import", "json", 1);
  announce("Portable settings JSON imported and applied.");
}

function clearLog() {
  if (!window.confirm("Clear all buffered affect samples and input events? This cannot be undone.")) return;
  logger.resetSession();
  offsets = createProjectionOffsets(logger.sessionId, profiles.waveCount);
  sampleAccumulator = 0;
  logger.record("event", { source: "panel", action: "clear", control: "buffer" }, state);
  updateLoggerDisplay();
  announce("Buffer cleared and a new logging session started.");
}

function initializeEvents() {
  flubberBroadcaster.addEventListener("statechange", (event) => updateRemoteBroadcastUi(event.detail));
  flubberReceiver.addEventListener("statechange", (event) => {
    updateLiveReceiveUi(event.detail);
    if (shouldDismissGroundRadar({ mode: groundRadarMode, phase: event.detail.phase })) {
      const sourceLabel = event.detail.sourceLabel || "live FLUBBER signal";
      dismissGroundRadarAfterSuccess(`Connected to ${sourceLabel}.`);
      return;
    }
    if (groundRadarMode === "live") {
      elements.groundRadarStatus.textContent = event.detail.message
        || (event.detail.phase === "live" ? "Live FLUBBER signal connected." : "Scanning live FLUBBER signals…");
      updateRadarSources();
    }
  });
  flubberReceiver.addEventListener("frame", (event) => updateLiveReceiveUi(event.detail));
  settingsSnapshotBroadcaster.addEventListener("statechange", (event) => updateSettingsBroadcastUi(event.detail));
  settingsSnapshotReceiver.addEventListener("statechange", (event) => updateSettingsRadar(event.detail));
  settingsSnapshotReceiver.addEventListener("snapshot", (event) => showReceivedSettings(event.detail));
  universeLink.addEventListener("statechange", (event) => updateUniverseUi(event.detail));
  flubberParty.addEventListener("statechange", (event) => updatePartyUi(event.detail));
  window.addEventListener("pointerdown", (event) => ingestPointerEvent(event, "down"), { capture: true, passive: false });
  window.addEventListener("pointermove", (event) => ingestPointerEvent(event, "move"), { capture: true, passive: false });
  window.addEventListener("pointerup", (event) => ingestPointerEvent(event, "up"), { capture: true, passive: false });
  window.addEventListener("pointercancel", (event) => ingestPointerEvent(event, "cancel"), { capture: true, passive: false });
  window.addEventListener("keydown", (event) => {
    recordPhysicalInput(
      "keyboard",
      "pressed",
      event.code,
      JSON.stringify({ repeat: event.repeat, ...physicalModifiers(event) }),
    );
  }, true);
  window.addEventListener("keyup", (event) => {
    recordPhysicalInput("keyboard", "released", event.code, JSON.stringify(physicalModifiers(event)));
  }, true);
  window.addEventListener("mousedown", (event) => {
    recordPhysicalInput("mouse", "pressed", mouseButtonName(event.button), JSON.stringify(physicalModifiers(event)));
  }, true);
  window.addEventListener("mouseup", (event) => {
    recordPhysicalInput("mouse", "released", mouseButtonName(event.button), JSON.stringify(physicalModifiers(event)));
  }, true);
  window.addEventListener("wheel", (event) => {
    recordPhysicalInput("wheel", "scrolled", wheelDirection(event.deltaX, event.deltaY), JSON.stringify({
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      ...physicalModifiers(event),
    }));
  }, { capture: true, passive: true });
  window.addEventListener("keydown", handleGlobalKeyDown);
  window.addEventListener("keyup", handleGlobalKeyUp);
  window.addEventListener("mousedown", handleGlobalMouseDown);
  window.addEventListener("mouseup", handleGlobalMouseUp);
  window.addEventListener("wheel", handleWheel, { passive: false });
  document.addEventListener("click", (event) => {
    if (!state.retroTheme || event.target.closest("#retro-theme-toggle")) return;
    if (event.target.closest("button, a, summary, input, select, textarea")) retroSoundboard.play("click");
  }, true);
  window.addEventListener("resize", () => {
    touchTrace.resize(window.innerWidth, window.innerHeight);
    activeTracePointerId = undefined;
    recordPhysicalInput("window", "resize", "viewport", `${window.innerWidth}x${window.innerHeight}`);
    constrainAndRenderWidget();
    savePreferences();
  });
  window.addEventListener("blur", () => {
    state.heldDirections.clear();
    clearHeldButtonStyles();
    touchTrace.beginStroke(touchTrace.pointerType);
    activeTracePointerId = undefined;
  });
  screen.orientation?.addEventListener?.("change", () => {
    touchTrace.resize(window.innerWidth, window.innerHeight);
    activeTracePointerId = undefined;
    recordPhysicalInput("window", "orientation-change", "orientation", screen.orientation.type);
    constrainAndRenderWidget();
  });

  elements.panelToggle.addEventListener("click", () => {
    toggleTopLevelProtocol("settings");
  });
  elements.experimentPanelToggle.addEventListener("click", () => {
    toggleTopLevelProtocol("experiment");
  });
  elements.screenCalibrationPanelToggle.addEventListener("click", () => {
    toggleTopLevelProtocol("calibration");
  });
  elements.touchPlaygroundPanelToggle.addEventListener("click", () => {
    toggleTopLevelProtocol("touch");
  });
  elements.polarStreamPanelToggle.addEventListener("click", () => {
    toggleTopLevelProtocol("polar");
  });
  elements.groundControlPanelToggle.addEventListener("click", () => {
    toggleTopLevelProtocol("ground");
  });
  elements.retroThemeToggle.addEventListener("click", () => {
    state.retroTheme = !state.retroTheme;
    applyRetroTheme();
    savePreferences();
    recordEvent("appearance", "theme-change", "windows-95", state.retroTheme ? "enabled" : "disabled");
    if (state.retroTheme) announce("Windows 95 skin enabled. Retro interface sounds are on.");
    else {
      retroSoundboard.play("click");
      announce("Modern skin restored.");
    }
  });

  elements.polarConnectButton.addEventListener("click", async () => {
    // A failed or cancelled chooser must never leave values from an earlier
    // session looking live while no H10 is selected.
    clearPolarLiveReadout();
    applyPolarMappings();
    state.polarConnecting = true;
    updatePolarConnectionUi(polarReplay ? "Starting deterministic synthetic ECG replay…" : "Waiting for browser Bluetooth chooser…");
    try {
      await polarSession.connect(handlePolarEvent);
    } catch (error) {
      state.polarConnecting = false;
      const chooserCancelled = error?.code === "BLUETOOTH_CHOOSER_CANCELLED";
      updatePolarConnectionUi(error?.message ?? String(error), !chooserCancelled);
      announce(error?.message ?? String(error));
    }
  });
  elements.polarDisconnectButton.addEventListener("click", async () => {
    await polarSession.disconnect();
  });
  elements.groundControlName.value = state.groundControlName;
  elements.groundControlName.addEventListener("change", () => {
    try {
      state.groundControlName = normalizeGroundControlName(elements.groundControlName.value);
      elements.groundControlName.value = state.groundControlName;
      savePreferences();
      announce(`Ground Control name set to ${state.groundControlName}.`);
    } catch (error) {
      state.groundControlName = "";
      announce(error?.message ?? String(error));
      elements.groundControlName.focus();
    }
  });
  elements.groundJsonBroadcastButton.addEventListener("click", async () => {
    elements.groundJsonBroadcastButton.disabled = true;
    try {
      if (settingsSnapshotBroadcaster.snapshot().phase === "broadcasting") {
        const previousName = settingsSnapshotBroadcaster.snapshot().name;
        await settingsSnapshotBroadcaster.stop();
        recordEvent("ground-control", "settings-broadcast-stop", previousName, 0);
        announce("JSON settings beacon stopped.");
      } else {
        const name = requiredGroundControlName();
        const started = await settingsSnapshotBroadcaster.start({ name, settings: settingsFromState() });
        recordEvent("ground-control", "settings-broadcast-start", started.sourceLabel, 1);
        announce(`${started.sourceLabel} is broadcasting one frozen validated snapshot.`);
      }
    } catch (error) {
      announce(error?.message ?? String(error));
      updateSettingsBroadcastUi();
    }
  });
  elements.groundJsonScanButton.addEventListener("click", async () => {
    if (settingsSnapshotReceiver.snapshot().phase !== "idle") {
      await settingsSnapshotReceiver.stop();
      if (groundRadarMode === "json") groundRadarMode = "";
      groundRadarPendingSourceId = "";
      pendingSettingsSnapshot = undefined;
      elements.groundJsonReceived.hidden = true;
      updateSettingsRadar();
      announce("JSON radar stopped.");
      return;
    }
    await startGroundRadar("json");
  });
  elements.groundLiveScanButton.addEventListener("click", async () => {
    if (flubberReceiver.snapshot().phase !== "idle") {
      const previous = flubberReceiver.snapshot().sourceLabel;
      await flubberReceiver.stop();
      if (groundRadarMode === "live") groundRadarMode = "";
      groundRadarPendingSourceId = "";
      updateLiveReceiveUi();
      recordEvent("ground-control", "live-receive-stop", previous, 0);
      announce("Incoming live FLUBBER disconnected; local controls are available again.");
      return;
    }
    await startGroundRadar("live");
  });
  elements.groundUniverseButton.addEventListener("click", async () => {
    if (universeLink.snapshot().enabled) {
      const partner = universeLink.snapshot().sourceLabel;
      await universeLink.stop();
      await releaseBroadcastLatencyMode();
      if (groundRadarMode === "universe") groundRadarMode = "";
      groundRadarPendingSourceId = "";
      universeLocalCurrent = { currentX: state.currentX, currentY: state.currentY };
      updateUniverseUi();
      recordEvent("ground-control", "universe-stop", partner, 0);
      announce("Universe synchronization stopped. Local control is independent again.");
      return;
    }
    if (currentOneWayRole() !== "idle" || flubberParty.snapshot().enabled) {
      announce("Stop the active sender, receiver, or FLUBBER party before starting Universe synchronization.");
      return;
    }
    await startGroundRadar("universe");
    recordEvent("ground-control", "universe-start", state.groundControlName, 1);
  });
  elements.groundPartyButton.addEventListener("click", async () => {
    if (flubberParty.snapshot().enabled) {
      await startGroundRadar("party");
      announce("Party radar reopened. Choose another FLUBBER to invite.");
      return;
    }
    if (currentOneWayRole() !== "idle" || universeLink.snapshot().enabled) {
      announce("Stop the active sender, receiver, or Universe link before opening a FLUBBER party.");
      return;
    }
    await startGroundRadar("party");
    recordEvent("ground-control", "party-start", "radar", 1);
  });
  elements.groundPartyStopButton.addEventListener("click", async () => {
    const count = flubberParty.snapshot().guests.length;
    clearPartyBirthAnimation();
    await flubberParty.stop();
    if (groundRadarMode === "party") groundRadarMode = "";
    groundRadarPendingSourceId = "";
    updatePartyUi();
    recordEvent("ground-control", "party-stop", "guests", count);
    announce("FLUBBER party stopped and all invited signals disconnected.");
  });
  elements.groundRadarStop.addEventListener("click", async () => {
    await stopGroundRadar();
    announce("F.L.U.B.B.E.R. Radar stopped.");
  });
  elements.groundRadarClose.addEventListener("click", () => elements.groundRadarDialog.close());
  elements.groundRadarDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    elements.groundRadarDialog.close();
  });
  elements.groundJsonApplyButton.addEventListener("click", async () => {
    if (!pendingSettingsSnapshot) return;
    const applied = pendingSettingsSnapshot;
    applyPortableSettings(applied.settings, true);
    state.groundControlName = applied.name;
    elements.groundControlName.value = state.groundControlName;
    savePreferences();
    recordEvent("ground-control", "settings-snapshot-apply", applied.name, 1);
    await settingsSnapshotReceiver.stop();
    groundRadarMode = "";
    groundRadarPendingSourceId = "";
    pendingSettingsSnapshot = undefined;
    elements.groundJsonReceived.hidden = true;
    if (elements.groundRadarDialog.open) elements.groundRadarDialog.close();
    updateSettingsRadar();
    announce(`${applied.name} settings applied.`);
  });
  elements.remoteBroadcastButton.addEventListener("click", async () => {
    const snapshot = flubberBroadcaster.snapshot();
    elements.remoteBroadcastButton.disabled = true;
    try {
      if (snapshot.phase === "broadcasting") {
        const sourceLabel = snapshot.sourceLabel;
        await flubberBroadcaster.stop();
        await releaseBroadcastLatencyMode();
        recordEvent("remote-flubber", "remote-broadcast-stop", sourceLabel, 0);
        announce("Remote Flubber broadcast stopped.");
      } else {
        const sourceName = requiredGroundControlName();
        await acquireBroadcastLatencyMode();
        const started = await flubberBroadcaster.start({ sourceName });
        recordEvent("remote-flubber", "remote-broadcast-start", started.sourceLabel, 1);
        announce(`${started.sourceLabel} is broadcasting final Flubber coordinates.`);
      }
    } catch (error) {
      if (flubberBroadcaster.snapshot().phase !== "broadcasting") await releaseBroadcastLatencyMode();
      announce(`Remote broadcast could not start: ${error?.message ?? String(error)}`);
    }
  });
  elements.remoteBroadcastForegroundButton.addEventListener("click", async () => {
    if (flubberBroadcaster.snapshot().phase !== "broadcasting" && !universeLink.snapshot().enabled) return;
    elements.remoteBroadcastForegroundButton.disabled = true;
    await acquireBroadcastLatencyMode();
    const pictureInPictureAvailable = pictureInPictureSupported(window);
    const foregroundWindowActive = Boolean(pictureInPictureWindow && !pictureInPictureWindow.closed);
    const wakeLockAvailable = Boolean(navigator.wakeLock?.request);
    const wakeLockActive = Boolean(broadcastWakeLock && !broadcastWakeLock.released);
    if (foregroundWindowActive && (!wakeLockAvailable || wakeLockActive)) {
      recordEvent("remote-flubber", "remote-foreground-restored", "floating-flubber", 1);
      announce("Low-latency foreground mode restored.");
    } else if (!pictureInPictureAvailable && wakeLockActive) {
      recordEvent("remote-flubber", "remote-wake-lock-restored", "screen-wake-lock", 1);
      announce("Screen wake lock restored. Keep this Chrome tab visible for reliable low latency.");
    } else {
      announce("Foreground mode could not be restored. Keep this Chrome tab visible and try again.");
    }
    updateRemoteBroadcastUi();
    updateUniverseUi();
  });
  for (const fieldset of elements.polarAxisFields) {
    const axis = fieldset.dataset.polarAxis;
    const metric = fieldset.querySelector("[data-polar-field='metric']");
    metric.addEventListener("change", () => {
      const definition = polarMetricDefinition(metric.value);
      if (definition) {
        polarAxisField(axis, "minimum").value = definition.minimum;
        polarAxisField(axis, "maximum").value = definition.maximum;
      }
      commitPolarMapping(axis);
    });
    for (const field of ["minimum", "maximum", "invert"]) {
      fieldset.querySelector(`[data-polar-field='${field}']`).addEventListener("change", () => commitPolarMapping(axis));
    }
  }

  for (const input of elements.modeInputs) {
    input.addEventListener("change", () => setMode(input.value));
  }
  elements.touchTrackingToggle.addEventListener("change", () => {
    setInputSource(elements.touchTrackingToggle.checked ? "touch-trace" : "manual", "playground");
  });
  for (const input of elements.touchFeedbackModeInputs) {
    input.addEventListener("change", () => setTouchFeedbackMode(input.value));
  }
  for (const input of elements.touchHideCursorToggles) {
    input.addEventListener("change", () => {
      state.touchHideCursor = input.checked;
      updateInputSourceControls();
      savePreferences();
      recordEvent("panel", "cursor-visibility", "touch-trace", state.touchHideCursor ? "hidden" : "visible");
      announce(state.touchHideCursor ? "Mouse cursor hidden over tracking areas." : "Mouse cursor visible over tracking areas.");
    });
  }
  elements.touchTraceFeedbackToggle.addEventListener("change", () => {
    state.touchTraceFeedback = elements.touchTraceFeedbackToggle.checked;
    updateInputSourceControls();
    constrainAndRenderWidget();
    savePreferences();
    recordEvent("panel", "trace-feedback", "touch-trace", state.touchTraceFeedback);
    announce(state.touchTraceFeedback ? "Movement trace feedback shown below the Flubber." : "Movement trace feedback hidden.");
  });
  for (const input of elements.paletteInputs) {
    input.addEventListener("input", () => {
      state.palette[input.dataset.palette] = input.value;
      updateFeatureSpace();
      savePreferences();
      recordEvent("panel", "palette-change", input.dataset.palette, input.value);
    });
  }
  for (const [element, key] of [
    [elements.stepSize, "stepSize"],
    [elements.continuousSpeed, "continuousSpeed"],
    [elements.response, "response"],
    [elements.widgetSize, "widgetSize"],
  ]) {
    element.addEventListener("change", () => {
      if (!element.checkValidity()) {
        updateCustomizationControls();
        announce("Enter a value within the displayed range.");
        return;
      }
      state[key] = Number(element.value);
      constrainAndRenderWidget();
      savePreferences();
    });
  }
  for (const button of elements.baseShapeButtons) {
    button.addEventListener("click", () => {
      state.visual.baseShape = button.dataset.baseShape;
      for (const shapeButton of elements.baseShapeButtons) {
        shapeButton.setAttribute("aria-pressed", String(shapeButton === button));
      }
      savePreferences();
      recordEvent("panel", "visual-change", "baseShape", state.visual.baseShape);
      announce(`Flubber shape changed to ${button.textContent.trim()}.`);
    });
  }
  for (const [element, key] of [
    [elements.animationSpeed, "animationSpeed"],
    [elements.amplitudeScale, "amplitudeScale"],
    [elements.disorderScale, "disorderScale"],
  ]) {
    element.addEventListener("change", () => {
      if (!element.checkValidity()) {
        updateCustomizationControls();
        announce("Enter an advanced visual value within the displayed range.");
        return;
      }
      state.visual[key] = Number(element.value);
      savePreferences();
      recordEvent("panel", "visual-change", key, element.value);
    });
  }
  elements.transparency.addEventListener("input", () => {
    state.widgetOpacity = transparencyPercentToOpacity(elements.transparency.value);
    elements.transparencyOutput.value = `${elements.transparency.value}%`;
    constrainAndRenderWidget();
    savePreferences();
  });
  elements.widgetVisibleButton.addEventListener("click", () => {
    state.widgetVisible = !state.widgetVisible;
    updateCustomizationControls();
    constrainAndRenderWidget();
    savePreferences();
  });
  elements.dragToggleButton.addEventListener("click", () => {
    state.widgetDragEnabled = !state.widgetDragEnabled;
    updateCustomizationControls();
    constrainAndRenderWidget();
    savePreferences();
  });
  elements.pictureInPictureToggle.addEventListener("change", async () => {
    if (elements.pictureInPictureToggle.checked) await openPictureInPicture();
    else if (pictureInPictureWindow && !pictureInPictureWindow.closed) pictureInPictureWindow.close();
  });
  elements.settingsExportButton.addEventListener("click", () => {
    try { exportSettings(); } catch (error) {
      announce(error?.message ?? String(error));
      elements.groundControlName.focus();
    }
  });
  elements.questFollowController.addEventListener("change", updateQuestControllerFollowControls);
  updateQuestControllerFollowControls();
  elements.questExportButton.addEventListener("click", async () => {
    try {
      await exportQuestSession();
    } catch (error) {
      const message = error?.message ?? String(error);
      elements.questExportStatus.textContent = message;
      announce(message);
    }
  });
  elements.settingsImportButton.addEventListener("click", () => elements.settingsImportFile.click());
  elements.bindingCaptureCancel.addEventListener("click", () => {
    cancelBindingCapture();
    announce("Input assignment cancelled.");
  });
  elements.bindingCaptureDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    cancelBindingCapture();
    announce("Input assignment cancelled.");
  });
  elements.bindingCaptureDialog.addEventListener("close", () => {
    if (captureInput) cancelBindingCapture();
  });
  elements.settingsImportFile.addEventListener("change", async () => {
    try {
      await importSettings(elements.settingsImportFile.files?.[0]);
    } catch (error) {
      announce(error?.message ?? String(error));
    } finally {
      elements.settingsImportFile.value = "";
    }
  });
  for (const [element, key, numeric = false] of [
    [elements.lslStreamName, "streamName"],
    [elements.lslStreamType, "streamType"],
    [elements.lslMarkerName, "markerName"],
    [elements.lslSampleRate, "sampleRate", true],
    [elements.lslSourceId, "sourceId"],
  ]) {
    element.addEventListener("change", () => {
      if (!element.checkValidity() || element.value.trim() === "") {
        updateCustomizationControls();
        announce("Enter valid settings metadata.");
        return;
      }
      state.lsl[key] = numeric ? Number(element.value) : element.value.trim();
      try {
        savePreferences();
      } catch (error) {
        announce(error?.message ?? String(error));
      }
    });
  }
  elements.mobileOpenSettings.addEventListener("click", () => {
    elements.panel.classList.add("is-mobile-settings-open");
    elements.mobileCloseSettings.focus();
  });
  elements.mobileCloseSettings.addEventListener("click", () => {
    elements.panel.classList.remove("is-mobile-settings-open");
    elements.mobileCoordinateSpace.focus();
  });
  elements.mobileDirectFlubber.addEventListener("pointerdown", (event) => {
    if (event.isPrimary === false || (event.pointerType === "mouse" && event.button !== 0)) return;
    const bounds = elements.mobileDirectFlubber.getBoundingClientRect();
    event.preventDefault();
    mobileFlubberPointerId = event.pointerId;
    mobileFlubberDragOffsetX = event.clientX - (bounds.left + bounds.width / 2);
    mobileFlubberDragOffsetY = event.clientY - (bounds.top + bounds.height / 2);
    elements.mobileDirectFlubber.classList.add("is-dragging");
    elements.mobileDirectFlubber.setPointerCapture(event.pointerId);
  });
  elements.mobileDirectFlubber.addEventListener("pointermove", (event) => {
    if (event.pointerId !== mobileFlubberPointerId) return;
    event.preventDefault();
    chooseMobileFlubberPosition(event);
  });
  const finishMobileFlubberDrag = (event) => {
    if (event.pointerId !== mobileFlubberPointerId) return;
    mobileFlubberPointerId = undefined;
    elements.mobileDirectFlubber.classList.remove("is-dragging");
    if (elements.mobileDirectFlubber.hasPointerCapture(event.pointerId)) {
      elements.mobileDirectFlubber.releasePointerCapture(event.pointerId);
    }
    reanchorLiveRemotePosition();
    savePreferences();
    recordEvent("pointer", "drag-complete", "mobile-flubber", `${Math.round(state.widgetX)}:${Math.round(state.widgetY)}`);
  };
  elements.mobileDirectFlubber.addEventListener("pointerup", finishMobileFlubberDrag);
  elements.mobileDirectFlubber.addEventListener("pointercancel", finishMobileFlubberDrag);
  elements.mobileDirectFlubber.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 0.1 : 0.05;
    const delta = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const normalized = normalizedWidgetPosition();
    setWidgetFromNormalizedPosition({
      viewportX: clamp(normalized.viewportX + delta[0], 0, 1),
      viewportY: clamp(normalized.viewportY + delta[1], 0, 1),
    });
    reanchorLiveRemotePosition();
    savePreferences();
    recordEvent("pointer", "move", `mobile-flubber-${event.key}`, `${Math.round(state.widgetX)}:${Math.round(state.widgetY)}`);
  });
  elements.mobileCoordinateSpace.addEventListener("pointerdown", (event) => {
    if (event.isPrimary === false) return;
    const bounds = elements.mobileCoordinateSpace.getBoundingClientRect();
    if (!startsOnCoordinateMarker({
      clientX: event.clientX,
      clientY: event.clientY,
      x: state.currentX,
      y: state.currentY,
      bounds,
    })) {
      announce("Drag the existing point to change the phone control. Touching elsewhere does not move it.");
      return;
    }
    if (!claimFeatureSpaceControl()) return;
    event.preventDefault();
    mobileCoordinatePointerId = event.pointerId;
    elements.mobileCoordinateSpace.classList.add("is-dragging");
    elements.mobileCoordinateSpace.setPointerCapture(event.pointerId);
    chooseMobileCoordinate(event);
  });
  elements.mobileCoordinateSpace.addEventListener("pointermove", (event) => {
    if (event.pointerId !== mobileCoordinatePointerId) return;
    event.preventDefault();
    chooseMobileCoordinate(event);
  });
  const finishMobileCoordinateSelection = (event) => {
    if (event.pointerId !== mobileCoordinatePointerId) return;
    mobileCoordinatePointerId = undefined;
    elements.mobileCoordinateSpace.classList.remove("is-dragging");
    recordEvent("feature-space", "select-coordinate", "mobile-pointer", `${state.targetX.toFixed(4)},${state.targetY.toFixed(4)}`);
  };
  elements.mobileCoordinateSpace.addEventListener("pointerup", finishMobileCoordinateSelection);
  elements.mobileCoordinateSpace.addEventListener("pointercancel", finishMobileCoordinateSelection);
  elements.mobileCoordinateSpace.addEventListener("keydown", (event) => {
    const direction = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, 0.05], ArrowDown: [0, -0.05] }[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    if (!claimFeatureSpaceControl()) return;
    state.targetX = clamp(state.targetX + direction[0], -1, 1);
    state.targetY = clamp(state.targetY + direction[1], -1, 1);
    state.currentX = state.targetX;
    state.currentY = state.targetY;
    updateCoordinateDisplay();
    updateFeatureSpace();
    recordEvent("feature-space", "select-coordinate", `mobile-${event.key}`, `${state.targetX.toFixed(4)},${state.targetY.toFixed(4)}`);
  });
  elements.featureSpace.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (!claimFeatureSpaceControl()) return;
    featurePointerId = event.pointerId;
    elements.featureSpace.setPointerCapture(event.pointerId);
    chooseFeatureCoordinate(event);
  });
  elements.featureSpace.addEventListener("pointermove", (event) => {
    if (event.pointerId === featurePointerId) {
      event.preventDefault();
      chooseFeatureCoordinate(event);
    }
  });
  const finishFeatureSelection = (event) => {
    if (event.pointerId !== featurePointerId) return;
    featurePointerId = undefined;
    recordEvent("feature-space", "select-coordinate", "pointer", `${state.targetX.toFixed(4)},${state.targetY.toFixed(4)}`);
  };
  elements.featureSpace.addEventListener("pointerup", finishFeatureSelection);
  elements.featureSpace.addEventListener("pointercancel", finishFeatureSelection);
  elements.featureSpace.addEventListener("keydown", (event) => {
    const direction = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, 0.05], ArrowDown: [0, -0.05] }[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    if (!claimFeatureSpaceControl()) return;
    if (direction[0] !== 0) state.targetX = clamp(state.targetX + direction[0], -1, 1);
    if (direction[1] !== 0) state.targetY = clamp(state.targetY + direction[1], -1, 1);
    state.currentX = state.targetX;
    state.currentY = state.targetY;
    updateCoordinateDisplay();
    updateFeatureSpace();
    recordEvent("feature-space", "select-coordinate", event.key, `${state.targetX.toFixed(4)},${state.targetY.toFixed(4)}`);
  });

  for (const button of elements.directionButtons) {
    button.addEventListener("click", () => beginBindingCapture(button.dataset.binding, "bindings", button));
  }

  elements.resetButton.addEventListener("click", () => resetAffect("button"));
  elements.pauseButton.addEventListener("click", () => toggleAnimation("button"));
  elements.exportButton.addEventListener("click", exportLog);
  elements.clearButton.addEventListener("click", clearLog);
  elements.experimentStartButton.addEventListener("click", startExperiment);
  elements.experimentRetryExportButton.addEventListener("click", () => {
    if (!experiment.lastExport) return;
    downloadCsvParts(experiment.lastExport.parts, experiment.lastExport.filename);
    announce("The last experiment CSV download was requested again.");
  });
  document.addEventListener("fullscreenchange", () => {
    touchTrace.resize(window.innerWidth, window.innerHeight);
    activeTracePointerId = undefined;
    if (experiment.phase === "running" && experiment.ownsFullscreen && !document.fullscreenElement) {
      finishExperiment("fullscreen-exited");
      return;
    }
    if (experiment.phase !== "idle") constrainAndRenderWidget();
  });
  elements.experimentSource.addEventListener("change", updateExperimentSourceControls);
  elements.experimentStartSeconds.addEventListener("input", updateExperimentSizeWarning);
  elements.experimentEndSeconds.addEventListener("input", updateExperimentSizeWarning);

  document.addEventListener("visibilitychange", () => {
    recordPhysicalInput("document", "visibility-change", "visibility", document.visibilityState);
    touchTrace.cancelGate();
    touchTrace.beginStroke(touchTrace.pointerType);
    activeTracePointerId = undefined;
  });

  elements.widget.addEventListener("pointerdown", handleWidgetPointerDown);
  elements.widget.addEventListener("pointermove", handleWidgetPointerMove);
  elements.widget.addEventListener("pointerup", finishWidgetDrag);
  elements.widget.addEventListener("pointercancel", finishWidgetDrag);
  window.addEventListener("beforeunload", () => {
    void polarSession.disconnect({ emit: false });
    void flubberBroadcaster.stop();
    void flubberReceiver.stop();
    void settingsSnapshotBroadcaster.stop();
    void settingsSnapshotReceiver.stop();
    void universeLink.stop();
    void flubberParty.stop();
  });
  window.addEventListener("pagehide", () => {
    void flubberBroadcaster.stop();
    void flubberReceiver.stop();
    void settingsSnapshotBroadcaster.stop();
    void settingsSnapshotReceiver.stop();
    void universeLink.stop();
    void flubberParty.stop();
    void releaseBroadcastLatencyMode();
  }, { once: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible"
      && (flubberBroadcaster.snapshot().phase === "broadcasting" || universeLink.snapshot().enabled)) {
      void acquireBroadcastWakeLock();
    }
  });
}

function animationFrame(timestamp) {
  animationFrameOwner = undefined;
  animationFrameId = undefined;
  if (previousTimestamp === undefined) previousTimestamp = timestamp;
  const deltaSeconds = Math.min((timestamp - previousTimestamp) / 1000, MAX_DELTA_SECONDS);
  previousTimestamp = timestamp;

  // The explicit replay fixture uses the same browser foreground frame owner
  // as broadcasting. This catch-up pump prevents background timer clamping
  // from reducing a prerecorded 130 Hz qualification source to a slow trickle.
  if (polarReplay && polarSession.connected) polarSession.tick();

  updateContinuousInput(deltaSeconds);
  const touchMetric = touchTrace.update(timestamp, deltaSeconds);
  const incoming = liveRemoteSnapshot();
  const incomingOwnsAxes = liveRemoteOwnsAxes(incoming);
  applyLiveRemoteViewportPosition(incoming);
  const universe = universeLink.snapshot();
  if (touchTrackingActive() && !incomingOwnsAxes) {
    applyTouchTraceState(touchMetric);
  }
  if (incomingOwnsAxes) {
    state.targetX = incoming.latest.currentX;
    state.targetY = incoming.latest.currentY;
    state.currentX = incoming.latest.currentX;
    state.currentY = incoming.latest.currentY;
  } else if (universe.enabled) {
    if (touchTrackingActive() && state.touchFeedbackMode === TOUCH_FEEDBACK_GATED) {
      universeLocalCurrent = { currentX: state.targetX, currentY: state.targetY };
    } else {
      universeLocalCurrent.currentX = smoothToward(
        universeLocalCurrent.currentX,
        state.targetX,
        state.response,
        deltaSeconds,
      );
      universeLocalCurrent.currentY = smoothToward(
        universeLocalCurrent.currentY,
        state.targetY,
        state.response,
        deltaSeconds,
      );
    }
    universeLink.offer(universeLocalCurrent.currentX, universeLocalCurrent.currentY);
    const shared = universe.reciprocal
      ? combineUniverseCoordinates(universeLocalCurrent, universe.latest)
      : universeLocalCurrent;
    state.currentX = shared.currentX;
    state.currentY = shared.currentY;
  } else if (touchTrackingActive() && state.touchFeedbackMode === TOUCH_FEEDBACK_GATED) {
    // The bounded live gate velocity is already the smoothing layer. Rendering
    // it directly lets participants stop on the exact visible grid position.
    state.currentX = state.targetX;
    state.currentY = state.targetY;
  } else {
    state.currentX = smoothToward(state.currentX, state.targetX, state.response, deltaSeconds);
    state.currentY = smoothToward(state.currentY, state.targetY, state.response, deltaSeconds);
  }
  if (!universe.enabled) universeLocalCurrent = { currentX: state.currentX, currentY: state.currentY };

  // The floating foreground window has its own animation-frame clock. Keep
  // all transport rate limiting on the broadcaster's single monotonic clock.
  const viewportPosition = normalizedWidgetPosition();
  flubberBroadcaster.offerState(
    state.currentX,
    state.currentY,
    viewportPosition.viewportX,
    viewportPosition.viewportY,
  );

  const currentParameters = affectParameters(state.currentX, state.currentY);
  if (state.animationActive) {
    state.phase = (state.phase + deltaSeconds * Math.PI * 2 * currentParameters.frequency * state.visual.animationSpeed) % (Math.PI * 2);
  }

  const rendered = buildFlubberPath({
    profiles,
    offsets,
    x: state.currentX,
    y: state.currentY,
    phase: state.phase,
    palette: state.palette,
    amplitudeScale: state.visual.amplitudeScale,
    disorderScale: state.visual.disorderScale,
    baseShape: state.visual.baseShape,
    reducedMotion: reducedMotionQuery.matches,
  });
  elements.basePath.setAttribute("d", rendered.path);
  elements.outlinePath.setAttribute("d", rendered.path);
  elements.haloPath.setAttribute("d", rendered.path);
  elements.featureFlubberPath.setAttribute("d", rendered.path);
  elements.touchPreviewBasePath.setAttribute("d", rendered.path);
  elements.touchPreviewOutlinePath.setAttribute("d", rendered.path);
  elements.touchPreviewHaloPath.setAttribute("d", rendered.path);
  elements.mobileDirectBasePath.setAttribute("d", rendered.path);
  elements.mobileDirectOutlinePath.setAttribute("d", rendered.path);
  elements.mobileDirectHaloPath.setAttribute("d", rendered.path);
  elements.widget.style.setProperty("--affect-color", rendered.color);
  elements.touchPreviewFlubber.style.setProperty("--affect-color", rendered.color);
  elements.touchPreviewFlubber.style.opacity = state.widgetVisible ? state.widgetOpacity : 0;
  elements.mobileDirectFlubber.style.setProperty("--affect-color", rendered.color);
  elements.mobileDirectFlubber.style.opacity = state.widgetVisible ? state.widgetOpacity : 0;
  renderMobileFlubberPosition();
  renderPictureInPicture(rendered);
  renderPartyBirthVector(rendered);
  renderPartyFlubbers();
  updateCoordinateDisplay();
  updateFeatureSpace();
  renderTouchTrace(timestamp);

  if (experiment.phase !== "running" && (!document.hidden || pictureInPictureWindow)) {
    sampleAccumulator += deltaSeconds;
    if (sampleAccumulator >= SAMPLE_INTERVAL_SECONDS) {
      sampleAccumulator %= SAMPLE_INTERVAL_SECONDS;
      recordSample();
    }
  }

  scheduleAnimationFrame();
}

function initialize() {
  applyRetroTheme();
  updateAccordionPanelStates();
  initializePolarUi();
  updateModeControls();
  updateFeatureSpace();
  updateCustomizationControls();
  updatePictureInPictureSupport();
  updateExperimentSourceControls();
  constrainAndRenderWidget();
  initializeEvents();
  updateRemoteBroadcastUi();
  updateSettingsBroadcastUi();
  updateSettingsRadar();
  updateLiveReceiveUi();
  updateUniverseUi();
  updatePartyUi();
  updateLoggerDisplay();
  savePreferences();
  recordEvent("system", "session-start", "session", logger.sessionId);
  scheduleAnimationFrame();
}

document.addEventListener("keydown", (event) => {
  if (!captureInput) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.key === "Escape") {
    cancelBindingCapture();
    announce("Input assignment cancelled.");
    return;
  }
  finishBindingCapture(`key:${event.code}`);
}, true);

document.addEventListener("mousedown", (event) => {
  if (!captureInput) return;
  if (event.target === elements.bindingCaptureCancel) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  finishBindingCapture(`mouse:${mouseButtonName(event.button)}`);
}, true);

document.addEventListener("wheel", (event) => {
  if (!captureInput) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  finishBindingCapture(`wheel:${wheelDirection(event.deltaX, event.deltaY)}`);
}, { capture: true, passive: false });

document.addEventListener("contextmenu", (event) => {
  if (captureInput) event.preventDefault();
}, true);

initialize();
