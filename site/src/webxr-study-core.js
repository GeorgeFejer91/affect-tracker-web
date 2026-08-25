import { clamp, smoothToward } from "./math.js";

export const WEBXR_SAMPLE_INTERVAL_MS = 50;
export const WEBXR_CONTINUOUS_SPEED = 0.8;
export const WEBXR_RESPONSE = 8;
export const WEBXR_STICK_DEAD_ZONE = 0.15;
export const WEBXR_CONTROLLER_VERTICAL_OFFSET_M = 0.16;

export function normalizeStickAxis(value, deadZone = WEBXR_STICK_DEAD_ZONE) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const bounded = clamp(numeric);
  const magnitude = Math.abs(bounded);
  if (magnitude <= deadZone) return 0;
  return Math.sign(bounded) * ((magnitude - deadZone) / (1 - deadZone));
}

export function controllerAxes(gamepad) {
  const axes = Array.from(gamepad?.axes ?? []);
  if (axes.length >= 4) return { x: normalizeStickAxis(axes[2]), y: normalizeStickAxis(-axes[3]) };
  if (axes.length >= 2) return { x: normalizeStickAxis(axes[0]), y: normalizeStickAxis(-axes[1]) };
  return { x: 0, y: 0 };
}

export function readQuestControllerState(inputSources) {
  const controllers = Array.from(inputSources ?? []).filter((source) => source?.gamepad);
  const right = controllers.find((source) => source.handedness === "right") ?? controllers[0];
  const left = controllers.find((source) => source.handedness === "left");
  const axes = controllerAxes(right?.gamepad);
  return {
    ...axes,
    hand: right?.handedness || "unknown",
    reset: Boolean(left?.gamepad?.buttons?.[4]?.pressed),
    pause: Boolean(left?.gamepad?.buttons?.[5]?.pressed),
  };
}

export function advanceWebXrAffect(
  state,
  input,
  deltaSeconds,
  { speed = WEBXR_CONTINUOUS_SPEED, response = WEBXR_RESPONSE } = {},
) {
  const dt = clamp(Number(deltaSeconds) || 0, 0, 0.05);
  const targetX = clamp(state.targetX + input.x * speed * dt);
  const targetY = clamp(state.targetY + input.y * speed * dt);
  return {
    targetX,
    targetY,
    currentX: smoothToward(state.currentX, targetX, response, dt),
    currentY: smoothToward(state.currentY, targetY, response, dt),
  };
}

export function advanceWebXrAffectWithPolar(
  state,
  input,
  deltaSeconds,
  polarTargets = {},
  options,
) {
  const polarX = Number.isFinite(polarTargets.x) ? clamp(polarTargets.x) : undefined;
  const polarY = Number.isFinite(polarTargets.y) ? clamp(polarTargets.y) : undefined;
  return advanceWebXrAffect(
    {
      ...state,
      targetX: polarX ?? state.targetX,
      targetY: polarY ?? state.targetY,
    },
    {
      ...input,
      x: polarX === undefined ? input.x : 0,
      y: polarY === undefined ? input.y : 0,
    },
    deltaSeconds,
    options,
  );
}

export function applyWebXrRemoteCoordinates(state, remoteSnapshot) {
  const latest = remoteSnapshot?.enabled ? remoteSnapshot.latest : undefined;
  if (!latest || !Number.isFinite(latest.currentX) || !Number.isFinite(latest.currentY)) return undefined;
  const currentX = clamp(latest.currentX);
  const currentY = clamp(latest.currentY);
  return {
    targetX: currentX,
    targetY: currentY,
    currentX,
    currentY,
  };
}

export function normalizeWebhookUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TypeError("Enter a complete HTTPS webhook URL.");
  }
  if (url.protocol !== "https:") throw new TypeError("The webhook must use HTTPS.");
  url.hash = "";
  return url.href;
}

export const WEBXR_CSV_COLUMNS = Object.freeze([
  "session_id",
  "stimulus_id",
  "stimulus_title",
  "stimulus_collection",
  "stimulus_projection",
  "stimulus_source_start_seconds",
  "stimulus_frame_count",
  "stimulus_pilot_valence",
  "stimulus_pilot_arousal",
  "record_type",
  "iso_time",
  "monotonic_ms",
  "elapsed_ms",
  "video_time_seconds",
  "current_valence",
  "current_arousal",
  "target_valence",
  "target_arousal",
  "stick_x",
  "stick_y",
  "controller_hand",
  "presentation_mode",
  "flubber_controller_follow",
  "flubber_follow_hand",
  "flubber_size_scale",
  "flubber_base_shape",
  "flubber_tracking",
  "polar_connected",
  "polar_valence_metric",
  "polar_valence_value",
  "polar_valence_normalized",
  "polar_arousal_metric",
  "polar_arousal_value",
  "polar_arousal_normalized",
  "remote_enabled",
  "remote_source",
  "remote_signal_state",
  "remote_sequence",
  "remote_packet_age_ms",
  "paused",
  "event",
  "detail",
]);

