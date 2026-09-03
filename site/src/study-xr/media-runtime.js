import { deepFreeze } from "./panel-layout.js";

export const PORTABLE_MEDIA_PROJECTIONS = Object.freeze([
  "flat",
  "equirectangular180",
  "equirectangular360",
]);

export const PORTABLE_MEDIA_STEREO_LAYOUTS = Object.freeze([
  "mono",
  "sideBySideLeftRight",
  "topBottom",
]);

const UV_TRANSFORMS = deepFreeze({
  identity: { scale: [1, 1], offset: [0, 0] },
  sideBySideLeft: { scale: [0.5, 1], offset: [0, 0] },
  sideBySideRight: { scale: [0.5, 1], offset: [0.5, 0] },
  topBottomLeft: { scale: [1, 0.5], offset: [0, 0] },
  topBottomRight: { scale: [1, 0.5], offset: [0, 0.5] },
});

function finiteNumber(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError(`${label} must be finite.`);
  return numeric;
}

function assetBinding(assetBindings, assetId) {
  if (assetBindings instanceof Map) return assetBindings.get(assetId);
  if (assetBindings && typeof assetBindings === "object") return assetBindings[assetId];
  return undefined;
}

export function portableVideoClip(asset, source) {
  const clip = source?.clip ?? asset?.defaultClip ?? { startMs: 0, endMs: asset?.durationMs };
  const startMs = finiteNumber(clip?.startMs, "media clip startMs");
  const endMs = finiteNumber(clip?.endMs, "media clip endMs");
  const durationMs = finiteNumber(asset?.durationMs, "media asset durationMs");
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || !Number.isSafeInteger(durationMs)) {
    throw new TypeError("Portable WebXR media times must be safe integer milliseconds.");
  }
  if (startMs < 0 || startMs >= endMs || endMs > durationMs) {
    throw new RangeError("Portable WebXR media clip bounds must be ordered and within the asset duration.");
  }
  return deepFreeze({ startMs, endMs, durationMs: endMs - startMs });
}

export function validatePortableDecodedMedia(asset, {
  durationMs,
  videoWidth,
  videoHeight,
} = {}, { durationToleranceMs = 250 } = {}) {
  const observedDurationMs = finiteNumber(durationMs, "decoded media durationMs");
  const declaredDurationMs = finiteNumber(asset?.durationMs, "media asset durationMs");
  const width = finiteNumber(videoWidth, "decoded media videoWidth");
  const height = finiteNumber(videoHeight, "decoded media videoHeight");
  const tolerance = finiteNumber(durationToleranceMs, "durationToleranceMs");
  if (observedDurationMs <= 0 || !Number.isSafeInteger(declaredDurationMs) || declaredDurationMs <= 0) {
    throw new RangeError("Decoded and published media durations must be positive.");
  }
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new RangeError("The selected media must expose a decoded video frame.");
  }
  if (tolerance < 0 || tolerance > 2_000) {
    throw new RangeError("durationToleranceMs must be within 0..=2000.");
  }
  if (Math.abs(observedDurationMs - declaredDurationMs) > tolerance) {
    throw new RangeError(
      `Decoded duration ${Math.round(observedDurationMs)} ms does not match published duration ${declaredDurationMs} ms.`,
    );
  }
  return deepFreeze({
    durationMs: observedDurationMs,
    videoWidth: width,
    videoHeight: height,
  });
}

