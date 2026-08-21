import {
  affectParameters,
  affectPaletteColor,
  buildFlubberPath,
  clamp,
  createProfiles,
  createProjectionOffsets,
  DEFAULT_AFFECT_PALETTE,
  smoothToward,
} from "./math.js";
import {
  applyStep,
  constrainWidgetPosition,
  continuousMovement,
  directionForKey,
  isNativeFormControl,
  normalizeWheel,
} from "./input.js";
import { AffectLogger } from "./logger.js";

const STORAGE_KEY = "affect-tracker-web/preferences-v1";
const SAMPLE_INTERVAL_SECONDS = 1 / 20;
const MAX_DELTA_SECONDS = 0.05;
const RESPONSE = 8;
const CONTINUOUS_SPEED = 0.8;
const STEP_SIZE = 0.1;

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
};

function validPalette(value) {
  return value && ["up", "down", "left", "right"].every((name) => /^#[\da-f]{6}$/i.test(value[name] ?? ""));
}

function readPreferences() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") ?? {};
    return {
      widgetX: Number.isFinite(parsed.widgetX) ? parsed.widgetX : window.innerWidth / 2,
      widgetY: Number.isFinite(parsed.widgetY) ? parsed.widgetY : window.innerHeight / 2,
      widgetSize: Number.isFinite(parsed.widgetSize) ? clamp(parsed.widgetSize, 120, 320) : 180,
      inputMode: parsed.inputMode === "step" ? "step" : "continuous",
      panelOpen: typeof parsed.panelOpen === "boolean" ? parsed.panelOpen : !parsed.seenIntro,
      palette: validPalette(parsed.palette) ? parsed.palette : { ...DEFAULT_AFFECT_PALETTE },
      seenIntro: true,
    };
  } catch {
    return {
      widgetX: window.innerWidth / 2,
      widgetY: window.innerHeight / 2,
      widgetSize: 180,
      inputMode: "continuous",
      panelOpen: true,
      palette: { ...DEFAULT_AFFECT_PALETTE },
      seenIntro: true,
    };
  }
}

const preferences = readPreferences();
const state = {
  currentX: 0,
  currentY: 0,
  targetX: 0,
  targetY: 0,
  inputMode: preferences.inputMode,
  animationActive: true,
  widgetX: preferences.widgetX,
  widgetY: preferences.widgetY,
  widgetSize: preferences.widgetSize,
  panelOpen: preferences.panelOpen,
  palette: preferences.palette,
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
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

function savePreferences() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    widgetX: state.widgetX,
    widgetY: state.widgetY,
    widgetSize: state.widgetSize,
    inputMode: state.inputMode,
    panelOpen: state.panelOpen,
    palette: state.palette,
    seenIntro: true,
  }));
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

function formatCoordinate(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function updateCoordinateDisplay() {
  elements.valenceOutput.textContent = formatCoordinate(state.currentX);
  elements.arousalOutput.textContent = formatCoordinate(state.currentY);
  elements.widget.setAttribute(
    "aria-label",
    `Draggable affect shape. Valence ${state.currentX.toFixed(2)}, arousal ${state.currentY.toFixed(2)}. Use arrow keys or WASD to adjust.`,
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

function moveTarget(direction, source, amount = STEP_SIZE) {
  const next = applyStep(state.targetX, state.targetY, direction, amount);
  state.targetX = next.x;
  state.targetY = next.y;
  recordEvent(source, "step", direction, amount);
}

function updateContinuousInput(deltaSeconds) {
  if (state.inputMode !== "continuous" || state.heldDirections.size === 0) return;
  const movement = continuousMovement(state.heldDirections, deltaSeconds, CONTINUOUS_SPEED);
  state.targetX = clamp(state.targetX + movement.x);
  state.targetY = clamp(state.targetY + movement.y);
}

function clearHeldButtonStyles() {
  for (const button of elements.directionButtons) button.classList.remove("is-held");
}

function targetIsEditable(event) {
  return isNativeFormControl(event.target);
}

function handleGlobalKeyDown(event) {
  if (targetIsEditable(event)) return;
  const direction = directionForKey(event.key);
  if (direction) {
    event.preventDefault();
    if (state.inputMode === "step") {
      if (!event.repeat) moveTarget(direction, "keyboard");
      return;
    }
    if (!state.heldDirections.has(direction)) {
      state.heldDirections.add(direction);
      recordEvent("keyboard", "press", direction, true);
    }
    return;
  }

  if (event.key === " ") {
    event.preventDefault();
    if (!event.repeat) toggleAnimation("keyboard");
  } else if (event.key === "r" || event.key === "R") {
    event.preventDefault();
    if (!event.repeat) resetAffect("keyboard");
  }
}

function handleGlobalKeyUp(event) {
  if (targetIsEditable(event) || state.inputMode !== "continuous") return;
  const direction = directionForKey(event.key);
  if (direction && state.heldDirections.delete(direction)) {
    event.preventDefault();
    recordEvent("keyboard", "release", direction, false);
  }
}

function handleWheel(event) {
  if (targetIsEditable(event)) return;
  event.preventDefault();
  const amount = normalizeWheel(event.deltaY);
  if (event.shiftKey) state.targetX = clamp(state.targetX + amount);
  else state.targetY = clamp(state.targetY + amount);
  recordEvent("wheel", "move", event.shiftKey ? "valence" : "arousal", amount);
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
  if (event.button !== 0) return;
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
  if (previousTimestamp === undefined) previousTimestamp = timestamp;
  const deltaSeconds = Math.min((timestamp - previousTimestamp) / 1000, MAX_DELTA_SECONDS);
  previousTimestamp = timestamp;

  updateContinuousInput(deltaSeconds);
  state.currentX = smoothToward(state.currentX, state.targetX, RESPONSE, deltaSeconds);
  state.currentY = smoothToward(state.currentY, state.targetY, RESPONSE, deltaSeconds);

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
  updateCoordinateDisplay();
  updateFeatureSpace();

  if (!document.hidden) {
    sampleAccumulator += deltaSeconds;
    if (sampleAccumulator >= SAMPLE_INTERVAL_SECONDS) {
      sampleAccumulator %= SAMPLE_INTERVAL_SECONDS;
      recordSample();
    }
  }

  requestAnimationFrame(animationFrame);
}

function initialize() {
  updatePanelState();
  updateModeControls();
  updateFeatureSpace();
  constrainAndRenderWidget();
  initializeEvents();
  updateLoggerDisplay();
  savePreferences();
  recordEvent("system", "session-start", "session", logger.sessionId);
  requestAnimationFrame(animationFrame);
}

initialize();
