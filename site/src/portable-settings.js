import { clamp, DEFAULT_AFFECT_PALETTE } from "./math.js";

export const SETTINGS_VERSION = 1;

export const BINDING_LABELS = Object.freeze({
  increaseValence: "Increase valence",
  decreaseValence: "Decrease valence",
  increaseArousal: "Increase arousal",
  decreaseArousal: "Decrease arousal",
  reset: "Reset to neutral",
  togglePause: "Pause or resume",
  showSettings: "Show settings",
  toggleOverlayEditing: "Toggle flubber dragging",
});

export const DIRECTION_BY_ACTION = Object.freeze({
  increaseValence: "right",
  decreaseValence: "left",
  increaseArousal: "up",
  decreaseArousal: "down",
});

export const DEFAULT_PORTABLE_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  inputMode: "continuous",
  stepSize: 0.1,
  continuousSpeed: 0.8,
  response: 8,
  bindings: Object.freeze({
    increaseValence: "key:ArrowRight",
    decreaseValence: "key:ArrowLeft",
    increaseArousal: "key:ArrowUp",
    decreaseArousal: "key:ArrowDown",
    reset: "key:KeyR",
    togglePause: "key:Space",
    showSettings: "key:F10",
    toggleOverlayEditing: "key:F9",
  }),
  palette: DEFAULT_AFFECT_PALETTE,
  overlay: Object.freeze({ x: 120, y: 120, size: 240, opacity: 0.95, visible: true }),
  lsl: Object.freeze({
    streamName: "AffectTracker",
    streamType: "Affect",
    markerName: "AffectTrackerMarkers",
    sampleRate: 50,
    sourceId: "affect-tracker-desktop",
  }),
});

function assertNumber(value, label, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function assertText(value, label, maximum) {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} is empty or too long.`);
  }
  return value.trim();
}

function validBinding(value) {
  if (typeof value !== "string") return false;
  const [kind, control, extra] = value.split(":");
  if (extra !== undefined || !control || control.length > 40) return false;
  if (kind === "key") return /^[a-z0-9]+$/i.test(control);
  if (kind === "mouse") return /^(left|right|middle|button4|button5)$/i.test(control);
  if (kind === "wheel") return /^(up|down|left|right)$/i.test(control);
  return false;
}

function normalizedBindings(value) {
  if (!value || typeof value !== "object") throw new Error("Settings bindings are missing.");
  const bindings = {};
  const unique = new Set();
  for (const action of Object.keys(BINDING_LABELS)) {
    const binding = value[action];
    if (!validBinding(binding)) throw new Error(`The ${BINDING_LABELS[action]} binding is invalid.`);
    const normalized = binding.toLowerCase();
    if (unique.has(normalized)) throw new Error("Every input assignment must be unique.");
    unique.add(normalized);
    bindings[action] = binding;
  }
  return bindings;
}

function normalizedPalette(value) {
  if (!value || typeof value !== "object") throw new Error("The four-color palette is missing.");
  const palette = {};
  for (const name of ["up", "down", "left", "right"]) {
    if (!/^#[\da-f]{6}$/i.test(value[name] ?? "")) throw new Error(`Palette color ${name} must use six-digit hex notation.`);
    palette[name] = value[name].toLowerCase();
  }
  return palette;
}

export function cloneDefaultSettings() {
  return structuredClone(DEFAULT_PORTABLE_SETTINGS);
}

export function normalizePortableSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Settings JSON must contain one object.");
  if (value.version !== SETTINGS_VERSION) throw new Error(`Only settings version ${SETTINGS_VERSION} is supported.`);
  if (value.inputMode !== "continuous" && value.inputMode !== "step") throw new Error("Input mode must be continuous or step.");
  const overlay = value.overlay ?? {};
  const lsl = value.lsl ?? {};
  if (typeof overlay.visible !== "boolean") throw new Error("Overlay visibility must be true or false.");
  return {
    version: SETTINGS_VERSION,
    inputMode: value.inputMode,
    stepSize: assertNumber(value.stepSize, "Step size", 0.01, 1),
    continuousSpeed: assertNumber(value.continuousSpeed, "Continuous speed", 0.05, 4),
    response: assertNumber(value.response, "Smoothing response", 0.1, 30),
    bindings: normalizedBindings(value.bindings),
    palette: normalizedPalette(value.palette),
    overlay: {
      x: Math.round(assertNumber(overlay.x, "Overlay X", -100000, 100000)),
      y: Math.round(assertNumber(overlay.y, "Overlay Y", -100000, 100000)),
      size: Math.round(assertNumber(overlay.size, "Overlay size", 120, 640)),
      opacity: assertNumber(overlay.opacity, "Flubber opacity", 0, 1),
      visible: overlay.visible,
    },
    lsl: {
      streamName: assertText(lsl.streamName, "LSL stream name", 80),
      streamType: assertText(lsl.streamType, "LSL stream type", 80),
      markerName: assertText(lsl.markerName, "LSL marker name", 80),
      sampleRate: Math.round(assertNumber(lsl.sampleRate, "LSL sample rate", 1, 240)),
      sourceId: assertText(lsl.sourceId, "LSL source ID", 120),
    },
  };
}

export function portableSettingsJson(value) {
  return `${JSON.stringify(normalizePortableSettings(value), null, 2)}\n`;
}

export function actionForBinding(bindings, token) {
  const normalized = token.toLowerCase();
  return Object.entries(bindings).find(([, binding]) => binding.toLowerCase() === normalized)?.[0] ?? null;
}

export function describeBinding(value) {
  const [kind, control = ""] = value.split(":");
  if (kind === "key") return `Keyboard · ${control.replace(/^Key/, "")}`;
  if (kind === "mouse") return `Mouse · ${control}`;
  if (kind === "wheel") return `Scroll · ${control}`;
  return value;
}

export function mouseButtonName(button) {
  return ["Left", "Middle", "Right", "Button4", "Button5"][button] ?? `Button${button + 1}`;
}

export function wheelDirection(deltaX, deltaY) {
  const horizontal = Math.abs(deltaX) > Math.abs(deltaY);
  return horizontal ? (deltaX < 0 ? "Left" : "Right") : (deltaY < 0 ? "Up" : "Down");
}

export function transparencyPercentToOpacity(value) {
  return 1 - clamp(Number(value) / 100, 0, 1);
}

export function opacityToTransparencyPercent(value) {
  return Math.round((1 - clamp(Number(value), 0, 1)) * 100);
}