export function resolvePortableVideoBlock(study, block, assetBindings) {
  if (block?.type !== "video") throw new TypeError("Expected a portable video block.");
  if (block.source?.kind === "youtube") {
    throw new Error("YouTube is Pages 2D-only and cannot run in portable WebXR.");
  }
  if (block.source?.kind !== "contentAsset") {
    throw new Error("Portable WebXR video requires a content-addressed asset.");
  }
  const asset = (study?.media ?? []).find(({ assetId }) => assetId === block.source.assetId);
  if (!asset) throw new Error(`Portable media asset ${block.source.assetId} is unavailable.`);
  if (!PORTABLE_MEDIA_PROJECTIONS.includes(asset.projection)) {
    throw new Error(`Portable WebXR does not support projection ${asset.projection}.`);
  }
  if (!PORTABLE_MEDIA_STEREO_LAYOUTS.includes(asset.stereoLayout)) {
    throw new Error(`Portable WebXR does not support stereo layout ${asset.stereoLayout}.`);
  }
  const file = assetBinding(assetBindings, asset.assetId);
  if (!file || !Number.isSafeInteger(file.size) || file.size !== asset.byteLength) {
    throw new Error(`Portable media asset ${asset.assetId} is not bound to its verified local file.`);
  }
  const descriptor = deepFreeze({
    blockId: block.blockId,
    purpose: block.purpose,
    collectAffect: block.collectAffect === true,
    asset: {
      ...asset,
      ...(asset.defaultClip ? { defaultClip: { ...asset.defaultClip } } : {}),
      requiredCapabilities: [...(asset.requiredCapabilities ?? [])],
    },
    clip: portableVideoClip(asset, block.source),
  });
  // Keep the browser File/Blob outside the recursively frozen protocol descriptor.
  return Object.freeze({ descriptor, file });
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function portableMediaPositionMs(descriptor, currentTimeSeconds) {
  const absoluteMs = finiteNumber(currentTimeSeconds, "media currentTime") * 1_000;
  return Math.round(clamp(
    absoluteMs - descriptor.clip.startMs,
    0,
    descriptor.clip.durationMs,
  ));
}

export function evaluatePortableMediaObservation(descriptor, {
  currentTimeSeconds,
  paused,
  ended,
  seeking,
  readyState,
  stalled = false,
  completionToleranceMs = 1,
} = {}) {
  const absolutePositionMs = finiteNumber(currentTimeSeconds, "media currentTime") * 1_000;
  const tolerance = finiteNumber(completionToleranceMs, "completionToleranceMs");
  if (tolerance < 0 || tolerance > 250) {
    throw new RangeError("completionToleranceMs must be within 0..=250.");
  }
  const relativePositionMs = portableMediaPositionMs(descriptor, currentTimeSeconds);
  const segmentComplete = absolutePositionMs >= descriptor.clip.endMs - tolerance;
  const hasFrame = Number.isFinite(Number(readyState)) && Number(readyState) >= 2;
  const withinClip = absolutePositionMs >= descriptor.clip.startMs - tolerance && !segmentComplete;
  const active = hasFrame
    && paused !== true
    && ended !== true
    && seeking !== true
    && stalled !== true
    && withinClip;
  return deepFreeze({
    absolutePositionMs,
    relativePositionMs,
    segmentComplete,
    active,
    hasFrame,
  });
}

export function reducePortableMediaControl(media, intent) {
  if (!media || !intent) return null;
  if (intent.type === "activate") {
    if (media.segmentComplete) return deepFreeze({ type: "advance" });
    if (!media.ready || media.fatalError) return null;
    return deepFreeze({ type: media.active ? "pause" : "play" });
  }
  if (intent.type === "back" && media.active) return deepFreeze({ type: "pause" });
  return null;
}

export function portableSampleSchedule({
  nowMs,
  nextDueMs,
  sampleRateHz,
  active,
  authorityPlaying,
  pending,
}) {
  const now = finiteNumber(nowMs, "nowMs");
  const rate = finiteNumber(sampleRateHz, "sampleRateHz");
  if (rate < 1 || rate > 240) throw new RangeError("sampleRateHz must be within 1..=240.");
  const intervalMs = 1_000 / rate;
  if (!active || !authorityPlaying) {
    return deepFreeze({ due: false, nextDueMs: null, intervalMs, gapMs: 0 });
  }
  const dueAt = Number.isFinite(nextDueMs) ? nextDueMs : now;
  if (pending || now < dueAt) {
    return deepFreeze({ due: false, nextDueMs: dueAt, intervalMs, gapMs: 0 });
  }
  // Advance from the observed frame, never by multiple historical intervals. A
  // slow journal therefore creates an explicit timing gap rather than invented samples.
  return deepFreeze({
    due: true,
    nextDueMs: now + intervalMs,
    intervalMs,
    gapMs: Math.max(0, now - dueAt),
  });
}

export function portableStereoUvTransform(stereoLayout, eye = "none") {
  if (!PORTABLE_MEDIA_STEREO_LAYOUTS.includes(stereoLayout)) {
    throw new TypeError(`Unsupported portable stereo layout ${stereoLayout}.`);
  }
  if (!["left", "right", "none"].includes(eye)) throw new TypeError(`Unsupported XR eye ${eye}.`);
  if (stereoLayout === "mono" || eye === "none") {
    return UV_TRANSFORMS.identity;
  }
  if (stereoLayout === "sideBySideLeftRight") {
    return eye === "right" ? UV_TRANSFORMS.sideBySideRight : UV_TRANSFORMS.sideBySideLeft;
  }
  // UNPACK_FLIP_Y_WEBGL makes v=0 address the original media's top row.
  return eye === "right" ? UV_TRANSFORMS.topBottomRight : UV_TRANSFORMS.topBottomLeft;
}

export function createEquirectangularMediaVertices({
  horizontalDegrees = 360,
  latitudeBands = 32,
  longitudeBands = 64,
} = {}) {
  if (![180, 360].includes(horizontalDegrees)) {
    throw new RangeError("horizontalDegrees must be 180 or 360.");
  }
  if (!Number.isInteger(latitudeBands) || latitudeBands < 2) {
    throw new RangeError("latitudeBands must be an integer of at least 2.");
  }
  if (!Number.isInteger(longitudeBands) || longitudeBands < 3) {
    throw new RangeError("longitudeBands must be an integer of at least 3.");
  }

  const vertices = [];
  const horizontalRadians = horizontalDegrees * Math.PI / 180;
  const point = (latitude, longitude) => {
    const latitudeRatio = latitude / latitudeBands;
    const longitudeRatio = longitude / longitudeBands;
    const phi = latitudeRatio * Math.PI;
    const theta = (longitudeRatio - 0.5) * horizontalRadians;
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
