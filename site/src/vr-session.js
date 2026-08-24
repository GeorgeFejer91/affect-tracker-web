import { normalizePortableSettings } from "./portable-settings.js";

export const VR_SESSION_SCHEMA = "affect-tracker-vr-session";
export const VR_SESSION_VERSION = 1;

export const VR_DEFAULTS = Object.freeze({
  environment: "dark",
  flubber: Object.freeze({
    widthMeters: 0.3,
    distanceMeters: 1.25,
    horizontalOffsetMeters: 0,
    verticalOffsetMeters: -0.3,
    showAffectValues: false,
    controllerFollow: Object.freeze({
      enabled: false,
      hand: "left",
      distanceMeters: 0.18,
    }),
  }),
  controls: Object.freeze({
    stick: "right",
    resetButton: "x",
    pauseButton: "y",
    grabTrigger: "either",
    showControllerModels: true,
  }),
});

const PROJECTIONS = new Set(["flat", "equirect-180", "equirect-360"]);
const STEREO_LAYOUTS = new Set(["mono", "side-by-side-left-right", "top-bottom"]);
const STICKS = new Set(["left", "right"]);
const BUTTONS = new Set(["x", "y", "a", "b", "none"]);
const ENVIRONMENTS = new Set(["dark", "passthrough"]);
const SHA256 = /^[a-f0-9]{64}$/;

function numberInRange(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function enumValue(value, label, allowed) {
  if (!allowed.has(value)) throw new Error(`${label} is not supported.`);
  return value;
}

function safeIdentifier(value, label, maximum = 120) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(value) || value.length > maximum) {
    throw new Error(`${label} must use letters, numbers, dots, underscores, or hyphens.`);
  }
  return value;
}

function safeVideoFileName(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) {
    throw new Error("Video filename is missing or too long.");
  }
  if (value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new Error("Video filename must not contain a path.");
  }
  return value;
}

