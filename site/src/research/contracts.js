import { canonicalJson, canonicalSha256 } from "./canonical.js";
import {
  FLUBBER_MAPPING_SPECS,
  createDefaultFlubberMappings,
  validateFlubberMapping,
} from "./mappings.js";
import { createSessionStem } from "./identity.js";

export const RESEARCH_SETTINGS_SCHEMA = "affect-research-settings";
export const RESOLVED_ASSIGNMENT_PLAN_SCHEMA = "affect-research-assignment-plan";
export const INPUT_BINDING_SCHEMA = "affect-research-input-binding";
export const RESEARCH_SAMPLE_SCHEMA = "affect-research-sample";
export const RESEARCH_EVENT_SCHEMA = "affect-research-event";
export const RESEARCH_RUN_MANIFEST_SCHEMA = "affect-research-run-manifest";
export const RESEARCH_NAMESPACE = "affect-research/v1";
export const BALANCED_ALGORITHM_VERSION = "balanced-v1";
export const CONDITION_ORDER_METHODS = Object.freeze(["williams", "cyclic"]);
export const STIMULUS_SOURCE_KINDS = Object.freeze(["workspaceFile", "repositoryAsset", "youtube"]);

export const PARTICIPANT_STATUS_LABELS = Object.freeze({
  available: "Available",
  active: "Active",
  partial: "Partial",
  complete: "Complete",
});

export const INPUT_PRESET_IDS = Object.freeze([
  "arrowKeys",
  "wasd",
  "ijkl",
  "numpad",
  "pointerGrid",
  "mouseButtonsWheel",
  "gamepadDpad",
  "gamepadLeftStick",
  "gamepadRightStick",
]);

const DIGITAL_DIRECTIONS = Object.freeze(["up", "down", "left", "right"]);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const PARTICIPANT_PATTERN = /^P\d{3,6}$/u;
const HEX_COLOR = /^#[a-f0-9]{6}$/iu;
const MONOTONIC_NS = /^(0|[1-9]\d{0,29})$/u;
const SAFE_CODE = /^[a-z0-9][a-z0-9_.:-]{0,127}$/iu;
const MAX_PARTICIPANTS = 100_000;
const MAX_STIMULI = 10_000;
const MAX_POOLS = 256;
const lexical = (left, right) => left < right ? -1 : left > right ? 1 : 0;

const keyboard = (code) => Object.freeze({ kind: "keyboard", code });
const mouseButton = (button) => Object.freeze({ kind: "mouseButton", button });
const wheel = (direction) => Object.freeze({ kind: "wheel", direction });
const gamepadButton = (button) => Object.freeze({ kind: "gamepadButton", button });
const pointerAxis = (axis, invert = false) => Object.freeze({ kind: "pointerAxis", axis, invert });
const gamepadAxis = (index, invert = false) => Object.freeze({ kind: "gamepadAxis", index, invert });

const directions = (up, down, left, right) => Object.freeze({ up, down, left, right });
const axes = (x, y) => Object.freeze({ x, y });

export const INPUT_PRESETS = Object.freeze({
  arrowKeys: Object.freeze({
    label: "Arrow keys",
    kind: "digital",
    directions: directions(keyboard("ArrowUp"), keyboard("ArrowDown"), keyboard("ArrowLeft"), keyboard("ArrowRight")),
  }),
  wasd: Object.freeze({
    label: "WASD",
    kind: "digital",
    directions: directions(keyboard("KeyW"), keyboard("KeyS"), keyboard("KeyA"), keyboard("KeyD")),
  }),
  ijkl: Object.freeze({
    label: "IJKL",
    kind: "digital",
    directions: directions(keyboard("KeyI"), keyboard("KeyK"), keyboard("KeyJ"), keyboard("KeyL")),
  }),
  numpad: Object.freeze({
    label: "Numeric keypad",
    kind: "digital",
    directions: directions(keyboard("Numpad8"), keyboard("Numpad2"), keyboard("Numpad4"), keyboard("Numpad6")),
  }),
  pointerGrid: Object.freeze({
    label: "Pointer / trackpad grid",
    kind: "absolute",
    axes: axes(pointerAxis("x"), pointerAxis("y", true)),
  }),
  mouseButtonsWheel: Object.freeze({
    label: "Mouse buttons and wheel",
    kind: "digital",
    directions: directions(wheel("up"), wheel("down"), mouseButton(2), mouseButton(0)),
  }),
  gamepadDpad: Object.freeze({
    label: "Gamepad D-pad",
    kind: "digital",
    directions: directions(gamepadButton(12), gamepadButton(13), gamepadButton(14), gamepadButton(15)),
  }),
  gamepadLeftStick: Object.freeze({
    label: "Gamepad left stick",
    kind: "analog",
    axes: axes(gamepadAxis(0), gamepadAxis(1, true)),
  }),
  gamepadRightStick: Object.freeze({
    label: "Gamepad right stick",
    kind: "analog",
    axes: axes(gamepadAxis(2), gamepadAxis(3, true)),
  }),
});

