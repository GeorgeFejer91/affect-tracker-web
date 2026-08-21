import {
  affectParameters,
  affectPaletteColor,
  buildFlubberPath,
  clamp,
  createProfiles,
  createProjectionOffsets,
  smoothToward,
} from "./math.js";
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
import {
  fitTracePoints,
  TOUCH_TRACE_ALGORITHM_VERSION,
  TouchTraceAnalyzer,
  TRACE_DURATION_MS,
} from "./touch-trace.js";
import { pictureInPictureOptions, pictureInPictureSupported } from "./picture-in-picture.js";
import {
  actionForBinding,
  ADVANCED_BINDING_LABELS,
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
} from "./portable-settings.js";

const STORAGE_KEY = "affect-tracker-web/preferences-v1";
const SAMPLE_INTERVAL_SECONDS = 1 / 20;
const MAX_DELTA_SECONDS = 0.05;
const FEATURE_FLUBBER_INSET_PERCENT = 7.5;
const FEATURE_DOT_INSET_PERCENT = 3;

const elements = {
  stage: document.querySelector("#stage"),
  widget: document.querySelector("#affect-widget"),
  basePath: document.querySelector("#base-path"),
  outlinePath: document.querySelector("#outline-path"),
  haloPath: document.querySelector("#halo-path"),
  panel: document.querySelector("#control-panel"),
  panelToggle: document.querySelector("#panel-toggle"),
  panelContent: document.querySelector("#panel-content"),
  toggleSymbol: document.querySelector(".toggle-symbol"),
  experimentPanel: document.querySelector("#experiment-panel"),
  experimentPanelToggle: document.querySelector("#experiment-panel-toggle"),
  experimentToggleSymbol: document.querySelector("#experiment-toggle-symbol"),
  touchPlaygroundPanel: document.querySelector("#touch-playground-panel"),
  touchPlaygroundPanelToggle: document.querySelector("#touch-playground-panel-toggle"),
  touchPlaygroundToggleSymbol: document.querySelector("#touch-playground-toggle-symbol"),
  valenceOutput: document.querySelector("#valence-output"),
  arousalOutput: document.querySelector("#arousal-output"),
  modeInputs: [...document.querySelectorAll("input[name='input-mode']")],
  touchTrackingToggle: document.querySelector("#touch-tracking-toggle"),
  touchPointerType: document.querySelector("#touch-pointer-type"),
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
  widgetSize: document.querySelector("#web-widget-size"),
  transparency: document.querySelector("#web-transparency"),
  transparencyOutput: document.querySelector("#web-transparency-output"),
  widgetVisibleButton: document.querySelector("#widget-visible-button"),
  dragToggleButton: document.querySelector("#drag-toggle-button"),
  settingsExportButton: document.querySelector("#settings-export-button"),
  settingsImportButton: document.querySelector("#settings-import-button"),
  settingsImportFile: document.querySelector("#settings-import-file"),
  customization: document.querySelector("#customization-editor"),
  lslStreamName: document.querySelector("#web-lsl-stream-name"),
  lslStreamType: document.querySelector("#web-lsl-stream-type"),
  lslMarkerName: document.querySelector("#web-lsl-marker-name"),
  lslSampleRate: document.querySelector("#web-lsl-sample-rate"),
  lslSourceId: document.querySelector("#web-lsl-source-id"),
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
      touchPlaygroundPanelOpen: typeof parsed.touchPlaygroundPanelOpen === "boolean" ? parsed.touchPlaygroundPanelOpen : false,
      inputSource: parsed.inputSource === "touch-trace" ? "touch-trace" : "manual",
      touchTraceFeedback: parsed.touchTraceFeedback === true,
      settings,
      seenIntro: true,
    };
  } catch {
    return {
      widgetX: bundledSettings.overlay.x + bundledSettings.overlay.size / 2,
      widgetY: bundledSettings.overlay.y + bundledSettings.overlay.size / 2,
      panelOpen: true,
      experimentPanelOpen: false,
      touchPlaygroundPanelOpen: false,
      inputSource: "manual",
      touchTraceFeedback: false,
      settings: structuredClone(bundledSettings),
      seenIntro: true,
    };
  }
}