export function normalizeVrSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Quest session JSON must contain one object.");
  }
  if (value.schema !== VR_SESSION_SCHEMA || value.version !== VR_SESSION_VERSION) {
    throw new Error(`Only ${VR_SESSION_SCHEMA} version ${VR_SESSION_VERSION} is supported.`);
  }

  const video = value.video ?? {};
  const vr = value.vr ?? {};
  const flubber = vr.flubber ?? VR_DEFAULTS.flubber;
  const controls = vr.controls ?? VR_DEFAULTS.controls;
  const byteLength = numberInRange(video.byteLength, "Video byte length", 1, Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(byteLength)) throw new Error("Video byte length must be a safe integer.");
  if (typeof video.sha256 !== "string" || !SHA256.test(video.sha256)) {
    throw new Error("Video SHA-256 must contain 64 lowercase hexadecimal characters.");
  }
  const resetButton = enumValue(controls.resetButton ?? VR_DEFAULTS.controls.resetButton, "Reset button", BUTTONS);
  const pauseButton = enumValue(controls.pauseButton ?? VR_DEFAULTS.controls.pauseButton, "Pause button", BUTTONS);
  if (controls.showControllerModels !== undefined && typeof controls.showControllerModels !== "boolean") {
    throw new Error("Show controller models must be true or false.");
  }
  if (flubber.showAffectValues !== undefined && typeof flubber.showAffectValues !== "boolean") {
    throw new Error("Show X/Y affect coordinates must be true or false.");
  }
  const controllerFollow = flubber.controllerFollow ?? VR_DEFAULTS.flubber.controllerFollow;
  if (!controllerFollow || typeof controllerFollow !== "object" || Array.isArray(controllerFollow)) {
    throw new Error("Controller-follow settings must contain one object.");
  }
  if (controllerFollow.enabled !== undefined && typeof controllerFollow.enabled !== "boolean") {
    throw new Error("Follow a controller must be true or false.");
  }
  if (resetButton !== "none" && resetButton === pauseButton) {
    throw new Error("Reset and pause must not use the same controller button.");
  }

  return {
    schema: VR_SESSION_SCHEMA,
    version: VR_SESSION_VERSION,
    sessionId: safeIdentifier(value.sessionId, "Session ID"),
    video: {
      file: safeVideoFileName(video.file),
      byteLength,
      sha256: video.sha256,
      projection: enumValue(video.projection, "Video projection", PROJECTIONS),
      stereo: enumValue(video.stereo, "Video stereo layout", STEREO_LAYOUTS),
      loop: video.loop === true,
    },
    affectSettings: normalizePortableSettings(value.affectSettings),
    vr: {
      environment: enumValue(vr.environment ?? VR_DEFAULTS.environment, "VR environment", ENVIRONMENTS),
      flubber: {
        widthMeters: numberInRange(flubber.widthMeters, "Flubber width", 0.12, 1.2),
        distanceMeters: numberInRange(flubber.distanceMeters, "Flubber distance", 0.35, 5),
        horizontalOffsetMeters: numberInRange(flubber.horizontalOffsetMeters, "Flubber horizontal offset", -2, 2),
        verticalOffsetMeters: numberInRange(flubber.verticalOffsetMeters, "Flubber vertical offset", -2, 2),
        showAffectValues: flubber.showAffectValues ?? VR_DEFAULTS.flubber.showAffectValues,
        controllerFollow: {
          enabled: controllerFollow.enabled ?? VR_DEFAULTS.flubber.controllerFollow.enabled,
          hand: enumValue(
            controllerFollow.hand ?? VR_DEFAULTS.flubber.controllerFollow.hand,
            "Controller-follow hand",
            STICKS,
          ),
          distanceMeters: numberInRange(
            controllerFollow.distanceMeters ?? VR_DEFAULTS.flubber.controllerFollow.distanceMeters,
            "Controller-follow distance",
            0.05,
            0.6,
          ),
        },
      },
      controls: {
        stick: enumValue(controls.stick ?? VR_DEFAULTS.controls.stick, "Controller stick", STICKS),
        resetButton,
        pauseButton,
        grabTrigger: enumValue(controls.grabTrigger ?? VR_DEFAULTS.controls.grabTrigger, "Grab trigger", new Set(["either"])),
        showControllerModels: controls.showControllerModels ?? VR_DEFAULTS.controls.showControllerModels,
      },
    },
  };
}

export function createVrSession({
  sessionId,
  file,
  sha256,
  projection,
  stereo,
  loop = false,
  affectSettings,
  environment = VR_DEFAULTS.environment,
  flubber = VR_DEFAULTS.flubber,
  controls = VR_DEFAULTS.controls,
}) {
  if (!(file instanceof Blob) || typeof file.name !== "string") {
    throw new Error("Select one local video file.");
  }
  return normalizeVrSession({
    schema: VR_SESSION_SCHEMA,
    version: VR_SESSION_VERSION,
    sessionId,
    video: { file: file.name, byteLength: file.size, sha256, projection, stereo, loop },
    affectSettings,
    vr: { environment, flubber, controls },
  });
}

export function vrSessionJson(value) {
  return `${JSON.stringify(normalizeVrSession(value), null, 2)}\n`;
}

export function hashVideoFile(file, workerFactory = () => new Worker(new URL("./sha256-worker.js", import.meta.url))) {
  if (!(file instanceof Blob)) return Promise.reject(new Error("Select one local video file."));
  return new Promise((resolve, reject) => {
    const worker = workerFactory();
    const finish = () => worker.terminate();
    worker.onmessage = ({ data }) => {
      finish();
      if (data?.ok && SHA256.test(data.sha256)) resolve(data.sha256);
      else reject(new Error(data?.message || "The video could not be hashed."));
    };
    worker.onerror = () => {
      finish();
      reject(new Error("The video hashing worker failed."));
    };
    worker.postMessage({ file });
  });
}
