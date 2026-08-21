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
import { AffectLogger } from "./logger.js";
import { pictureInPictureSupported, pictureInPictureWindowSize } from "./picture-in-picture.js";
import {
  actionForBinding,
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
  valenceOutput: document.querySelector("#valence-output"),
  arousalOutput: document.querySelector("#arousal-output"),
  modeInputs: [...document.querySelectorAll("input[name='input-mode']")],
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
  paletteInputs: [...document.querySelectorAll("[data-palette]")],
  bindingGrid: document.querySelector("#web-binding-grid"),
  stepSize: document.querySelector("#web-step-size"),
  continuousSpeed: document.querySelector("#web-continuous-speed"),
  response: document.querySelector("#web-response"),
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
      settings,
      seenIntro: true,
    };
  } catch {
    return {
      widgetX: bundledSettings.overlay.x + bundledSettings.overlay.size / 2,
      widgetY: bundledSettings.overlay.y + bundledSettings.overlay.size / 2,
      panelOpen: true,
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
  stepSize: preferences.settings.stepSize,
  continuousSpeed: preferences.settings.continuousSpeed,
  response: preferences.settings.response,
  bindings: preferences.settings.bindings,
  animationActive: true,
  widgetX: preferences.widgetX,
  widgetY: preferences.widgetY,
  widgetSize: preferences.settings.overlay.size,
  widgetOpacity: preferences.settings.overlay.opacity,
  widgetVisible: preferences.settings.overlay.visible,
  widgetDragEnabled: true,
  panelOpen: preferences.panelOpen,
  palette: preferences.settings.palette,
  lsl: preferences.settings.lsl,
  heldDirections: new Set(),
  phase: 0,
  dragging: false,
};

const logger = new AffectLogger();
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
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

function savePreferences() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    widgetX: state.widgetX,
    widgetY: state.widgetY,
    panelOpen: state.panelOpen,
    settings: settingsFromState(),
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

function recordEvent(source, action, control = "", value = "") {
  logger.record("event", { source, action, control, value }, state);
  updateLoggerDisplay();
}

function recordSample() {
  logger.record("sample", { source: "timer", action: "sample" }, state);
  updateLoggerDisplay();
}

function updateLoggerDisplay() {
  elements.eventCount.textContent = logger.eventCount.toLocaleString();
  elements.sampleCount.textContent = logger.sampleCount.toLocaleString();
  elements.bufferCount.textContent = `${logger.buffer.length.toLocaleString()} / ${logger.buffer.capacity.toLocaleString()}`;
}

function updatePanelState() {
  elements.panel.classList.toggle("is-collapsed", !state.panelOpen);
  elements.panelToggle.setAttribute("aria-expanded", String(state.panelOpen));
  elements.toggleSymbol.textContent = state.panelOpen ? "−" : "+";
}

function updateModeControls() {
  for (const input of elements.modeInputs) input.checked = input.value === state.inputMode;
}

function finishBindingCapture(value) {
  if (!captureInput) return;
  const action = captureInput.dataset.binding;
  const conflict = Object.entries(state.bindings).find(([candidate, binding]) => candidate !== action && binding.toLowerCase() === value.toLowerCase());
  if (conflict) {
    captureInput.value = describeBinding(captureInput.dataset.bindingValue);
    captureInput.classList.remove("is-capturing");
    captureInput = undefined;
    announce(`That input is already assigned to ${BINDING_LABELS[conflict[0]]}.`);
    return;
  }
  captureInput.dataset.bindingValue = value;
  captureInput.value = describeBinding(value);
  captureInput.classList.remove("is-capturing");
  state.bindings[captureInput.dataset.binding] = value;
  captureInput = undefined;
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
    input.dataset.bindingValue = state.bindings[action];
    input.value = describeBinding(state.bindings[action]);
    input.addEventListener("click", () => beginBindingCapture(input));
    wrapper.append(input);
    elements.bindingGrid.append(wrapper);
  }
}

function updateCustomizationControls() {
  elements.stepSize.value = state.stepSize;
  elements.continuousSpeed.value = state.continuousSpeed;
  elements.response.value = state.response;
  elements.widgetSize.value = state.widgetSize;
  elements.transparency.value = opacityToTransparencyPercent(state.widgetOpacity);
  elements.transparencyOutput.value = `${elements.transparency.value}%`;
  elements.widgetVisibleButton.textContent = state.widgetVisible ? "Hide flubber" : "Show flubber";
  elements.dragToggleButton.textContent = state.widgetDragEnabled ? "Disable dragging" : "Enable dragging";
  elements.lslStreamName.value = state.lsl.streamName;
  elements.lslStreamType.value = state.lsl.streamType;
  elements.lslMarkerName.value = state.lsl.markerName;
  elements.lslSampleRate.value = state.lsl.sampleRate;
  elements.lslSourceId.value = state.lsl.sourceId;
  createBindingInputs();
}