const bundledSettings = await loadBundledSettings();
const preferences = readPreferences(bundledSettings);
const state = {
  currentX: 0,
  currentY: 0,
  targetX: 0,
  targetY: 0,
  inputMode: preferences.settings.inputMode,
  inputSource: preferences.inputSource,
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
  touchPlaygroundPanelOpen: preferences.touchPlaygroundPanelOpen,
  palette: preferences.settings.palette,
  lsl: preferences.settings.lsl,
  heldDirections: new Set(),
  phase: 0,
  dragging: false,
  touchTraceFeedback: preferences.touchTraceFeedback,
};
if (state.panelOpen) {
  state.experimentPanelOpen = false;
  state.touchPlaygroundPanelOpen = false;
} else if (state.experimentPanelOpen) {
  state.touchPlaygroundPanelOpen = false;
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
    algorithmVersion: state.inputSource === "touch-trace" ? TOUCH_TRACE_ALGORITHM_VERSION : "",
  };
}

const logger = new AffectLogger();
const touchTrace = new TouchTraceAnalyzer({ width: window.innerWidth, height: window.innerHeight });
const profiles = createProfiles();
let offsets = createProjectionOffsets(logger.sessionId, profiles.waveCount);
let previousTimestamp;
let sampleAccumulator = 0;
let dragOffsetX = 0;
let dragOffsetY = 0;
let featurePointerId;
let captureInput;
let pictureInPictureWindow;
let pictureInPictureView;
let animationFrameOwner;
let animationFrameId;
let activeTracePointerId;
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

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
    touchPlaygroundPanelOpen: state.touchPlaygroundPanelOpen,
    inputSource: state.inputSource,
    touchTraceFeedback: state.touchTraceFeedback,
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
  if (!experiment.writer || state.inputSource !== "touch-trace") return;
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
    traceFeedbackVisible: state.touchTraceFeedback,
  }, state);
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

function updateTouchPlaygroundPanelState() {
  elements.touchPlaygroundPanel.classList.toggle("is-collapsed", !state.touchPlaygroundPanelOpen);
  elements.touchPlaygroundPanelToggle.setAttribute("aria-expanded", String(state.touchPlaygroundPanelOpen));
  elements.touchPlaygroundToggleSymbol.textContent = state.touchPlaygroundPanelOpen ? "−" : "+";
}

function updateModeControls() {
  for (const input of elements.modeInputs) input.checked = input.value === state.inputMode;
}

function updateInputSourceControls() {
  const active = state.inputSource === "touch-trace";
  elements.touchTrackingToggle.checked = active;
  elements.touchTraceFeedbackToggle.checked = state.touchTraceFeedback;
  elements.touchTraceFeedbackToggle.disabled = !active;
  elements.touchPlaygroundSurface.classList.toggle("is-active", active);
  elements.touchPlaygroundPanel.classList.toggle("is-tracking", active);
  elements.touchTracePanel.hidden = !(active && state.touchTraceFeedback && state.widgetVisible);
  elements.featureSpace.setAttribute("aria-disabled", String(active));
  for (const button of elements.directionButtons) button.disabled = false;
  document.body.classList.toggle("is-touch-source", active);
  elements.experimentLayer.classList.toggle("is-touch-capture-active", active && experiment.phase !== "idle");
  elements.dragToggleButton.disabled = active || experiment.phase !== "idle";
  positionTracePanel();
}

function finishBindingCapture(value) {
  if (!captureInput) return;
  const action = captureInput.dataset.binding;
  const group = captureInput.dataset.bindingGroup === "advanced" ? "advancedBindings" : "bindings";
  const assignments = { ...state.bindings, ...state.advancedBindings };
  const conflict = Object.entries(assignments).find(([candidate, binding]) => candidate !== action && binding.toLowerCase() === value.toLowerCase());
  if (conflict) {
    captureInput.value = describeBinding(captureInput.dataset.bindingValue);
    captureInput.classList.remove("is-capturing");
    captureInput = undefined;
    announce(`That input is already assigned to ${BINDING_LABELS[conflict[0]] ?? ADVANCED_BINDING_LABELS[conflict[0]]}.`);
    return;
  }
  captureInput.dataset.bindingValue = value;
  captureInput.value = describeBinding(value);
  captureInput.classList.remove("is-capturing");
  state[group][captureInput.dataset.binding] = value;
  captureInput = undefined;
  createBindingInputs();
  savePreferences();
  recordEvent("settings", "binding-change", "input", value);
  announce(`Input assigned to ${describeBinding(value)}.`);
}