export const RESEARCH_EVENT_TYPES = Object.freeze([
  "sessionPrepared",
  "sessionStarted",
  "stimulusStarted",
  "stimulusPaused",
  "stimulusResumed",
  "stimulusCompleted",
  "transitionStarted",
  "transitionCompleted",
  "inputEdge",
  "timingGap",
  "writeInterrupted",
  "writeRecovered",
  "recoveryStarted",
  "recoveryCompleted",
  "stoppedEarly",
  "sessionCompleted",
  "sessionAborted",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactObject(value, path, required, optional = []) {
  if (!isPlainObject(value)) throw new TypeError(`${path} must be an object.`);
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TypeError(`${path} contains unknown field ${unknown[0]}.`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new TypeError(`${path} is missing required field ${missing[0]}.`);
  return value;
}

function text(value, path, { minimum = 1, maximum = 200, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${path} must be text.`);
  const normalized = value.trim().normalize("NFC");
  if (normalized.length < minimum || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new RangeError(`${path} must contain ${minimum}–${maximum} safe characters.`);
  }
  return normalized;
}

function identifier(value, path) {
  const normalized = text(value, path, { maximum: 128 }).toLowerCase();
  if (!ID_PATTERN.test(normalized)) throw new TypeError(`${path} must be a safe lowercase identifier.`);
  return normalized;
}

function participantIdentifier(value, path) {
  if (typeof value !== "string" || !PARTICIPANT_PATTERN.test(value)
    || Number(value.slice(1)) < 1 || Number(value.slice(1)) > MAX_PARTICIPANTS) {
    throw new TypeError(`${path} must be a P-prefixed zero-padded participant ID.`);
  }
  return value;
}

function finiteNumber(value, path, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${path} must be finite and within ${minimum}–${maximum}.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function integer(value, path, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${path} must be an integer within ${minimum}–${maximum}.`);
  }
  return value;
}

function boolean(value, path) {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean.`);
  return value;
}

function enumeration(value, path, values) {
  if (!values.includes(value)) throw new TypeError(`${path} must be one of: ${values.join(", ")}.`);
  return value;
}

function sha256(value, path, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new TypeError(`${path} must be a lowercase SHA-256 digest.`);
  return value;
}

function utcTimestamp(value, path) {
  const normalized = text(value, path, { maximum: 40 });
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) {
    throw new TypeError(`${path} must be a canonical UTC ISO-8601 timestamp.`);
  }
  return normalized;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function copy(value) {
  return structuredClone(value);
}

function bindingTokenSignature(token) {
  if (token.kind === "keyboard") return `keyboard:${token.code.toLowerCase()}`;
  if (token.kind === "mouseButton") return `mouseButton:${token.button}`;
  if (token.kind === "wheel") return `wheel:${token.direction}`;
  if (token.kind === "gamepadButton") return `gamepadButton:${token.button}`;
  return JSON.stringify(token);
}

function validateDigitalToken(value, path) {
  exactObject(value, path, ["kind"], ["code", "button", "direction"]);
  if (value.kind === "keyboard") {
    exactObject(value, path, ["kind", "code"]);
    const code = text(value.code, `${path}.code`, { maximum: 40 });
    if (!/^[A-Za-z0-9]+$/u.test(code)) throw new TypeError(`${path}.code is not a physical KeyboardEvent code.`);
    return { kind: "keyboard", code };
  }
  if (value.kind === "mouseButton") {
    exactObject(value, path, ["kind", "button"]);
    return { kind: "mouseButton", button: integer(value.button, `${path}.button`, 0, 31) };
  }
  if (value.kind === "wheel") {
    exactObject(value, path, ["kind", "direction"]);
    return { kind: "wheel", direction: enumeration(value.direction, `${path}.direction`, DIGITAL_DIRECTIONS) };
  }
  if (value.kind === "gamepadButton") {
    exactObject(value, path, ["kind", "button"]);
    return { kind: "gamepadButton", button: integer(value.button, `${path}.button`, 0, 63) };
  }
  throw new TypeError(`${path}.kind is not a supported digital action.`);
}

function validateAxisToken(value, path, expectedKind) {
  if (expectedKind === "absolute") {
    exactObject(value, path, ["kind", "axis", "invert"]);
    if (value.kind !== "pointerAxis") throw new TypeError(`${path}.kind must be pointerAxis.`);
    return {
      kind: "pointerAxis",
      axis: enumeration(value.axis, `${path}.axis`, ["x", "y"]),
      invert: boolean(value.invert, `${path}.invert`),
    };
  }
  exactObject(value, path, ["kind", "index", "invert"]);
  if (value.kind !== "gamepadAxis") throw new TypeError(`${path}.kind must be gamepadAxis.`);
  return {
    kind: "gamepadAxis",
    index: integer(value.index, `${path}.index`, 0, 15),
    invert: boolean(value.invert, `${path}.invert`),
  };
}

export function createInputBindingPreset(preset = "arrowKeys", stepSize = 0.1) {
  const definition = INPUT_PRESETS[preset];
  if (!definition) throw new TypeError(`Unsupported Research input preset: ${preset}.`);
  return validateInputBindingV1({
    schema: INPUT_BINDING_SCHEMA,
    version: 1,
    preset,
    kind: definition.kind,
    stepSize: definition.kind === "digital" ? stepSize : null,
    directions: definition.kind === "digital" ? copy(definition.directions) : null,
    axes: definition.kind === "digital" ? null : copy(definition.axes),
  });
}

export function validateInputBindingV1(value) {
  exactObject(value, "InputBindingV1", [
    "schema", "version", "preset", "kind", "stepSize", "directions", "axes",
  ]);
  if (value.schema !== INPUT_BINDING_SCHEMA || value.version !== 1) {
    throw new TypeError("InputBindingV1 has an unsupported schema or version.");
  }
  const knownPreset = INPUT_PRESET_IDS.includes(value.preset);
  if (!knownPreset && value.preset !== "custom") throw new TypeError("InputBindingV1 preset is unsupported.");
  const kind = enumeration(value.kind, "InputBindingV1.kind", ["digital", "absolute", "analog"]);
  const output = {
    schema: INPUT_BINDING_SCHEMA,
    version: 1,
    preset: value.preset,
    kind,
    stepSize: null,
    directions: null,
    axes: null,
  };
  if (kind === "digital") {
    output.stepSize = finiteNumber(value.stepSize, "InputBindingV1.stepSize", 0.001, 1);
    exactObject(value.directions, "InputBindingV1.directions", DIGITAL_DIRECTIONS);
    const signatures = new Set();
    output.directions = Object.fromEntries(DIGITAL_DIRECTIONS.map((direction) => {
      const token = validateDigitalToken(value.directions[direction], `InputBindingV1.directions.${direction}`);
      const signature = bindingTokenSignature(token);
      if (signatures.has(signature)) throw new TypeError("Every Research input direction must use a unique physical action.");
      signatures.add(signature);
      return [direction, token];
    }));
    if (value.axes !== null) throw new TypeError("Digital InputBindingV1 axes must be null.");
  } else {
    if (value.stepSize !== null || value.directions !== null) {
      throw new TypeError("Absolute and analog InputBindingV1 values use N/A step size and no digital directions.");
    }
    exactObject(value.axes, "InputBindingV1.axes", ["x", "y"]);
    output.axes = {
      x: validateAxisToken(value.axes.x, "InputBindingV1.axes.x", kind),
      y: validateAxisToken(value.axes.y, "InputBindingV1.axes.y", kind),
    };
    if (output.axes.x.kind === output.axes.y.kind) {
      const left = output.axes.x.index ?? output.axes.x.axis;
      const right = output.axes.y.index ?? output.axes.y.axis;
      if (left === right) throw new TypeError("Research input axes must be unique.");
    }
  }
  if (knownPreset) {
    const expected = INPUT_PRESETS[value.preset];
    if (expected.kind !== kind) throw new TypeError("Input preset kind does not match its declared preset.");
    const expectedPayload = kind === "digital" ? expected.directions : expected.axes;
    const actualPayload = kind === "digital" ? output.directions : output.axes;
    if (JSON.stringify(actualPayload) !== JSON.stringify(expectedPayload)) {
      throw new TypeError("Customized actions must use the custom input preset.");
    }
  } else if (kind !== "digital") {
    throw new TypeError("Research v1 custom capture supports digital physical actions only.");
  }
  return deepFreeze(output);
}

function defaultSettingsObject() {
  return {
    schema: RESEARCH_SETTINGS_SCHEMA,
    version: 1,
    experiment: {
      id: "video-affect-study",
      title: "Video Affect Study",
      participantCount: 24,
      samplingFrequencyHz: 130,
      betweenVideos: { mode: "fixed", durationMs: 5_000 },
    },
    stimuli: {
      allocationAlgorithm: BALANCED_ALGORITHM_VERSION,
      conditionOrder: "williams",
      seed: "000102030405060708090a0b0c0d0e0f",
      items: [],
      pools: [],
    },
    input: copy(createInputBindingPreset("arrowKeys")),
    visual: {
      gridEnabled: true,
      flubberEnabled: true,
      sizePercent: 32,
      transparency: 0.05,
      hideFeedback: false,
      overlayPosition: { x: 0.72, y: 0.5 },
      lockPosition: false,
      flubber: { showOutline: true, outlineThickness: 2, showHalo: true },
      grid: { lineThickness: 1, showOutline: true, outlineThickness: 2, cursorSize: 14 },
      colors: {
        up: "#f2c94c",
        down: "#2f80ed",
        left: "#eb5757",
        right: "#27ae60",
        idle: "#9ca3af",
        outline: "#f8fafc",
        halo: "#93c5fd",
        cursor: "#ffffff",
      },
    },
    advanced: {
      lsl: {
        enabled: false,
        stateStream: "AffectResearch",
        streamType: "Affect",
        markerStream: "AffectResearchMarkers",
        sourceId: "affect-research",
      },
      mappings: createDefaultFlubberMappings(),
    },
    output: { csv: true, tsv: false },
  };
}

export function createDefaultResearchSettings() {
  return validateResearchSettingsV1(defaultSettingsObject());
}

function validateBetweenVideos(value) {
  exactObject(value, "ResearchSettingsV1.experiment.betweenVideos", ["mode"], ["durationMs", "durationsMs"]);
  if (value.mode === "fixed") {
    exactObject(value, "ResearchSettingsV1.experiment.betweenVideos", ["mode", "durationMs"]);
    return { mode: "fixed", durationMs: integer(value.durationMs, "betweenVideos.durationMs", 0, 3_600_000) };
  }
  if (value.mode === "jitter") {
    exactObject(value, "ResearchSettingsV1.experiment.betweenVideos", ["mode", "durationsMs"]);
    if (!Array.isArray(value.durationsMs) || value.durationsMs.length < 1 || value.durationsMs.length > 128) {
      throw new RangeError("betweenVideos.durationsMs must contain 1–128 durations.");
    }
    return {
      mode: "jitter",
      durationsMs: value.durationsMs.map((duration, index) => integer(duration, `betweenVideos.durationsMs[${index}]`, 0, 3_600_000)),
    };
  }
  if (value.mode === "continueWhenReady") {
    exactObject(value, "ResearchSettingsV1.experiment.betweenVideos", ["mode"]);
    return { mode: "continueWhenReady" };
  }
  throw new TypeError("betweenVideos.mode must be fixed, jitter, or continueWhenReady.");
}

function safeRelativePath(value, path, requiredRoot) {
  const normalized = text(value, path, { maximum: 512 }).replace(/^\.\//u, "");
  if (normalized.includes("\\") || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    throw new TypeError(`${path} must use a relative forward-slash path.`);
  }
  let decoded = normalized;
  for (let depth = 0; depth < 8; depth += 1) {
    if (/%(?:2f|5c)/iu.test(decoded)) {
      throw new TypeError(`${path} must not percent-encode path separators.`);
    }
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new TypeError(`${path} contains invalid percent encoding.`);
    }
    if (next === decoded) break;
    if (next.includes("\\")) throw new TypeError(`${path} must not percent-encode path separators.`);
    decoded = next;
    if (decoded.startsWith("/") || /^[A-Za-z]:/u.test(decoded)) {
      throw new TypeError(`${path} must remain relative after percent decoding.`);
    }
    const decodedParts = decoded.split("/");
    if (decodedParts.some((part) => part === "." || part === "..")) {
      throw new TypeError(`${path} contains a percent-encoded dot segment.`);
    }
    if (depth === 7) throw new TypeError(`${path} contains excessive recursive percent encoding.`);
  }
  const parts = normalized.split("/");
  if (parts.length > 32) throw new RangeError(`${path} contains too many nested folders.`);
  if (parts.some((part) => !part || part === "." || part === ".." || /[<>:"|?*\u0000-\u001f]/u.test(part)
    || /[ .]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new TypeError(`${path} contains an unsafe path component.`);
  }
  if (requiredRoot && parts[0] !== requiredRoot) throw new TypeError(`${path} must be beneath ${requiredRoot}/.`);
  return normalized;
}

export function validateStimulusV1(value, path = "stimulus") {
  exactObject(value, path, ["stimulusId", "title", "source"]);
  const stimulusId = identifier(value.stimulusId, `${path}.stimulusId`);
  const titleValue = text(value.title, `${path}.title`, { maximum: 200 });
  exactObject(value.source, `${path}.source`, ["kind"], [
    "relativePath", "mimeType", "sha256", "byteLength", "durationMs",
    "url", "videoId", "observedTitle", "observedDurationMs",
  ]);
  const kind = enumeration(value.source.kind, `${path}.source.kind`, STIMULUS_SOURCE_KINDS);
  let source;
  if (kind === "workspaceFile" || kind === "repositoryAsset") {
    exactObject(value.source, `${path}.source`, [
      "kind", "relativePath", "mimeType", "sha256", "byteLength", "durationMs",
    ]);
    source = {
      kind,
      relativePath: safeRelativePath(value.source.relativePath, `${path}.source.relativePath`, kind === "workspaceFile" ? "stimuli" : null),
      mimeType: (() => {
        const mimeType = text(value.source.mimeType, `${path}.source.mimeType`, { maximum: 100 }).toLowerCase();
        if (!/^video\/[a-z0-9.+-]+$/u.test(mimeType)) throw new TypeError(`${path}.source.mimeType must identify video media.`);
        return mimeType;
      })(),
      sha256: sha256(value.source.sha256, `${path}.source.sha256`),
      byteLength: integer(value.source.byteLength, `${path}.source.byteLength`, 1, Number.MAX_SAFE_INTEGER),
      durationMs: finiteNumber(value.source.durationMs, `${path}.source.durationMs`, 1, 86_400_000),
    };
  } else {
    exactObject(value.source, `${path}.source`, [
      "kind", "url", "videoId", "observedTitle", "observedDurationMs",
    ]);
    const url = text(value.source.url, `${path}.source.url`, { maximum: 2_048 });
    let parsed;
    try { parsed = new URL(url); } catch { throw new TypeError(`${path}.source.url must be an absolute URL.`); }
    if (parsed.protocol !== "https:" || !/(^|\.)youtube\.com$|(^|\.)youtu\.be$/iu.test(parsed.hostname)) {
      throw new TypeError(`${path}.source.url must be an HTTPS YouTube URL.`);
    }
    source = {
      kind,
      url: parsed.href,
      videoId: (() => {
        const videoId = text(value.source.videoId, `${path}.source.videoId`, { minimum: 6, maximum: 32 });
        if (!/^[A-Za-z0-9_-]+$/u.test(videoId)) throw new TypeError(`${path}.source.videoId is invalid.`);
        return videoId;
      })(),
      observedTitle: text(value.source.observedTitle, `${path}.source.observedTitle`, { maximum: 200, nullable: true }),
      observedDurationMs: value.source.observedDurationMs === null
        ? null
        : finiteNumber(value.source.observedDurationMs, `${path}.source.observedDurationMs`, 1, 86_400_000),
    };
  }
  return deepFreeze({ stimulusId, title: titleValue, source });
}

function validatePool(value, path) {
  exactObject(value, path, ["poolId", "label", "videosPerParticipant", "stimulusIds"]);
  if (!Array.isArray(value.stimulusIds) || value.stimulusIds.length < 1 || value.stimulusIds.length > MAX_STIMULI) {
    throw new RangeError(`${path}.stimulusIds must contain 1–${MAX_STIMULI} IDs.`);
  }
  const stimulusIds = value.stimulusIds.map((id, index) => identifier(id, `${path}.stimulusIds[${index}]`));
  if (new Set(stimulusIds).size !== stimulusIds.length) throw new TypeError(`${path} contains duplicate stimulus IDs.`);
  return {
    poolId: identifier(value.poolId, `${path}.poolId`),
    label: text(value.label, `${path}.label`, { maximum: 120 }),
    videosPerParticipant: integer(value.videosPerParticipant, `${path}.videosPerParticipant`, 1, MAX_STIMULI),
    stimulusIds: stimulusIds.sort(lexical),
  };
}

function validateVisual(value) {
  exactObject(value, "ResearchSettingsV1.visual", [
    "gridEnabled", "flubberEnabled", "sizePercent", "transparency", "hideFeedback",
    "overlayPosition", "lockPosition", "flubber", "grid", "colors",
  ]);
  exactObject(value.overlayPosition, "ResearchSettingsV1.visual.overlayPosition", ["x", "y"]);
  exactObject(value.flubber, "ResearchSettingsV1.visual.flubber", ["showOutline", "outlineThickness", "showHalo"]);
  exactObject(value.grid, "ResearchSettingsV1.visual.grid", ["lineThickness", "showOutline", "outlineThickness", "cursorSize"]);
  exactObject(value.colors, "ResearchSettingsV1.visual.colors", ["up", "down", "left", "right", "idle", "outline", "halo", "cursor"]);
  const colors = Object.fromEntries(Object.entries(value.colors).map(([name, color]) => {
    if (typeof color !== "string" || !HEX_COLOR.test(color)) throw new TypeError(`ResearchSettingsV1.visual.colors.${name} must be a six-digit hex color.`);
    return [name, color.toLowerCase()];
  }));
  return {
    gridEnabled: boolean(value.gridEnabled, "ResearchSettingsV1.visual.gridEnabled"),
    flubberEnabled: boolean(value.flubberEnabled, "ResearchSettingsV1.visual.flubberEnabled"),
    sizePercent: finiteNumber(value.sizePercent, "ResearchSettingsV1.visual.sizePercent", 5, 100),
    transparency: finiteNumber(value.transparency, "ResearchSettingsV1.visual.transparency", 0, 1),
    hideFeedback: boolean(value.hideFeedback, "ResearchSettingsV1.visual.hideFeedback"),
    overlayPosition: {
      x: finiteNumber(value.overlayPosition.x, "ResearchSettingsV1.visual.overlayPosition.x", 0, 1),
      y: finiteNumber(value.overlayPosition.y, "ResearchSettingsV1.visual.overlayPosition.y", 0, 1),
    },
    lockPosition: boolean(value.lockPosition, "ResearchSettingsV1.visual.lockPosition"),
    flubber: {
      showOutline: boolean(value.flubber.showOutline, "ResearchSettingsV1.visual.flubber.showOutline"),
      outlineThickness: finiteNumber(value.flubber.outlineThickness, "ResearchSettingsV1.visual.flubber.outlineThickness", 0, 20),
      showHalo: boolean(value.flubber.showHalo, "ResearchSettingsV1.visual.flubber.showHalo"),
    },
    grid: {
      lineThickness: finiteNumber(value.grid.lineThickness, "ResearchSettingsV1.visual.grid.lineThickness", 0.25, 20),
      showOutline: boolean(value.grid.showOutline, "ResearchSettingsV1.visual.grid.showOutline"),
      outlineThickness: finiteNumber(value.grid.outlineThickness, "ResearchSettingsV1.visual.grid.outlineThickness", 0, 20),
      cursorSize: finiteNumber(value.grid.cursorSize, "ResearchSettingsV1.visual.grid.cursorSize", 2, 100),
    },
    colors,
  };
}

function validateAdvanced(value) {
  exactObject(value, "ResearchSettingsV1.advanced", ["lsl", "mappings"]);
  exactObject(value.lsl, "ResearchSettingsV1.advanced.lsl", [
    "enabled", "stateStream", "streamType", "markerStream", "sourceId",
  ]);
  exactObject(value.mappings, "ResearchSettingsV1.advanced.mappings", Object.keys(FLUBBER_MAPPING_SPECS));
  return {
    lsl: {
      enabled: boolean(value.lsl.enabled, "ResearchSettingsV1.advanced.lsl.enabled"),
      stateStream: text(value.lsl.stateStream, "ResearchSettingsV1.advanced.lsl.stateStream", { maximum: 80 }),
      streamType: text(value.lsl.streamType, "ResearchSettingsV1.advanced.lsl.streamType", { maximum: 80 }),
      markerStream: text(value.lsl.markerStream, "ResearchSettingsV1.advanced.lsl.markerStream", { maximum: 80 }),
      sourceId: text(value.lsl.sourceId, "ResearchSettingsV1.advanced.lsl.sourceId", { maximum: 120 }),
    },
    mappings: Object.fromEntries(Object.keys(FLUBBER_MAPPING_SPECS).map((id) => [
      id,
      copy(validateFlubberMapping(id, value.mappings[id])),
    ])),
  };
}

export function validateResearchSettingsV1(value) {
  exactObject(value, "ResearchSettingsV1", [
    "schema", "version", "experiment", "stimuli", "input", "visual", "advanced", "output",
  ]);
  if (value.schema !== RESEARCH_SETTINGS_SCHEMA || value.version !== 1) {
    throw new TypeError("ResearchSettingsV1 has an unsupported schema or version.");
  }
  exactObject(value.experiment, "ResearchSettingsV1.experiment", [
    "id", "title", "participantCount", "samplingFrequencyHz", "betweenVideos",
  ]);
  exactObject(value.stimuli, "ResearchSettingsV1.stimuli", [
    "allocationAlgorithm", "conditionOrder", "seed", "items", "pools",
  ]);
  exactObject(value.output, "ResearchSettingsV1.output", ["csv", "tsv"]);
  if (!Array.isArray(value.stimuli.items) || value.stimuli.items.length > MAX_STIMULI) {
    throw new RangeError(`ResearchSettingsV1.stimuli.items supports at most ${MAX_STIMULI} items.`);
  }
  if (!Array.isArray(value.stimuli.pools) || value.stimuli.pools.length > MAX_POOLS) {
    throw new RangeError(`ResearchSettingsV1.stimuli.pools supports at most ${MAX_POOLS} pools.`);
  }
  const items = value.stimuli.items.map((item, index) => copy(validateStimulusV1(item, `ResearchSettingsV1.stimuli.items[${index}]`)))
    .sort((left, right) => lexical(left.stimulusId, right.stimulusId));
  const itemIds = new Set(items.map(({ stimulusId }) => stimulusId));
  if (itemIds.size !== items.length) throw new TypeError("ResearchSettingsV1 contains duplicate stimulus IDs.");
  // Pool order is protocol-significant: it is the input order for Williams or
  // cyclic counterbalancing. Do not silently alphabetize condition columns.
  const pools = value.stimuli.pools.map((pool, index) => validatePool(pool, `ResearchSettingsV1.stimuli.pools[${index}]`));
  if (new Set(pools.map(({ poolId }) => poolId)).size !== pools.length) {
    throw new TypeError("ResearchSettingsV1 contains duplicate pool IDs.");
  }
  const memberships = new Map();
  for (const pool of pools) {
    for (const stimulusId of pool.stimulusIds) {
      if (!itemIds.has(stimulusId)) throw new TypeError(`Pool ${pool.poolId} references unknown stimulus ${stimulusId}.`);
      if (memberships.has(stimulusId)) throw new TypeError(`Stimulus ${stimulusId} belongs to more than one pool.`);
      memberships.set(stimulusId, pool.poolId);
    }
  }
  if ((items.length || pools.length) && memberships.size !== items.length) {
    const missing = items.find(({ stimulusId }) => !memberships.has(stimulusId));
    throw new TypeError(`Stimulus ${missing?.stimulusId ?? "unknown"} does not belong to a pool.`);
  }
  const output = {
    schema: RESEARCH_SETTINGS_SCHEMA,
    version: 1,
    experiment: {
      id: identifier(value.experiment.id, "ResearchSettingsV1.experiment.id"),
      title: text(value.experiment.title, "ResearchSettingsV1.experiment.title", { maximum: 160 }),
      participantCount: integer(value.experiment.participantCount, "ResearchSettingsV1.experiment.participantCount", 1, MAX_PARTICIPANTS),
      samplingFrequencyHz: integer(value.experiment.samplingFrequencyHz, "ResearchSettingsV1.experiment.samplingFrequencyHz", 1, 240),
      betweenVideos: validateBetweenVideos(value.experiment.betweenVideos),
    },
    stimuli: {
      allocationAlgorithm: enumeration(value.stimuli.allocationAlgorithm, "ResearchSettingsV1.stimuli.allocationAlgorithm", [BALANCED_ALGORITHM_VERSION]),
      conditionOrder: enumeration(value.stimuli.conditionOrder, "ResearchSettingsV1.stimuli.conditionOrder", CONDITION_ORDER_METHODS),
      seed: (() => {
        if (typeof value.stimuli.seed !== "string" || !/^[a-f0-9]{32}$/u.test(value.stimuli.seed)) {
          throw new TypeError("ResearchSettingsV1.stimuli.seed must be a 128-bit lowercase hexadecimal seed.");
        }
        return value.stimuli.seed;
      })(),
      items,
      pools,
    },
    input: copy(validateInputBindingV1(value.input)),
    visual: validateVisual(value.visual),
    advanced: validateAdvanced(value.advanced),
    output: {
      csv: boolean(value.output.csv, "ResearchSettingsV1.output.csv"),
      tsv: boolean(value.output.tsv, "ResearchSettingsV1.output.tsv"),
    },
  };
  if (!output.output.csv && !output.output.tsv) throw new TypeError("ResearchSettingsV1 requires CSV, TSV, or both.");
  return deepFreeze(output);
}

function validatePlanShape(value) {
  exactObject(value, "ResolvedAssignmentPlanV1", [
    "schema", "version", "algorithmVersion", "seed", "conditionOrder", "settingsSha256",
    "participantIds", "stimuli", "pools", "assignments", "exposureCounts", "planHashSha256",
  ]);
  if (value.schema !== RESOLVED_ASSIGNMENT_PLAN_SCHEMA || value.version !== 1) {
    throw new TypeError("ResolvedAssignmentPlanV1 has an unsupported schema or version.");
  }
  const algorithmVersion = enumeration(value.algorithmVersion, "ResolvedAssignmentPlanV1.algorithmVersion", [BALANCED_ALGORITHM_VERSION]);
  const conditionOrder = enumeration(value.conditionOrder, "ResolvedAssignmentPlanV1.conditionOrder", CONDITION_ORDER_METHODS);
  if (!Array.isArray(value.participantIds) || !value.participantIds.length || value.participantIds.length > MAX_PARTICIPANTS) {
    throw new RangeError("ResolvedAssignmentPlanV1 participantIds are invalid.");
  }
  const participantIds = value.participantIds.map((id, index) => participantIdentifier(id, `participantIds[${index}]`));
  if (new Set(participantIds).size !== participantIds.length) throw new TypeError("ResolvedAssignmentPlanV1 has duplicate participants.");
  const participantWidth = Math.max(3, String(participantIds.length).length);
  const expectedParticipants = Array.from({ length: participantIds.length }, (_, index) => `P${String(index + 1).padStart(participantWidth, "0")}`);
  if (JSON.stringify(participantIds) !== JSON.stringify(expectedParticipants)) {
    throw new TypeError("ResolvedAssignmentPlanV1 participant IDs are not the canonical generated sequence.");
  }
  if (!Array.isArray(value.stimuli) || !value.stimuli.length || value.stimuli.length > MAX_STIMULI) {
    throw new RangeError("ResolvedAssignmentPlanV1 stimuli are invalid.");
  }
  const stimuli = value.stimuli.map((item, index) => copy(validateStimulusV1(item, `ResolvedAssignmentPlanV1.stimuli[${index}]`)));
  const stimulusIds = new Set(stimuli.map(({ stimulusId }) => stimulusId));
  if (stimulusIds.size !== stimuli.length) throw new TypeError("ResolvedAssignmentPlanV1 has duplicate stimuli.");
  if (!Array.isArray(value.pools) || !value.pools.length || value.pools.length > MAX_POOLS) {
    throw new RangeError("ResolvedAssignmentPlanV1 pools are invalid.");
  }
  const pools = value.pools.map((pool, index) => validatePool(pool, `ResolvedAssignmentPlanV1.pools[${index}]`));
  const poolById = new Map(pools.map((pool) => [pool.poolId, pool]));
  if (poolById.size !== pools.length) throw new TypeError("ResolvedAssignmentPlanV1 has duplicate pools.");
  const stimulusPool = new Map();
  for (const pool of pools) {
    if (pool.videosPerParticipant > pool.stimulusIds.length) {
      throw new TypeError(`Pool ${pool.poolId} requests more unique videos than it contains.`);
    }
    for (const stimulusId of pool.stimulusIds) {
      if (!stimulusIds.has(stimulusId) || stimulusPool.has(stimulusId)) {
        throw new TypeError(`ResolvedAssignmentPlanV1 has an invalid pool membership for ${stimulusId}.`);
      }
      stimulusPool.set(stimulusId, pool.poolId);
    }
  }
  if (stimulusPool.size !== stimuli.length) throw new TypeError("ResolvedAssignmentPlanV1 does not pool every stimulus exactly once.");
  if (!Array.isArray(value.assignments) || value.assignments.length !== participantIds.length) {
    throw new TypeError("ResolvedAssignmentPlanV1 requires one assignment per participant.");
  }
  const totalSlots = pools.reduce((sum, pool) => sum + pool.videosPerParticipant, 0);
  const orderBase = Array.from({ length: pools.length }, (_, position) => {
    if (conditionOrder === "cyclic") return position;
    if (position === 0) return 0;
    return position % 2 === 1 ? Math.ceil(position / 2) : pools.length - position / 2;
  });
  const orderRows = Array.from({ length: pools.length }, (_, offset) => orderBase.map((index) => (index + offset) % pools.length));
  if (conditionOrder === "williams" && pools.length % 2 === 1) {
    orderRows.push(...orderRows.map((row) => [...row].reverse()));
  }
  const computedTotals = new Map(stimuli.map(({ stimulusId }) => [stimulusId, 0]));
  const computedPositions = new Map(stimuli.map(({ stimulusId }) => [stimulusId, Array(totalSlots).fill(0)]));
  const seenAssignments = new Set();
  const assignments = value.assignments.map((assignment, assignmentIndex) => {
    exactObject(assignment, `assignments[${assignmentIndex}]`, ["participantId", "conditionOrder", "slots"]);
    const participantId = participantIdentifier(assignment.participantId, `assignments[${assignmentIndex}].participantId`);
    if (!participantIds.includes(participantId) || seenAssignments.has(participantId)) throw new TypeError(`Invalid repeated assignment for ${participantId}.`);
    if (participantId !== participantIds[assignmentIndex]) throw new TypeError("Resolved assignments must follow canonical participant order.");
    seenAssignments.add(participantId);
    if (!Array.isArray(assignment.conditionOrder) || assignment.conditionOrder.length !== pools.length
      || new Set(assignment.conditionOrder).size !== pools.length
      || assignment.conditionOrder.some((poolId) => !poolById.has(poolId))) {
      throw new TypeError(`Assignment ${participantId} has an invalid condition order.`);
    }
    const expectedConditionOrder = orderRows[assignmentIndex % orderRows.length].map((index) => pools[index].poolId);
    if (JSON.stringify(assignment.conditionOrder) !== JSON.stringify(expectedConditionOrder)) {
      throw new TypeError(`Assignment ${participantId} does not follow the declared ${conditionOrder} order.`);
    }
    if (!Array.isArray(assignment.slots) || assignment.slots.length !== totalSlots) {
      throw new TypeError(`Assignment ${participantId} has an invalid slot count.`);
    }
    const participantStimuli = new Set();
    const perPool = new Map(pools.map((pool) => [pool.poolId, 0]));
    const slots = assignment.slots.map((slot, slotIndex) => {
      exactObject(slot, `assignments[${assignmentIndex}].slots[${slotIndex}]`, ["position", "poolId", "poolPosition", "stimulusId"]);
      if (slot.position !== slotIndex + 1) throw new TypeError(`Assignment ${participantId} positions must be contiguous and one-based.`);
      const pool = poolById.get(slot.poolId);
      if (!pool || !pool.stimulusIds.includes(slot.stimulusId) || participantStimuli.has(slot.stimulusId)) {
        throw new TypeError(`Assignment ${participantId} contains an invalid or duplicate stimulus.`);
      }
      participantStimuli.add(slot.stimulusId);
      const expectedPoolPosition = perPool.get(slot.poolId) + 1;
      if (slot.poolPosition !== expectedPoolPosition) throw new TypeError(`Assignment ${participantId} has an invalid pool position.`);
      perPool.set(slot.poolId, expectedPoolPosition);
      computedTotals.set(slot.stimulusId, computedTotals.get(slot.stimulusId) + 1);
      computedPositions.get(slot.stimulusId)[slotIndex] += 1;
      return { position: slot.position, poolId: slot.poolId, poolPosition: slot.poolPosition, stimulusId: slot.stimulusId };
    });
    for (const pool of pools) {
      if (perPool.get(pool.poolId) !== pool.videosPerParticipant) throw new TypeError(`Assignment ${participantId} does not satisfy pool ${pool.poolId}.`);
    }
    return { participantId, conditionOrder: [...assignment.conditionOrder], slots };
  });
  if (!Array.isArray(value.exposureCounts) || value.exposureCounts.length !== stimuli.length) {
    throw new TypeError("ResolvedAssignmentPlanV1 exposureCounts are incomplete.");
  }
  const exposureCounts = value.exposureCounts.map((entry, index) => {
    exactObject(entry, `exposureCounts[${index}]`, ["stimulusId", "total", "positionCounts"]);
    if (!stimulusIds.has(entry.stimulusId) || !Array.isArray(entry.positionCounts) || entry.positionCounts.length !== totalSlots) {
      throw new TypeError(`Exposure record ${index} is invalid.`);
    }
    const positionCounts = entry.positionCounts.map((count, position) => integer(count, `exposureCounts[${index}].positionCounts[${position}]`, 0, participantIds.length));
    if (entry.total !== computedTotals.get(entry.stimulusId)
      || JSON.stringify(positionCounts) !== JSON.stringify(computedPositions.get(entry.stimulusId))) {
      throw new TypeError(`Exposure record for ${entry.stimulusId} does not match the resolved slots.`);
    }
    return { stimulusId: entry.stimulusId, total: entry.total, positionCounts };
  });
  if (new Set(exposureCounts.map(({ stimulusId }) => stimulusId)).size !== stimuli.length) {
    throw new TypeError("ResolvedAssignmentPlanV1 has duplicate exposure records.");
  }
  for (const pool of pools) {
    const totals = pool.stimulusIds.map((stimulusId) => computedTotals.get(stimulusId));
    if (totals.some((count) => count < 1) || Math.max(...totals) - Math.min(...totals) > 1) {
      throw new TypeError(`ResolvedAssignmentPlanV1 violates balanced-v1 exposure for pool ${pool.poolId}.`);
    }
  }
  return {
    schema: RESOLVED_ASSIGNMENT_PLAN_SCHEMA,
    version: 1,
    algorithmVersion,
    seed: (() => {
      if (typeof value.seed !== "string" || !/^[a-f0-9]{32}$/u.test(value.seed)) throw new TypeError("ResolvedAssignmentPlanV1 seed is invalid.");
      return value.seed;
    })(),
    conditionOrder,
    settingsSha256: sha256(value.settingsSha256, "ResolvedAssignmentPlanV1.settingsSha256"),
    participantIds,
    stimuli,
    pools,
    assignments,
    exposureCounts,
    planHashSha256: sha256(value.planHashSha256, "ResolvedAssignmentPlanV1.planHashSha256"),
  };
}

export async function validateResolvedAssignmentPlanV1(value) {
  const output = validatePlanShape(value);
  const observed = await canonicalSha256(output, { omitRootKeys: ["planHashSha256"] });
  if (observed !== output.planHashSha256) throw new TypeError("ResolvedAssignmentPlanV1 plan hash does not match its canonical content.");
  return deepFreeze(output);
}

function sampleStimulusIdentity(value, path) {
  exactObject(value, path, [
    "kind", "stimulusId", "sha256", "byteLength", "durationMs", "url", "videoId",
  ]);
  const kind = enumeration(value.kind, `${path}.kind`, STIMULUS_SOURCE_KINDS);
  const output = {
    kind,
    stimulusId: identifier(value.stimulusId, `${path}.stimulusId`),
    sha256: sha256(value.sha256, `${path}.sha256`, { nullable: true }),
    byteLength: value.byteLength === null ? null : integer(value.byteLength, `${path}.byteLength`, 1, Number.MAX_SAFE_INTEGER),
    durationMs: finiteNumber(value.durationMs, `${path}.durationMs`, 1, 86_400_000),
    url: text(value.url, `${path}.url`, { maximum: 2_048, nullable: true }),
    videoId: text(value.videoId, `${path}.videoId`, { minimum: 6, maximum: 32, nullable: true }),
  };
  if (kind === "youtube") {
    if (output.sha256 !== null || output.byteLength !== null || output.url === null || output.videoId === null) {
      throw new TypeError(`${path} YouTube identity must be unverified and URL-bound.`);
    }
    let parsed;
    try { parsed = new URL(output.url); } catch { throw new TypeError(`${path}.url must be an absolute URL.`); }
    if (parsed.protocol !== "https:" || !/(^|\.)youtube\.com$|(^|\.)youtu\.be$/iu.test(parsed.hostname)) {
      throw new TypeError(`${path}.url must be an HTTPS YouTube URL.`);
    }
    output.url = parsed.href;
  } else if (output.sha256 === null || output.byteLength === null || output.url !== null || output.videoId !== null) {
    throw new TypeError(`${path} local identity must be hash- and byte-bound.`);
  }
  return output;
}

export function validateResearchSampleV1(value) {
  const fields = [
    "schema", "version", "sequence", "runId", "participantId", "attemptNumber",
    "settingsSha256", "assignmentPlanSha256", "stimulusPosition", "stimulusIdentity",
    "wallTimeUtc", "monotonicTimeNs", "lslTimeSeconds",
    "sampleRateHz", "scheduledElapsedMs", "observedElapsedMs", "schedulerLatenessMs",
    "schedulerJitterMs", "stateAnchorAgeMs", "missedSlotsBefore", "mediaTimeMs",
    "currentValence", "currentArousal", "targetValence", "targetArousal", "radius",
    "angleDegrees", "oscillationFrequency", "edgeSmoothness", "projectionAmplitude",
    "pulseSynchrony", "waveSizeVariation", "saturation", "animationActive", "inputActive",
    "inputKind", "feedbackVisible",
  ];
  exactObject(value, "ResearchSampleV1", fields);
  if (value.schema !== RESEARCH_SAMPLE_SCHEMA || value.version !== 1) throw new TypeError("ResearchSampleV1 schema or version is unsupported.");
  if (typeof value.monotonicTimeNs !== "string" || !MONOTONIC_NS.test(value.monotonicTimeNs)) {
    throw new TypeError("ResearchSampleV1.monotonicTimeNs must be an unsigned decimal string.");
  }
  const stimulusIdentity = sampleStimulusIdentity(value.stimulusIdentity, "ResearchSampleV1.stimulusIdentity");
  const output = {
    schema: RESEARCH_SAMPLE_SCHEMA,
    version: 1,
    sequence: integer(value.sequence, "ResearchSampleV1.sequence", 1, Number.MAX_SAFE_INTEGER),
    runId: identifier(value.runId, "ResearchSampleV1.runId"),
    participantId: participantIdentifier(value.participantId, "ResearchSampleV1.participantId"),
    attemptNumber: integer(value.attemptNumber, "ResearchSampleV1.attemptNumber", 1, 999_999),
    settingsSha256: sha256(value.settingsSha256, "ResearchSampleV1.settingsSha256"),
    assignmentPlanSha256: sha256(value.assignmentPlanSha256, "ResearchSampleV1.assignmentPlanSha256"),
    stimulusPosition: integer(value.stimulusPosition, "ResearchSampleV1.stimulusPosition", 1, MAX_STIMULI),
    stimulusIdentity,
    wallTimeUtc: utcTimestamp(value.wallTimeUtc, "ResearchSampleV1.wallTimeUtc"),
    monotonicTimeNs: value.monotonicTimeNs,
    lslTimeSeconds: value.lslTimeSeconds === null
      ? null
      : finiteNumber(value.lslTimeSeconds, "ResearchSampleV1.lslTimeSeconds", 0, Number.MAX_VALUE),
    sampleRateHz: integer(value.sampleRateHz, "ResearchSampleV1.sampleRateHz", 1, 240),
    scheduledElapsedMs: finiteNumber(value.scheduledElapsedMs, "ResearchSampleV1.scheduledElapsedMs", 0, Number.MAX_SAFE_INTEGER),
    observedElapsedMs: finiteNumber(value.observedElapsedMs, "ResearchSampleV1.observedElapsedMs", 0, Number.MAX_SAFE_INTEGER),
    schedulerLatenessMs: finiteNumber(value.schedulerLatenessMs, "ResearchSampleV1.schedulerLatenessMs", 0, 3_600_000),
    schedulerJitterMs: finiteNumber(value.schedulerJitterMs, "ResearchSampleV1.schedulerJitterMs", -3_600_000, 3_600_000),
    stateAnchorAgeMs: finiteNumber(value.stateAnchorAgeMs, "ResearchSampleV1.stateAnchorAgeMs", 0, 3_600_000),
    missedSlotsBefore: integer(value.missedSlotsBefore, "ResearchSampleV1.missedSlotsBefore", 0, 1_000_000),
    mediaTimeMs: finiteNumber(value.mediaTimeMs, "ResearchSampleV1.mediaTimeMs", 0, stimulusIdentity.durationMs),
    currentValence: finiteNumber(value.currentValence, "ResearchSampleV1.currentValence", -1, 1),
    currentArousal: finiteNumber(value.currentArousal, "ResearchSampleV1.currentArousal", -1, 1),
    targetValence: finiteNumber(value.targetValence, "ResearchSampleV1.targetValence", -1, 1),
    targetArousal: finiteNumber(value.targetArousal, "ResearchSampleV1.targetArousal", -1, 1),
    radius: finiteNumber(value.radius, "ResearchSampleV1.radius", 0, 1),
    angleDegrees: (() => {
      const angle = finiteNumber(value.angleDegrees, "ResearchSampleV1.angleDegrees", 0, 360);
      if (angle >= 360) throw new RangeError("ResearchSampleV1.angleDegrees must be within 0–<360.");
      return angle;
    })(),
    oscillationFrequency: finiteNumber(value.oscillationFrequency, "ResearchSampleV1.oscillationFrequency", 0, 10),
    edgeSmoothness: finiteNumber(value.edgeSmoothness, "ResearchSampleV1.edgeSmoothness", 0, 1),
    projectionAmplitude: finiteNumber(value.projectionAmplitude, "ResearchSampleV1.projectionAmplitude", 0, 1),
    pulseSynchrony: finiteNumber(value.pulseSynchrony, "ResearchSampleV1.pulseSynchrony", 0, 1),
    waveSizeVariation: finiteNumber(value.waveSizeVariation, "ResearchSampleV1.waveSizeVariation", 0, 1),
    saturation: finiteNumber(value.saturation, "ResearchSampleV1.saturation", 0, 1),
    animationActive: boolean(value.animationActive, "ResearchSampleV1.animationActive"),
    inputActive: boolean(value.inputActive, "ResearchSampleV1.inputActive"),
    inputKind: enumeration(value.inputKind, "ResearchSampleV1.inputKind", ["digital", "absolute", "analog"]),
    feedbackVisible: boolean(value.feedbackVisible, "ResearchSampleV1.feedbackVisible"),
  };
  const expectedLatenessMs = output.observedElapsedMs - output.scheduledElapsedMs;
  if (expectedLatenessMs < -0.001) {
    throw new TypeError("ResearchSampleV1 observed time cannot precede its scheduled deadline.");
  }
  if (Math.abs(output.schedulerLatenessMs - Math.max(0, expectedLatenessMs)) > 0.001) {
    throw new TypeError("ResearchSampleV1 scheduler lateness must equal observed minus scheduled elapsed time.");
  }
  const expectedRadius = Math.min(1, Math.hypot(output.currentValence, output.currentArousal));
  if (Math.abs(output.radius - expectedRadius) > 1e-9) {
    throw new TypeError("ResearchSampleV1 radius must match its current valence/arousal coordinates.");
  }
  const expectedAngle = expectedRadius === 0
    ? 0
    : (Math.atan2(output.currentArousal, output.currentValence) * 180 / Math.PI + 360) % 360;
  const angleError = Math.min(
    Math.abs(output.angleDegrees - expectedAngle),
    360 - Math.abs(output.angleDegrees - expectedAngle),
  );
  if (angleError > 1e-6) {
    throw new TypeError("ResearchSampleV1 angle must match its current valence/arousal coordinates, with neutral fixed at zero.");
  }
  return deepFreeze(output);
}

export function validateResearchEventV1(value) {
  exactObject(value, "ResearchEventV1", [
    "schema", "version", "sequence", "runId", "participantId", "attemptNumber",
    "settingsSha256", "assignmentPlanSha256", "wallTimeUtc", "monotonicTimeNs", "type",
    "stimulusIdentity", "stimulusPosition",
    "mediaTimeMs", "missedSlotCount", "detailCode",
  ]);
  if (value.schema !== RESEARCH_EVENT_SCHEMA || value.version !== 1) throw new TypeError("ResearchEventV1 schema or version is unsupported.");
  if (typeof value.monotonicTimeNs !== "string" || !MONOTONIC_NS.test(value.monotonicTimeNs)) {
    throw new TypeError("ResearchEventV1.monotonicTimeNs must be an unsigned decimal string.");
  }
  const nullableInteger = (candidate, path, minimum, maximum) => candidate === null ? null : integer(candidate, path, minimum, maximum);
  const nullableNumber = (candidate, path, minimum, maximum) => candidate === null ? null : finiteNumber(candidate, path, minimum, maximum);
  const output = {
    schema: RESEARCH_EVENT_SCHEMA,
    version: 1,
    sequence: integer(value.sequence, "ResearchEventV1.sequence", 1, Number.MAX_SAFE_INTEGER),
    runId: identifier(value.runId, "ResearchEventV1.runId"),
    participantId: participantIdentifier(value.participantId, "ResearchEventV1.participantId"),
    attemptNumber: integer(value.attemptNumber, "ResearchEventV1.attemptNumber", 1, 999_999),
    settingsSha256: sha256(value.settingsSha256, "ResearchEventV1.settingsSha256"),
    assignmentPlanSha256: sha256(value.assignmentPlanSha256, "ResearchEventV1.assignmentPlanSha256"),
    wallTimeUtc: utcTimestamp(value.wallTimeUtc, "ResearchEventV1.wallTimeUtc"),
    monotonicTimeNs: value.monotonicTimeNs,
    type: enumeration(value.type, "ResearchEventV1.type", RESEARCH_EVENT_TYPES),
    stimulusIdentity: value.stimulusIdentity === null
      ? null
      : sampleStimulusIdentity(value.stimulusIdentity, "ResearchEventV1.stimulusIdentity"),
    stimulusPosition: nullableInteger(value.stimulusPosition, "ResearchEventV1.stimulusPosition", 1, MAX_STIMULI),
    mediaTimeMs: nullableNumber(value.mediaTimeMs, "ResearchEventV1.mediaTimeMs", 0, 86_400_000),
    missedSlotCount: nullableInteger(value.missedSlotCount, "ResearchEventV1.missedSlotCount", 1, 1_000_000),
    detailCode: value.detailCode === null ? null : text(value.detailCode, "ResearchEventV1.detailCode", { maximum: 128 }),
  };
  if (output.type === "timingGap" && output.missedSlotCount === null) throw new TypeError("A timingGap event requires missedSlotCount.");
  if (output.type !== "timingGap" && output.missedSlotCount !== null) throw new TypeError("Only timingGap events may carry missedSlotCount.");
  if ((output.stimulusIdentity === null) !== (output.stimulusPosition === null)) {
    throw new TypeError("ResearchEventV1 stimulus identity and position must be present together.");
  }
  if (output.mediaTimeMs !== null && output.stimulusIdentity === null) {
    throw new TypeError("ResearchEventV1 media time requires a stimulus identity.");
  }
  if (output.mediaTimeMs !== null && output.mediaTimeMs > output.stimulusIdentity.durationMs) {
    throw new RangeError("ResearchEventV1 media time exceeds the stimulus duration.");
  }
  if (output.detailCode !== null && !SAFE_CODE.test(output.detailCode)) throw new TypeError("ResearchEventV1.detailCode must be a bounded semantic code.");
  return deepFreeze(output);
}

function manifestStimulus(value, path) {
  return sampleStimulusIdentity(value, path);
}

function manifestOutput(value, path) {
  exactObject(value, path, ["kind", "fileName", "sha256", "byteLength", "rowCount"]);
  const fileName = text(value.fileName, `${path}.fileName`, { maximum: 240 });
  if (fileName.includes("/") || fileName.includes("\\") || /[<>:"|?*\u0000-\u001f]/u.test(fileName)) {
    throw new TypeError(`${path}.fileName must be a safe basename.`);
  }
  const kind = enumeration(value.kind, `${path}.kind`, ["settings", "events", "csv", "tsv"]);
  const rowCount = value.rowCount === null ? null : integer(value.rowCount, `${path}.rowCount`, 0, Number.MAX_SAFE_INTEGER);
  if ((kind === "csv" || kind === "tsv") !== (rowCount !== null)) throw new TypeError(`${path}.rowCount must be present only for rating tables.`);
  return {
    kind,
    fileName,
    sha256: sha256(value.sha256, `${path}.sha256`),
    byteLength: integer(value.byteLength, `${path}.byteLength`, 1, Number.MAX_SAFE_INTEGER),
    rowCount,
  };
}

export function validateResearchRunManifestV2(value) {
  exactObject(value, "ResearchRunManifestV2", [
    "schema", "version", "runId", "experimentId", "participantId", "participantCode", "age",
    "gender", "handedness", "attemptNumber", "sessionStem", "completionStatus", "settingsSha256",
    "assignmentPlanSha256", "stimuli", "timing", "outputs", "recovery", "build",
  ]);
  if (value.schema !== RESEARCH_RUN_MANIFEST_SCHEMA || value.version !== 2) throw new TypeError("ResearchRunManifestV2 schema or version is unsupported.");
  exactObject(value.timing, "ResearchRunManifestV2.timing", [
    "sampleRateHz", "sampleCount", "eventCount", "gapEventCount", "missedSlotCount", "startedAt", "finalizedAt",
  ]);
  exactObject(value.recovery, "ResearchRunManifestV2.recovery", ["resumed", "sourceRunId", "restartedStimulusIds"]);
  exactObject(value.build, "ResearchRunManifestV2.build", ["platform", "appVersion", "buildCommit"]);
  if (!Array.isArray(value.stimuli) || !value.stimuli.length || value.stimuli.length > MAX_STIMULI) throw new RangeError("ResearchRunManifestV2 stimuli are invalid.");
  if (!Array.isArray(value.outputs) || value.outputs.length < 3 || value.outputs.length > 4) throw new RangeError("ResearchRunManifestV2 outputs are invalid.");
  if (!Array.isArray(value.recovery.restartedStimulusIds) || value.recovery.restartedStimulusIds.length > MAX_STIMULI) throw new TypeError("ResearchRunManifestV2 recovery stimuli are invalid.");
  const participantCode = text(value.participantCode, "ResearchRunManifestV2.participantCode", { maximum: 32 });
  if (/[<>:"/\\|?*_\u0000-\u001f]/u.test(participantCode)) {
    throw new TypeError("ResearchRunManifestV2.participantCode is not filename-safe.");
  }
  const outputs = value.outputs.map((entry, index) => manifestOutput(entry, `ResearchRunManifestV2.outputs[${index}]`));
  if (new Set(outputs.map(({ kind }) => kind)).size !== outputs.length
    || !outputs.some(({ kind }) => kind === "settings")
    || !outputs.some(({ kind }) => kind === "events")
    || !outputs.some(({ kind }) => kind === "csv" || kind === "tsv")) {
    throw new TypeError("ResearchRunManifestV2 requires unique settings, events, and at least one rating output.");
  }
  const stimuli = value.stimuli.map((entry, index) => manifestStimulus(entry, `ResearchRunManifestV2.stimuli[${index}]`));
  if (new Set(stimuli.map(({ stimulusId }) => stimulusId)).size !== stimuli.length) throw new TypeError("ResearchRunManifestV2 has duplicate stimuli.");
  const output = {
    schema: RESEARCH_RUN_MANIFEST_SCHEMA,
    version: 2,
    runId: identifier(value.runId, "ResearchRunManifestV2.runId"),
    experimentId: identifier(value.experimentId, "ResearchRunManifestV2.experimentId"),
    participantId: participantIdentifier(value.participantId, "ResearchRunManifestV2.participantId"),
    participantCode,
    age: integer(value.age, "ResearchRunManifestV2.age", 1, 120),
    gender: enumeration(value.gender, "ResearchRunManifestV2.gender", ["W", "M", "N", "S", "X"]),
    handedness: enumeration(value.handedness, "ResearchRunManifestV2.handedness", ["L", "R", "A"]),
    attemptNumber: integer(value.attemptNumber, "ResearchRunManifestV2.attemptNumber", 1, 999_999),
    sessionStem: (() => {
      const stem = text(value.sessionStem, "ResearchRunManifestV2.sessionStem", { maximum: 240 });
      if (/[<>:"/\\|?*\u0000-\u001f]/u.test(stem)) throw new TypeError("ResearchRunManifestV2.sessionStem must be a safe basename.");
      return stem;
    })(),
    completionStatus: enumeration(value.completionStatus, "ResearchRunManifestV2.completionStatus", ["completed", "partial"]),
    settingsSha256: sha256(value.settingsSha256, "ResearchRunManifestV2.settingsSha256"),
    assignmentPlanSha256: sha256(value.assignmentPlanSha256, "ResearchRunManifestV2.assignmentPlanSha256"),
    stimuli,
    timing: {
      sampleRateHz: integer(value.timing.sampleRateHz, "ResearchRunManifestV2.timing.sampleRateHz", 1, 240),
      sampleCount: integer(value.timing.sampleCount, "ResearchRunManifestV2.timing.sampleCount", 0, Number.MAX_SAFE_INTEGER),
      eventCount: integer(value.timing.eventCount, "ResearchRunManifestV2.timing.eventCount", 0, Number.MAX_SAFE_INTEGER),
      gapEventCount: integer(value.timing.gapEventCount, "ResearchRunManifestV2.timing.gapEventCount", 0, Number.MAX_SAFE_INTEGER),
      missedSlotCount: integer(value.timing.missedSlotCount, "ResearchRunManifestV2.timing.missedSlotCount", 0, Number.MAX_SAFE_INTEGER),
      startedAt: utcTimestamp(value.timing.startedAt, "ResearchRunManifestV2.timing.startedAt"),
      finalizedAt: utcTimestamp(value.timing.finalizedAt, "ResearchRunManifestV2.timing.finalizedAt"),
    },
    outputs,
    recovery: {
      resumed: boolean(value.recovery.resumed, "ResearchRunManifestV2.recovery.resumed"),
      sourceRunId: value.recovery.sourceRunId === null ? null : identifier(value.recovery.sourceRunId, "ResearchRunManifestV2.recovery.sourceRunId"),
      restartedStimulusIds: value.recovery.restartedStimulusIds.map((id, index) => identifier(id, `ResearchRunManifestV2.recovery.restartedStimulusIds[${index}]`)),
    },
    build: {
      platform: enumeration(value.build.platform, "ResearchRunManifestV2.build.platform", ["tauri-windows", "chrome", "edge"]),
      appVersion: text(value.build.appVersion, "ResearchRunManifestV2.build.appVersion", { maximum: 40 }),
      buildCommit: text(value.build.buildCommit, "ResearchRunManifestV2.build.buildCommit", { maximum: 64 }),
    },
  };
  if (participantCode !== participantCode.toLocaleUpperCase("und")) throw new TypeError("ResearchRunManifestV2.participantCode must be uppercase.");
  if (new Date(output.timing.finalizedAt) < new Date(output.timing.startedAt)) throw new TypeError("ResearchRunManifestV2 finalization precedes its start.");
  if (output.recovery.resumed !== (output.recovery.sourceRunId !== null)) throw new TypeError("ResearchRunManifestV2 recovery source does not match resumed state.");
  if (new Set(output.recovery.restartedStimulusIds).size !== output.recovery.restartedStimulusIds.length
    || output.recovery.restartedStimulusIds.some((id) => !stimuli.some(({ stimulusId }) => stimulusId === id))) {
    throw new TypeError("ResearchRunManifestV2 recovery stimulus IDs must be unique members of the run assignment.");
  }
  const expectedStem = createSessionStem({
    participantId: output.participantId,
    participantCode: output.participantCode,
    age: output.age,
    gender: output.gender,
    handedness: output.handedness,
    startedAt: output.timing.startedAt,
    attemptNumber: output.attemptNumber,
  });
  if (output.sessionStem !== expectedStem) throw new TypeError("ResearchRunManifestV2.sessionStem does not match its coded participant and start time.");
  const ratingOutputs = output.outputs.filter(({ kind }) => kind === "csv" || kind === "tsv");
  if (ratingOutputs.some(({ rowCount }) => rowCount !== output.timing.sampleCount)) {
    throw new TypeError("ResearchRunManifestV2 rating row counts must equal the canonical sample count.");
  }
  if ((output.timing.gapEventCount === 0) !== (output.timing.missedSlotCount === 0)) {
    throw new TypeError("ResearchRunManifestV2 timing-gap and missed-slot totals are inconsistent.");
  }
  return deepFreeze(output);
}

function flattenLeaves(value, prefix = "", output = []) {
  if (Array.isArray(value)) {
    if (!value.length) output.push([prefix, value]);
    else value.forEach((member, index) => flattenLeaves(member, `${prefix}[${index}]`, output));
  } else if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (!keys.length) output.push([prefix, value]);
    else keys.forEach((key) => flattenLeaves(value[key], prefix ? `${prefix}.${key}` : key, output));
  } else {
    output.push([prefix, value]);
  }
  return output;
}

function legacyBinding(value) {
  if (typeof value !== "string") return null;
  const [kind, control, extra] = value.split(":");
  if (extra !== undefined || !control) return null;
  if (kind === "key" && /^[A-Za-z0-9]+$/u.test(control)) return { kind: "keyboard", code: control };
  if (kind === "wheel" && DIGITAL_DIRECTIONS.includes(control.toLowerCase())) return { kind: "wheel", direction: control.toLowerCase() };
  if (kind === "mouse") {
    const button = { left: 0, middle: 1, right: 2, button4: 3, button5: 4 }[control.toLowerCase()];
    return button === undefined ? null : { kind: "mouseButton", button };
  }
  return null;
}

export function importPortableSettingsV1(value) {
  if (!isPlainObject(value) || value.version !== 1) throw new TypeError("Legacy import requires one portable settings version-1 object.");
  let legacyJson;
  try { legacyJson = canonicalJson(value); } catch (error) {
    throw new TypeError(`Legacy settings are not bounded plain JSON: ${error.message}`);
  }
  if (legacyJson.length > 1_000_000) throw new RangeError("Legacy settings exceed the one-megabyte import limit.");
  const settings = copy(createDefaultResearchSettings());
  const report = [];
  const mappedTargets = new Set();
  const mappedSources = new Set(["version"]);
  const map = (sourcePath, targetPath, apply, message) => {
    const sources = Array.isArray(sourcePath) ? sourcePath : [sourcePath];
    const targets = Array.isArray(targetPath) ? targetPath : [targetPath];
    try {
      apply();
      targets.forEach((path) => mappedTargets.add(path));
      sources.forEach((path) => mappedSources.add(path));
      for (const source of sources) {
        for (const target of targets) report.push({ status: "mapped", sourcePath: source, targetPath: target, message });
      }
    } catch (error) {
      sources.forEach((path) => {
        mappedSources.add(path);
        report.push({ status: "discarded", sourcePath: path, targetPath: null, message: `${message} ${error.message}` });
      });
    }
  };
  if (Number.isSafeInteger(value.lsl?.sampleRate) && value.lsl.sampleRate >= 1 && value.lsl.sampleRate <= 240) {
    map("lsl.sampleRate", "experiment.samplingFrequencyHz", () => { settings.experiment.samplingFrequencyHz = value.lsl.sampleRate; }, "Mapped the legacy LSL rate to the one Research sampling rate.");
  }
  if (Number.isFinite(value.stepSize)) {
    map("stepSize", "input.stepSize", () => { settings.input.stepSize = finiteNumber(value.stepSize, "legacy stepSize", 0.001, 1); }, "Mapped the digital step size.");
  }
  const legacyDirections = {
    up: value.bindings?.increaseArousal,
    down: value.bindings?.decreaseArousal,
    left: value.bindings?.decreaseValence,
    right: value.bindings?.increaseValence,
  };
  if (Object.values(legacyDirections).every((entry) => entry !== undefined)) {
    map([
      "bindings.increaseArousal",
      "bindings.decreaseArousal",
      "bindings.decreaseValence",
      "bindings.increaseValence",
    ], ["input.preset", "input.directions"], () => {
      const converted = Object.fromEntries(Object.entries(legacyDirections).map(([direction, binding]) => {
        const token = legacyBinding(binding);
        if (!token) throw new TypeError(`Unsupported ${direction} binding.`);
        return [direction, token];
      }));
      settings.input = copy(validateInputBindingV1({ ...settings.input, preset: "custom", directions: converted }));
    }, "Mapped the four legacy direction assignments to a custom InputBindingV1.");
  }
  for (const color of ["up", "down", "left", "right"]) {
    if (value.palette?.[color] !== undefined) {
      map(`palette.${color}`, `visual.colors.${color}`, () => {
        if (!HEX_COLOR.test(value.palette[color])) throw new TypeError("Invalid hex color.");
        settings.visual.colors[color] = value.palette[color].toLowerCase();
      }, "Mapped a legacy directional color anchor.");
    }
  }
  if (Number.isFinite(value.overlay?.opacity)) {
    map("overlay.opacity", "visual.transparency", () => {
      settings.visual.transparency = 1 - finiteNumber(value.overlay.opacity, "legacy opacity", 0, 1);
    }, "Converted legacy opacity to Research transparency.");
  }
  if (typeof value.overlay?.visible === "boolean") {
    map("overlay.visible", "visual.hideFeedback", () => { settings.visual.hideFeedback = !value.overlay.visible; }, "Converted legacy overlay visibility to Hide Visual Feedback.");
  }
  for (const [source, target] of [
    ["streamName", "stateStream"],
    ["streamType", "streamType"],
    ["markerName", "markerStream"],
    ["sourceId", "sourceId"],
  ]) {
    if (value.lsl?.[source] !== undefined) {
      map(`lsl.${source}`, `advanced.lsl.${target}`, () => {
        settings.advanced.lsl[target] = text(value.lsl[source], `legacy lsl.${source}`, { maximum: target === "sourceId" ? 120 : 80 });
      }, "Preserved legacy outbound LSL metadata without enabling LSL.");
    }
  }
  const targetLeaves = flattenLeaves(settings);
  for (const [targetPath] of targetLeaves) {
    const covered = [...mappedTargets].some((path) => targetPath === path || targetPath.startsWith(`${path}.`));
    if (!covered) {
      report.push({ status: "defaulted", sourcePath: null, targetPath, message: "Research v1 supplied its canonical default." });
    }
  }
  for (const [sourcePath] of flattenLeaves(value)) {
    const covered = [...mappedSources].some((path) => sourcePath === path || sourcePath.startsWith(`${path}.`));
    if (!covered) report.push({ status: "discarded", sourcePath, targetPath: null, message: "No equivalent Research v1 field exists or conversion would be ambiguous." });
  }
  return deepFreeze({ settings: validateResearchSettingsV1(settings), report });
}