function applyPortableSettings(value, applyPosition = true) {
  const normalized = normalizePortableSettings(value);
  state.inputMode = normalized.inputMode;
  state.stepSize = normalized.stepSize;
  state.continuousSpeed = normalized.continuousSpeed;
  state.response = normalized.response;
  state.bindings = normalized.bindings;
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
    `Draggable affect shape. Valence ${state.currentX.toFixed(2)}, arousal ${state.currentY.toFixed(2)}. Use the configured controls to adjust.`,
  );
}

function updateFeatureSpace() {
  for (const [name, color] of Object.entries(state.palette)) elements.featureSpace.style.setProperty(`--palette-${name}`, color);
  const paletteKey = JSON.stringify(state.palette);
  if (elements.featureCanvas.dataset.palette !== paletteKey) {
    const context = elements.featureCanvas.getContext("2d");
    const image = context.createImageData(elements.featureCanvas.width, elements.featureCanvas.height);
    for (let py = 0; py < elements.featureCanvas.height; py += 1) {
      for (let px = 0; px < elements.featureCanvas.width; px += 1) {
        const color = affectPaletteColor(px / (elements.featureCanvas.width - 1) * 2 - 1, 1 - py / (elements.featureCanvas.height - 1) * 2, state.palette);
        const [red, green, blue] = color.match(/\d+/g).map(Number);
        const offset = (py * elements.featureCanvas.width + px) * 4;
        image.data.set([red, green, blue, 255], offset);
      }
    }
    context.putImageData(image, 0, 0);
    elements.featureCanvas.dataset.palette = paletteKey;
  }
  elements.featurePoint.style.left = `${(state.currentX + 1) * 50}%`;
  elements.featurePoint.style.top = `${(1 - state.currentY) * 50}%`;
  for (const input of elements.paletteInputs) input.value = state.palette[input.dataset.palette];
  elements.featureSpace.setAttribute("aria-valuetext", `Valence ${state.targetX.toFixed(2)}, arousal ${state.targetY.toFixed(2)}`);
}

function chooseFeatureCoordinate(event) {
  const bounds = elements.featureSpace.getBoundingClientRect();
  state.targetX = clamp(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -1, 1);
  state.targetY = clamp(1 - ((event.clientY - bounds.top) / bounds.height) * 2, -1, 1);
}