function beginBindingCapture(input) {
  if (captureInput && captureInput !== input) {
    captureInput.value = describeBinding(captureInput.dataset.bindingValue);
    captureInput.classList.remove("is-capturing");
  }
  captureInput = input;
  input.value = "Press, click, or scroll…";
  input.classList.add("is-capturing");
  announce("Waiting for a keyboard, mouse-button, or wheel input.");
}

function createBindingInputs() {
  elements.bindingGrid.replaceChildren();
  for (const [action, label] of Object.entries(BINDING_LABELS)) {
    const wrapper = document.createElement("label");
    wrapper.textContent = label;
    const input = document.createElement("input");
    input.readOnly = true;
    input.autocomplete = "off";
    input.dataset.binding = action;
    input.dataset.bindingGroup = "core";
    input.dataset.bindingValue = state.bindings[action];
    input.value = describeBinding(state.bindings[action]);
    input.addEventListener("click", () => beginBindingCapture(input));
    wrapper.append(input);
    elements.bindingGrid.append(wrapper);
  }

  elements.advancedBindingGrid.replaceChildren();
  for (const [action, label] of Object.entries(ADVANCED_BINDING_LABELS)) {
    const row = document.createElement("div");
    row.className = "advanced-binding-field";
    const wrapper = document.createElement("label");
    wrapper.textContent = label;
    const input = document.createElement("input");
    input.readOnly = true;
    input.autocomplete = "off";
    input.placeholder = "Unassigned";
    input.dataset.binding = action;
    input.dataset.bindingGroup = "advanced";
    input.dataset.bindingValue = state.advancedBindings[action] ?? "";
    input.value = input.dataset.bindingValue ? describeBinding(input.dataset.bindingValue) : "";
    input.addEventListener("click", () => beginBindingCapture(input));
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear";
    clear.disabled = !input.dataset.bindingValue;
    clear.addEventListener("click", () => {
      delete state.advancedBindings[action];
      savePreferences();
      createBindingInputs();
      recordEvent("settings", "advanced-binding-clear", action, "");
      announce(`${label} assignment cleared.`);
    });
    wrapper.append(input);
    row.append(wrapper, clear);
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
  elements.widgetSize.value = state.widgetSize;
  elements.transparency.value = opacityToTransparencyPercent(state.widgetOpacity);
  elements.transparencyOutput.value = `${elements.transparency.value}%`;
  elements.widgetVisibleButton.textContent = state.widgetVisible ? "Hide flubber" : "Show flubber";
  elements.dragToggleButton.textContent = state.widgetDragEnabled ? "Disable dragging" : "Enable dragging";
  elements.dragToggleButton.disabled = state.inputSource === "touch-trace" || experiment.phase !== "idle";
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
    `${state.inputSource === "touch-trace" ? "Experimental movement-responsive" : "Draggable"} affect shape. Valence ${state.currentX.toFixed(2)}, arousal ${state.currentY.toFixed(2)}.`,
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
  elements.featurePoint.style.left = `${coordinateToFeaturePercent(state.currentX, FEATURE_FLUBBER_INSET_PERCENT)}%`;
  elements.featurePoint.style.top = `${coordinateToFeaturePercent(-state.currentY, FEATURE_FLUBBER_INSET_PERCENT)}%`;
  elements.touchAffectPoint.style.left = `${coordinateToFeaturePercent(state.currentX, FEATURE_DOT_INSET_PERCENT)}%`;
  elements.touchAffectPoint.style.top = `${coordinateToFeaturePercent(-state.currentY, FEATURE_DOT_INSET_PERCENT)}%`;
  const currentColor = affectPaletteColor(state.currentX, state.currentY, state.palette);
  elements.featurePoint.style.setProperty("--preview-color", currentColor);
  elements.touchAffectPoint.style.background = currentColor;
  elements.featureValenceOutput.value = formatCoordinate(state.currentX);
  elements.featureArousalOutput.value = formatCoordinate(state.currentY);
  elements.touchAffectValenceOutput.value = formatCoordinate(state.currentX);
  elements.touchAffectArousalOutput.value = formatCoordinate(state.currentY);
  elements.touchAffectSpace.setAttribute(
    "aria-label",
    `Experimental movement mapping. Valence ${state.currentX.toFixed(2)}, arousal ${state.currentY.toFixed(2)}.`,
  );
  for (const input of elements.paletteInputs) input.value = state.palette[input.dataset.palette];
  elements.featureSpace.setAttribute("aria-valuetext", `Valence ${state.targetX.toFixed(2)}, arousal ${state.targetY.toFixed(2)}`);
}

function chooseFeatureCoordinate(event) {
  if (state.inputSource !== "manual") return;
  const bounds = elements.featureSpace.getBoundingClientRect();
  state.targetX = clamp(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -1, 1);
  state.targetY = clamp(1 - ((event.clientY - bounds.top) / bounds.height) * 2, -1, 1);
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
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = 2.25;
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
  const feedbackVisible = snapshot.motionActive || snapshot.feedbackHeld;
  const heldSuffix = !snapshot.motionActive && snapshot.feedbackHeld ? " · held" : "";
  const shapeLabel = feedbackVisible
    ? `${snapshot.mappedX < -0.15 ? "jagged" : snapshot.mappedX > 0.15 ? "round" : "neutral"}${heldSuffix}`
    : "inactive";
  const speedLabel = feedbackVisible
    ? `${snapshot.mappedY < -0.15 ? "slow" : snapshot.mappedY > 0.15 ? "fast" : "mid"}${heldSuffix}`
    : "still";
  const confidenceLabel = `${Math.round((snapshot.speedConfidence + snapshot.shapeConfidence) * 50)}%`;

  elements.touchPointerType.value = pointerType;
  elements.touchShapeOutput.value = shapeLabel;
  elements.touchSpeedOutput.value = speedLabel;
  elements.touchConfidenceOutput.value = confidenceLabel;
  elements.playgroundShapeOutput.value = shapeLabel;
  elements.playgroundSpeedOutput.value = speedLabel;
  elements.playgroundConfidenceOutput.value = confidenceLabel;

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
  const traceSize = state.inputSource === "touch-trace" && state.touchTraceFeedback && state.widgetVisible ? tracePanelDimensions() : undefined;
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
  if (experiment.phase === "idle" && state.inputSource === "touch-trace" && state.touchTraceFeedback) {
    const trace = tracePanelDimensions();
    const maximumY = window.innerHeight - trace.height - 12 - state.widgetSize / 2;
    state.widgetY = clamp(state.widgetY, state.widgetSize / 2, Math.max(state.widgetSize / 2, maximumY));
  }
  elements.widget.style.left = `${state.widgetX}px`;
  elements.widget.style.top = `${state.widgetY}px`;
  elements.widget.style.setProperty("--widget-size", `${renderedWidgetSize}px`);
  elements.widget.style.opacity = String(state.widgetOpacity);
  elements.widget.hidden = !state.widgetVisible || Boolean(pictureInPictureWindow);
  elements.widget.classList.toggle("is-drag-disabled", !state.widgetDragEnabled || state.inputSource === "touch-trace");
  positionTracePanel();
  if (pictureInPictureView) {
    pictureInPictureView.root.hidden = !state.widgetVisible;
    pictureInPictureView.root.style.opacity = String(state.widgetOpacity);
  }
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

function finishPictureInPicture(childWindow) {
  if (pictureInPictureWindow !== childWindow) return;
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
  announce("Floating Flubber closed and restored to the page.");
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
  } catch (error) {
    elements.pictureInPictureToggle.checked = false;
    pictureInPictureWindow = undefined;
    pictureInPictureView = undefined;
    constrainAndRenderWidget();
    announce(error?.name === "NotAllowedError"
      ? "The browser blocked Picture-in-Picture. Try the checkbox again."
      : `Picture-in-Picture could not open: ${error?.message ?? String(error)}`);
  }
}

function updatePictureInPictureSupport() {
  const supported = pictureInPictureSupported(window);
  elements.pictureInPictureToggle.disabled = !supported;
  elements.pictureInPictureNote.textContent = supported
    ? "The floating window stays above other apps while this page remains open. Its position is controlled by the browser."
    : "Interactive Picture-in-Picture is not supported by this browser. Use the desktop app for an always-on-top overlay.";
}

function resetAffect(source = "keyboard") {
  if (state.inputSource === "touch-trace") {
    recordEvent(source, "ignored-control", "reset", "touch-trace");
    announce("Reset was logged but movement remains in control while Experimental Touch/Trackpad is selected.");
    return;
  }
  state.targetX = 0;
  state.targetY = 0;
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
  updateInputSourceControls();
  updateExperimentSourceControls();
  constrainAndRenderWidget();
  savePreferences();
  recordEvent(source, "source-change", "input-source", inputSource);
  announce(inputSource === "touch-trace"
    ? "Experimental Touch/Trackpad control selected. Page movement now drives the affect display."
    : "Manual affect controls selected.");
}

function moveTarget(direction, source, amount = state.stepSize) {
  if (state.inputSource === "touch-trace") return;
  const next = applyStep(state.targetX, state.targetY, direction, amount);
  state.targetX = next.x;
  state.targetY = next.y;
  recordEvent(source, "step", direction, amount);
}

function updateContinuousInput(deltaSeconds) {
  if (state.inputSource !== "manual" || state.inputMode !== "continuous" || state.heldDirections.size === 0) return;
  const movement = continuousMovement(state.heldDirections, deltaSeconds, state.continuousSpeed);
  state.targetX = clamp(state.targetX + movement.x);
  state.targetY = clamp(state.targetY + movement.y);
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
  if (state.inputSource === "touch-trace" && action === "reset") {
    if (pressed) resetAffect(source);
    return true;
  }
  const direction = DIRECTION_BY_ACTION[action];
  if (direction) {
    if (state.inputSource === "touch-trace") {
      if (pressed) {
        recordEvent(source, "ignored-control", direction, "touch-trace");
        announce("Manual direction was logged but movement remains in control.");
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
    state.panelOpen = true;
    state.experimentPanelOpen = false;
    state.touchPlaygroundPanelOpen = false;
    elements.customization.open = true;
    updatePanelState();
    updateExperimentPanelState();
    updateTouchPlaygroundPanelState();
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
  if (targetIsEditable(event) || captureInput) return;
  const action = actionForBinding(state.bindings, `wheel:${wheelDirection(event.deltaX, event.deltaY)}`, state.advancedBindings);
  if (action) {
    event.preventDefault();
    applyBoundAction(action, true, "wheel", true);
    return;
  }
  if (state.inputSource === "touch-trace") return;
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

function handleDirectionPointerDown(event) {
  if (state.inputSource !== "manual" || state.inputMode !== "continuous") return;
  const button = event.currentTarget;
  const direction = button.dataset.direction;
  event.preventDefault();
  button.setPointerCapture(event.pointerId);
  button.classList.add("is-held");
  if (!state.heldDirections.has(direction)) {
    state.heldDirections.add(direction);
    recordEvent("button", "press", direction, true);
  }
}

function releaseDirectionButton(event) {
  const button = event.currentTarget;
  const direction = button.dataset.direction;
  button.classList.remove("is-held");
  if (state.inputMode === "continuous" && state.heldDirections.delete(direction)) {
    recordEvent("button", "release", direction, false);
  }
}

function handleDirectionClick(event) {
  if (state.inputSource === "touch-trace") {
    recordEvent("button", "ignored-control", event.currentTarget.dataset.direction, "touch-trace");
    announce("Manual direction was logged but movement remains in control.");
  } else if (state.inputMode === "step") {
    moveTarget(event.currentTarget.dataset.direction, "button");
  }
}

function handleDirectionButtonKeyDown(event) {
  if (state.inputSource !== "manual") return;
  if (state.inputMode !== "continuous" || (event.key !== " " && event.key !== "Enter")) return;
  event.preventDefault();
  const button = event.currentTarget;
  const direction = button.dataset.direction;
  button.classList.add("is-held");
  if (!state.heldDirections.has(direction)) {
    state.heldDirections.add(direction);
    recordEvent("button", "press", direction, true);
  }
}

function handleDirectionButtonKeyUp(event) {
  if (state.inputMode !== "continuous" || (event.key !== " " && event.key !== "Enter")) return;
  event.preventDefault();
  releaseDirectionButton(event);
}

function handleWidgetPointerDown(event) {
  if (event.button !== 0 || !state.widgetDragEnabled || state.inputSource === "touch-trace") return;
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
  recordEvent("pointer", "drag-complete", "widget", `${Math.round(state.widgetX)}:${Math.round(state.widgetY)}`);
}

function touchTraceTargetExcluded(target) {
  if (experiment.phase !== "idle") return false;
  if (target?.closest?.("#touch-playground-surface")) return false;
  return Boolean(target?.closest?.(".control-panel, .touch-trace-panel, button, input, select, textarea, [contenteditable='true']"));
}

function touchTraceCaptureEnabled(event) {
  if (state.inputSource !== "touch-trace" || captureInput || document.hidden) return false;
  if (experiment.phase === "running" && !experiment.playbackActive) return false;
  if (experiment.phase !== "idle" && experiment.phase !== "running") return false;
  return !touchTraceTargetExcluded(event.target);
}

function recordRawPointer(event, phase, coalescedIndex, result) {
  if (!experiment.writer || experiment.phase !== "running" || !experiment.playbackActive) return;
  const diagonal = Math.hypot(window.innerWidth, window.innerHeight);
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
    strokeId: touchTrace.strokeId,
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
    traceFeedbackVisible: state.touchTraceFeedback,
  }, state);
}

function ingestPointerEvent(event, phase) {
  if (!touchTraceCaptureEnabled(event)) return;
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
    if (phase === "cancel") touchTrace.beginStroke(event.pointerType);
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
  elements.experimentSourceNote.textContent = youtube
    ? "YouTube playback sends the requested video and normal embed metadata to YouTube. Recording remains local. Videos whose owners disable embedding cannot run here."
    : "The preloaded video and recording remain in this page. Physical key, mouse-button, and wheel identifiers—not typed text—are recorded locally during the experiment.";
  if (state.inputSource === "touch-trace") {
    elements.experimentSourceNote.textContent += " Experimental pointer trajectories, derived movement metrics, adaptive bounds, and displayed affect values will also be included in the local CSV.";
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
  const blob = new Blob([portableSettingsJson(settingsFromState())], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "affect-tracker-settings-v1.json";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  recordEvent("settings", "export", "json", 1);
  announce("Portable settings JSON exported.");
}

async function importSettings(file) {
  if (!file) return;
  if (file.size > 256 * 1024) throw new Error("Settings JSON must be smaller than 256 KB.");
  const imported = normalizePortableSettings(JSON.parse(await file.text()));
  applyPortableSettings(imported, true);
  recordEvent("settings", "import", "json", 1);
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
    state.panelOpen = !state.panelOpen;
    if (state.panelOpen) {
      state.experimentPanelOpen = false;
      state.touchPlaygroundPanelOpen = false;
      updateExperimentPanelState();
      updateTouchPlaygroundPanelState();
    }
    updatePanelState();
    savePreferences();
    recordEvent("panel", state.panelOpen ? "expand" : "collapse", "panel", state.panelOpen);
  });
  elements.experimentPanelToggle.addEventListener("click", () => {
    state.experimentPanelOpen = !state.experimentPanelOpen;
    if (state.experimentPanelOpen) {
      state.panelOpen = false;
      state.touchPlaygroundPanelOpen = false;
      updatePanelState();
      updateTouchPlaygroundPanelState();
    }
    updateExperimentPanelState();
    savePreferences();
    recordEvent("panel", state.experimentPanelOpen ? "expand" : "collapse", "experiment-panel", state.experimentPanelOpen);
  });
  elements.touchPlaygroundPanelToggle.addEventListener("click", () => {
    state.touchPlaygroundPanelOpen = !state.touchPlaygroundPanelOpen;
    if (state.touchPlaygroundPanelOpen) {
      state.panelOpen = false;
      state.experimentPanelOpen = false;
      updatePanelState();
      updateExperimentPanelState();
    }
    updateTouchPlaygroundPanelState();
    savePreferences();
    recordEvent(
      "panel",
      state.touchPlaygroundPanelOpen ? "expand" : "collapse",
      "touch-playground-panel",
      state.touchPlaygroundPanelOpen,
    );
  });

  for (const input of elements.modeInputs) {
    input.addEventListener("change", () => setMode(input.value));
  }
  elements.touchTrackingToggle.addEventListener("change", () => {
    setInputSource(elements.touchTrackingToggle.checked ? "touch-trace" : "manual", "playground");
  });
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
  elements.settingsExportButton.addEventListener("click", exportSettings);
  elements.settingsImportButton.addEventListener("click", () => elements.settingsImportFile.click());
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
  elements.featureSpace.addEventListener("pointerdown", (event) => {
    if (state.inputSource !== "manual") return;
    event.preventDefault();
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
    if (state.inputSource !== "manual") return;
    const direction = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, 0.05], ArrowDown: [0, -0.05] }[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    state.targetX = clamp(state.targetX + direction[0], -1, 1);
    state.targetY = clamp(state.targetY + direction[1], -1, 1);
    recordEvent("feature-space", "select-coordinate", event.key, `${state.targetX.toFixed(4)},${state.targetY.toFixed(4)}`);
  });

  for (const button of elements.directionButtons) {
    button.addEventListener("pointerdown", handleDirectionPointerDown);
    button.addEventListener("pointerup", releaseDirectionButton);
    button.addEventListener("pointercancel", releaseDirectionButton);
    button.addEventListener("lostpointercapture", releaseDirectionButton);
    button.addEventListener("click", handleDirectionClick);
    button.addEventListener("keydown", handleDirectionButtonKeyDown);
    button.addEventListener("keyup", handleDirectionButtonKeyUp);
    button.addEventListener("blur", releaseDirectionButton);
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
    touchTrace.beginStroke(touchTrace.pointerType);
    activeTracePointerId = undefined;
  });

  elements.widget.addEventListener("pointerdown", handleWidgetPointerDown);
  elements.widget.addEventListener("pointermove", handleWidgetPointerMove);
  elements.widget.addEventListener("pointerup", finishWidgetDrag);
  elements.widget.addEventListener("pointercancel", finishWidgetDrag);
}

function animationFrame(timestamp) {
  animationFrameOwner = undefined;
  animationFrameId = undefined;
  if (previousTimestamp === undefined) previousTimestamp = timestamp;
  const deltaSeconds = Math.min((timestamp - previousTimestamp) / 1000, MAX_DELTA_SECONDS);
  previousTimestamp = timestamp;

  updateContinuousInput(deltaSeconds);
  const touchMetric = touchTrace.update(timestamp, deltaSeconds);
  if (state.inputSource === "touch-trace") {
    state.targetX = clamp(touchMetric.targetX);
    state.targetY = clamp(touchMetric.targetY);
  }
  state.currentX = smoothToward(state.currentX, state.targetX, state.response, deltaSeconds);
  state.currentY = smoothToward(state.currentY, state.targetY, state.response, deltaSeconds);

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
    reducedMotion: reducedMotionQuery.matches,
  });
  elements.basePath.setAttribute("d", rendered.path);
  elements.outlinePath.setAttribute("d", rendered.path);
  elements.haloPath.setAttribute("d", rendered.path);
  elements.featureFlubberPath.setAttribute("d", rendered.path);
  elements.widget.style.setProperty("--affect-color", rendered.color);
  renderPictureInPicture(rendered);
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
  updatePanelState();
  updateExperimentPanelState();
  updateTouchPlaygroundPanelState();
  updateModeControls();
  updateFeatureSpace();
  updateCustomizationControls();
  updatePictureInPictureSupport();
  updateExperimentSourceControls();
  constrainAndRenderWidget();
  initializeEvents();
  updateLoggerDisplay();
  savePreferences();
  recordEvent("system", "session-start", "session", logger.sessionId);
  scheduleAnimationFrame();
}

document.addEventListener("keydown", (event) => {
  if (!captureInput) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  finishBindingCapture(`key:${event.code}`);
}, true);

document.addEventListener("mousedown", (event) => {
  if (!captureInput) return;
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