function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function webXrCsv(records) {
  const lines = [WEBXR_CSV_COLUMNS.join(",")];
  for (const record of records) {
    lines.push(WEBXR_CSV_COLUMNS.map((column) => csvCell(record[column])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function multiplyMatrices(left, right) {
  const result = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let index = 0; index < 4; index += 1) {
        value += left[index * 4 + row] * right[column * 4 + index];
      }
      result[column * 4 + row] = value;
    }
  }
  return result;
}

export function matrixWithoutTranslation(matrix, result = new Float32Array(16)) {
  result.set(matrix);
  result[12] = 0;
  result[13] = 0;
  result[14] = 0;
  return result;
}

export function createEquirectSphereVertices(latitudeBands = 32, longitudeBands = 64) {
  if (!Number.isInteger(latitudeBands) || latitudeBands < 2) {
    throw new RangeError("latitudeBands must be an integer of at least 2.");
  }
  if (!Number.isInteger(longitudeBands) || longitudeBands < 3) {
    throw new RangeError("longitudeBands must be an integer of at least 3.");
  }

  const vertices = [];
  const point = (latitude, longitude) => {
    const latitudeRatio = latitude / latitudeBands;
    const longitudeRatio = longitude / longitudeBands;
    const phi = latitudeRatio * Math.PI;
    const theta = (longitudeRatio - 0.5) * Math.PI * 2;
    const radial = Math.sin(phi);
    return [
      Math.sin(theta) * radial,
      Math.cos(phi),
      -Math.cos(theta) * radial,
      longitudeRatio,
      1 - latitudeRatio,
    ];
  };
  const append = (value) => vertices.push(...value);

  for (let latitude = 0; latitude < latitudeBands; latitude += 1) {
    for (let longitude = 0; longitude < longitudeBands; longitude += 1) {
      const topLeft = point(latitude, longitude);
      const bottomLeft = point(latitude + 1, longitude);
      const bottomRight = point(latitude + 1, longitude + 1);
      const topRight = point(latitude, longitude + 1);
      append(topLeft);
      append(bottomLeft);
      append(bottomRight);
      append(topLeft);
      append(bottomRight);
      append(topRight);
    }
  }
  return new Float32Array(vertices);
}

export function modelMatrix(x, y, z, width, height) {
  return new Float32Array([
    width, 0, 0, 0,
    0, height, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ]);
}

export function controllerFacingModelMatrix(
  controllerPosition,
  viewerPosition,
  width,
  height,
  verticalOffset = WEBXR_CONTROLLER_VERTICAL_OFFSET_M,
) {
  const values = [
    controllerPosition?.x, controllerPosition?.y, controllerPosition?.z,
    viewerPosition?.x, viewerPosition?.y, viewerPosition?.z,
    width, height, verticalOffset,
  ].map(Number);
  if (!values.every(Number.isFinite)) throw new TypeError("Controller rig values must be finite.");

  const [cx, cy, cz, vx, vy, vz] = values;
  const x = cx;
  const y = cy + verticalOffset;
  const z = cz;
  let dx = vx - x;
  let dy = vy - y;
  let dz = vz - z;
  let length = Math.hypot(dx, dy, dz);
  if (length < 1e-6) {
    dx = 0;
    dy = 0;
    dz = 1;
    length = 1;
  }
  const forward = [dx / length, dy / length, dz / length];
  let right = [forward[2], 0, -forward[0]];
  let rightLength = Math.hypot(...right);
  if (rightLength < 1e-6) {
    right = [1, 0, 0];
    rightLength = 1;
  }
  right = right.map((component) => component / rightLength);
  const up = [
    forward[1] * right[2] - forward[2] * right[1],
    forward[2] * right[0] - forward[0] * right[2],
    forward[0] * right[1] - forward[1] * right[0],
  ];
  return new Float32Array([
    right[0] * width, right[1] * width, right[2] * width, 0,
    up[0] * height, up[1] * height, up[2] * height, 0,
    forward[0], forward[1], forward[2], 0,
    x, y, z, 1,
  ]);
}