function constrainAndRenderWidget() {
  const constrained = constrainWidgetPosition(
    state.widgetX,
    state.widgetY,
    state.widgetSize,
    window.innerWidth,
    window.innerHeight,
  );
  state.widgetX = constrained.x;
  state.widgetY = constrained.y;
  elements.widget.style.left = `${state.widgetX}px`;
  elements.widget.style.top = `${state.widgetY}px`;
  elements.widget.style.setProperty("--widget-size", `${state.widgetSize}px`);
  elements.widget.style.opacity = String(state.widgetOpacity);
  elements.widget.hidden = !state.widgetVisible || Boolean(pictureInPictureWindow);
  elements.widget.classList.toggle("is-drag-disabled", !state.widgetDragEnabled);
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
    const size = pictureInPictureWindowSize(state.widgetSize);
    const childWindow = await window.documentPictureInPicture.requestWindow({ width: size, height: size });
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
    root.focus();
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

function moveTarget(direction, source, amount = state.stepSize) {
  const next = applyStep(state.targetX, state.targetY, direction, amount);
  state.targetX = next.x;
  state.targetY = next.y;
  recordEvent(source, "step", direction, amount);
}

function updateContinuousInput(deltaSeconds) {
  if (state.inputMode !== "continuous" || state.heldDirections.size === 0) return;
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

function applyBoundAction(action, pressed, source, impulse = false) {
  const direction = DIRECTION_BY_ACTION[action];
  if (direction) {
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
    elements.customization.open = true;
    updatePanelState();
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
  const action = actionForBinding(state.bindings, `key:${event.code}`);
  if (action) {
    event.preventDefault();
    if (!event.repeat) applyBoundAction(action, true, "keyboard");
  }
}

function handleGlobalKeyUp(event) {
  if (targetIsEditable(event) || captureInput) return;
  const action = actionForBinding(state.bindings, `key:${event.code}`);
  if (action) {
    event.preventDefault();
    applyBoundAction(action, false, "keyboard");
  }
}

function handleWheel(event) {
  if (targetIsEditable(event) || captureInput) return;
  event.preventDefault();
  const action = actionForBinding(state.bindings, `wheel:${wheelDirection(event.deltaX, event.deltaY)}`);
  if (action) {
    applyBoundAction(action, true, "wheel", true);
    return;
  }
  // Keep the original browser gesture as a fallback when no wheel direction is explicitly assigned.
  const amount = normalizeWheel(event.deltaY);
  if (event.shiftKey) state.targetX = clamp(state.targetX + amount);
  else state.targetY = clamp(state.targetY + amount);
  recordEvent("wheel", "move", event.shiftKey ? "valence" : "arousal", amount);
}

function handleGlobalMouseDown(event) {
  if (targetIsEditable(event) || captureInput || elements.widget.contains(event.target)) return;
  const action = actionForBinding(state.bindings, `mouse:${mouseButtonName(event.button)}`);
  if (action) applyBoundAction(action, true, "mouse");
}

function handleGlobalMouseUp(event) {
  if (captureInput) return;
  const action = actionForBinding(state.bindings, `mouse:${mouseButtonName(event.button)}`);
  if (action) applyBoundAction(action, false, "mouse");
}

function handleDirectionPointerDown(event) {
  if (state.inputMode !== "continuous") return;
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
  if (state.inputMode === "step") {
    moveTarget(event.currentTarget.dataset.direction, "button");
  }
}

function handleDirectionButtonKeyDown(event) {
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
  if (event.button !== 0 || !state.widgetDragEnabled) return;
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

function exportLog() {
  recordEvent("panel", "export", "csv", logger.buffer.length);
  const blob = new Blob([logger.exportCsv()], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  anchor.href = url;
  anchor.download = `affect-tracker-${logger.sessionId}-${timestamp}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  announce(`CSV exported with ${logger.buffer.length.toLocaleString()} records.`);
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
  window.addEventListener("keydown", handleGlobalKeyDown);
  window.addEventListener("keyup", handleGlobalKeyUp);
  window.addEventListener("mousedown", handleGlobalMouseDown);
  window.addEventListener("mouseup", handleGlobalMouseUp);
  window.addEventListener("wheel", handleWheel, { passive: false });
  window.addEventListener("resize", () => {
    constrainAndRenderWidget();
    savePreferences();
  });
  window.addEventListener("blur", () => {
    state.heldDirections.clear();
    clearHeldButtonStyles();
  });

  elements.panelToggle.addEventListener("click", () => {
    state.panelOpen = !state.panelOpen;
    updatePanelState();
    savePreferences();
    recordEvent("panel", state.panelOpen ? "expand" : "collapse", "panel", state.panelOpen);
  });

  for (const input of elements.modeInputs) {
    input.addEventListener("change", () => setMode(input.value));
  }
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
    featurePointerId = event.pointerId;
    elements.featureSpace.setPointerCapture(event.pointerId);
    chooseFeatureCoordinate(event);
  });
  elements.featureSpace.addEventListener("pointermove", (event) => {
    if (event.pointerId === featurePointerId) chooseFeatureCoordinate(event);
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
  state.currentX = smoothToward(state.currentX, state.targetX, state.response, deltaSeconds);
  state.currentY = smoothToward(state.currentY, state.targetY, state.response, deltaSeconds);

  const currentParameters = affectParameters(state.currentX, state.currentY);
  if (state.animationActive) {
    state.phase = (state.phase + deltaSeconds * Math.PI * 2 * currentParameters.frequency) % (Math.PI * 2);
  }

  const rendered = buildFlubberPath({
    profiles,
    offsets,
    x: state.currentX,
    y: state.currentY,
    phase: state.phase,
    palette: state.palette,
    reducedMotion: reducedMotionQuery.matches,
  });
  elements.basePath.setAttribute("d", rendered.path);
  elements.outlinePath.setAttribute("d", rendered.path);
  elements.haloPath.setAttribute("d", rendered.path);
  elements.widget.style.setProperty("--affect-color", rendered.color);
  renderPictureInPicture(rendered);
  updateCoordinateDisplay();
  updateFeatureSpace();

  if (!document.hidden || pictureInPictureWindow) {
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
  updateModeControls();
  updateFeatureSpace();
  updateCustomizationControls();
  updatePictureInPictureSupport();
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
