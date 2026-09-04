export const MAPPING_DRIVERS = Object.freeze(["x-axis", "y-axis", "angle", "radius"]);

export const FLUBBER_MAPPING_SPECS = Object.freeze({
  oscillationFrequency: Object.freeze({
    label: "Oscillation Frequency",
    unit: "Hz",
    allowedMin: 0,
    allowedMax: 10,
    defaultMin: 0.5,
    defaultMax: 2.5,
    defaultDriver: "y-axis",
    defaultReverse: false,
  }),
  edgeSmoothness: Object.freeze({
    label: "Edge Smoothness",
    unit: "",
    allowedMin: 0,
    allowedMax: 1,
    defaultMin: 0,
    defaultMax: 1,
    defaultDriver: "x-axis",
    defaultReverse: false,
  }),
  projectionAmplitude: Object.freeze({
    label: "Projection Amplitude",
    unit: "",
    allowedMin: 0,
    allowedMax: 1,
    defaultMin: 0.2,
    defaultMax: 0.4,
    defaultDriver: "y-axis",
    defaultReverse: false,
  }),
  pulseSynchrony: Object.freeze({
    label: "Pulse Synchrony",
    unit: "",
    allowedMin: 0,
    allowedMax: 1,
    defaultMin: 0.2,
    defaultMax: 1,
    defaultDriver: "x-axis",
    defaultReverse: false,
  }),
  waveSizeVariation: Object.freeze({
    label: "Wave-size Variation",
    unit: "",
    allowedMin: 0,
    allowedMax: 1,
    defaultMin: 0,
    defaultMax: 0.8,
    defaultDriver: "x-axis",
    defaultReverse: true,
  }),
  saturation: Object.freeze({
    label: "Saturation",
    unit: "",
    allowedMin: 0,
    allowedMax: 1,
    defaultMin: 0,
    defaultMax: 1,
    defaultDriver: "radius",
    defaultReverse: false,
  }),
});

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite.`);
  return value;
}

export function createDefaultFlubberMappings() {
  return Object.fromEntries(Object.entries(FLUBBER_MAPPING_SPECS).map(([id, spec]) => [id, {
    min: spec.defaultMin,
    max: spec.defaultMax,
    drivenBy: spec.defaultDriver,
    reverse: spec.defaultReverse,
  }]));
}

export function affectCoordinates(x, y) {
  const boundedX = clamp(finite(x, "Valence"), -1, 1);
  const boundedY = clamp(finite(y, "Arousal"), -1, 1);
  const rawRadius = Math.hypot(boundedX, boundedY);
  const radius = clamp(rawRadius, 0, 1);
  const angleDegrees = rawRadius === 0
    ? 0
    : (Math.atan2(boundedY, boundedX) * 180 / Math.PI + 360) % 360;
  return Object.freeze({ x: boundedX, y: boundedY, radius, angleDegrees });
}

export function normalizedDriver(driver, coordinates) {
  if (!MAPPING_DRIVERS.includes(driver)) throw new TypeError(`Unsupported mapping driver: ${driver}.`);
  const snapshot = affectCoordinates(coordinates?.x, coordinates?.y);
  if (driver === "x-axis") return (snapshot.x + 1) / 2;
  if (driver === "y-axis") return (snapshot.y + 1) / 2;
  if (driver === "radius") return snapshot.radius;
  return snapshot.angleDegrees / 360;
}

export function validateFlubberMapping(mappingId, mapping) {
  const spec = FLUBBER_MAPPING_SPECS[mappingId];
  if (!spec) throw new TypeError(`Unsupported Flubber mapping: ${mappingId}.`);
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    throw new TypeError(`${spec.label} must be an object.`);
  }
  const allowed = new Set(["min", "max", "drivenBy", "reverse"]);
  const unknown = Object.keys(mapping).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TypeError(`${spec.label} contains unknown field ${unknown[0]}.`);
  if (Object.keys(mapping).length !== allowed.size || [...allowed].some((key) => !Object.hasOwn(mapping, key))) {
    throw new TypeError(`${spec.label} must define Min, Max, Driven By, and Reverse.`);
  }
  const min = finite(mapping.min, `${spec.label} minimum`);
  const max = finite(mapping.max, `${spec.label} maximum`);
  if (min < spec.allowedMin || min > spec.allowedMax || max < spec.allowedMin || max > spec.allowedMax) {
    throw new RangeError(`${spec.label} values must be within ${spec.allowedMin}–${spec.allowedMax}.`);
  }
  if (min > max) throw new RangeError(`${spec.label} minimum must not exceed its maximum.`);
  if (!MAPPING_DRIVERS.includes(mapping.drivenBy)) {
    throw new TypeError(`${spec.label} has an unsupported driver.`);
  }
  if (typeof mapping.reverse !== "boolean") throw new TypeError(`${spec.label} Reverse must be a boolean.`);
  return Object.freeze({ min, max, drivenBy: mapping.drivenBy, reverse: mapping.reverse });
}

export function evaluateFlubberMapping(mappingId, mapping, coordinates) {
  const normalized = validateFlubberMapping(mappingId, mapping);
  const rawT = normalizedDriver(normalized.drivenBy, coordinates);
  const t = normalized.reverse ? 1 - rawT : rawT;
  return normalized.min + (normalized.max - normalized.min) * t;
}

export function evaluateFlubberMappings(mappings, coordinates) {
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) {
    throw new TypeError("Flubber mappings must be an object.");
  }
  const expected = Object.keys(FLUBBER_MAPPING_SPECS);
  const unknown = Object.keys(mappings).filter((key) => !expected.includes(key));
  if (unknown.length || expected.some((key) => !(key in mappings))) {
    throw new TypeError("Flubber mappings must contain exactly the six Research v1 mappings.");
  }
  return Object.freeze(Object.fromEntries(expected.map((id) => [
    id,
    evaluateFlubberMapping(id, mappings[id], coordinates),
  ])));
}
