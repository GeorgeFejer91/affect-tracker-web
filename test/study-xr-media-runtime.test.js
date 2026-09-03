import assert from "node:assert/strict";
import test from "node:test";

import {
  createEquirectangularMediaVertices,
  evaluatePortableMediaObservation,
  portableMediaPositionMs,
  portableSampleSchedule,
  portableStereoUvTransform,
  portableVideoClip,
  reducePortableMediaControl,
  resolvePortableVideoBlock,
  validatePortableDecodedMedia,
} from "../site/src/study-xr/index.js";

const asset = {
  assetId: "stimulus-a",
  sha256: "a".repeat(64),
  byteLength: 12,
  mimeType: "video/mp4",
  container: "mp4",
  durationMs: 12_000,
  hasAudio: true,
  projection: "equirectangular180",
  stereoLayout: "sideBySideLeftRight",
  defaultClip: { startMs: 1_000, endMs: 11_000 },
  requiredCapabilities: [],
};

const block = {
  type: "video",
  blockId: "video-a",
  purpose: "stimulus",
  source: { kind: "contentAsset", assetId: "stimulus-a", clip: { startMs: 2_000, endMs: 8_000 } },
  collectAffect: true,
};

test("portable media resolution retains the verified file and resolves clip precedence", () => {
  const file = new Blob([new Uint8Array(12)], { type: "video/mp4" });
  const resolved = resolvePortableVideoBlock({ media: [asset] }, block, new Map([[asset.assetId, file]]));
  assert.strictEqual(resolved.file, file);
  assert.deepEqual(resolved.descriptor.clip, { startMs: 2_000, endMs: 8_000, durationMs: 6_000 });
  assert.equal(resolved.descriptor.collectAffect, true);
  assert.equal(Object.isFrozen(resolved.descriptor.asset), true);
  assert.equal(Object.isFrozen(asset.defaultClip), false);
  assert.equal(Object.isFrozen(asset.requiredCapabilities), false);
  assert.deepEqual(portableVideoClip(asset, { kind: "contentAsset" }), {
    startMs: 1_000,
    endMs: 11_000,
    durationMs: 10_000,
  });
});

test("portable media resolution fails closed for missing bindings and browser-only sources", () => {
  assert.throws(() => resolvePortableVideoBlock({ media: [asset] }, block, new Map()), /not bound/);
  assert.throws(() => resolvePortableVideoBlock(
    { media: [asset] },
    { ...block, source: { kind: "youtube", videoId: "example", startMs: 0, endMs: 1_000 } },
    new Map(),
  ), /Pages 2D-only/);
  assert.throws(() => portableVideoClip(asset, { clip: { startMs: 8_000, endMs: 2_000 } }), /bounds/);
});

test("decoded media preflight requires a real frame and published duration", () => {
  assert.deepEqual(validatePortableDecodedMedia(asset, {
    durationMs: 12_120,
    videoWidth: 3840,
    videoHeight: 1920,
  }), { durationMs: 12_120, videoWidth: 3840, videoHeight: 1920 });
  assert.throws(() => validatePortableDecodedMedia(asset, {
    durationMs: 13_000,
    videoWidth: 3840,
    videoHeight: 1920,
  }), /does not match/);
  assert.throws(() => validatePortableDecodedMedia(asset, {
    durationMs: 12_000,
    videoWidth: 0,
    videoHeight: 0,
  }), /decoded video frame/);
});

test("media observations use relative clip time and require a current decoded frame", () => {
  const descriptor = resolvePortableVideoBlock(
    { media: [asset] },
    block,
    new Map([[asset.assetId, new Blob([new Uint8Array(12)])]]),
  ).descriptor;
  assert.equal(portableMediaPositionMs(descriptor, 4.25), 2_250);
  assert.deepEqual(evaluatePortableMediaObservation(descriptor, {
    currentTimeSeconds: 4.25,
    paused: false,
    ended: false,
    seeking: false,
    readyState: 4,
  }), {
    absolutePositionMs: 4_250,
    relativePositionMs: 2_250,
    segmentComplete: false,
    active: true,
    hasFrame: true,
  });
  assert.equal(evaluatePortableMediaObservation(descriptor, {
    currentTimeSeconds: 8,
    paused: false,
    readyState: 4,
  }).segmentComplete, true);
  assert.equal(evaluatePortableMediaObservation(descriptor, {
    currentTimeSeconds: 7.99,
    paused: false,
    readyState: 4,
  }).segmentComplete, false);
  assert.equal(evaluatePortableMediaObservation(descriptor, {
    currentTimeSeconds: 4.25,
    paused: false,
    readyState: 1,
  }).active, false);
});

test("video controls gate advance on segment completion", () => {
  assert.deepEqual(reducePortableMediaControl({ segmentComplete: true }, { type: "activate" }), { type: "advance" });
  assert.deepEqual(reducePortableMediaControl({ ready: true, active: true }, { type: "activate" }), { type: "pause" });
  assert.deepEqual(reducePortableMediaControl({ ready: true, active: false }, { type: "activate" }), { type: "play" });
  assert.deepEqual(reducePortableMediaControl({
    ready: true,
    active: false,
    errorMessage: "Press the right trigger to start.",
  }, { type: "activate" }), { type: "play" });
  assert.equal(reducePortableMediaControl({ ready: false, active: false }, { type: "activate" }), null);
  assert.equal(reducePortableMediaControl({ ready: true, fatalError: true }, { type: "activate" }), null);
});

test("sampling schedules at the pinned rate without backfilling missed intervals", () => {
  const first = portableSampleSchedule({
    nowMs: 1_000,
    nextDueMs: null,
    sampleRateHz: 20,
    active: true,
    authorityPlaying: true,
    pending: false,
  });
  assert.equal(first.due, true);
  assert.equal(first.nextDueMs, 1_050);
  const late = portableSampleSchedule({
    nowMs: 1_225,
    nextDueMs: first.nextDueMs,
    sampleRateHz: 20,
    active: true,
    authorityPlaying: true,
    pending: false,
  });
  assert.equal(late.due, true);
  assert.equal(late.gapMs, 175);
  assert.equal(late.nextDueMs, 1_275);
  assert.equal(portableSampleSchedule({
    nowMs: 1_300,
    nextDueMs: late.nextDueMs,
    sampleRateHz: 20,
    active: false,
    authorityPlaying: true,
    pending: false,
  }).nextDueMs, null);
});

test("stereo UV mapping assigns left/right halves deterministically", () => {
  assert.deepEqual(portableStereoUvTransform("mono", "left"), { scale: [1, 1], offset: [0, 0] });
  assert.deepEqual(portableStereoUvTransform("sideBySideLeftRight", "left"), { scale: [0.5, 1], offset: [0, 0] });
  assert.deepEqual(portableStereoUvTransform("sideBySideLeftRight", "right"), { scale: [0.5, 1], offset: [0.5, 0] });
  assert.deepEqual(portableStereoUvTransform("topBottom", "left"), { scale: [1, 0.5], offset: [0, 0] });
  assert.deepEqual(portableStereoUvTransform("topBottom", "right"), { scale: [1, 0.5], offset: [0, 0.5] });
});

test("180 media geometry covers only the forward hemisphere while 360 closes the sphere", () => {
  const half = createEquirectangularMediaVertices({ horizontalDegrees: 180, latitudeBands: 4, longitudeBands: 8 });
  const full = createEquirectangularMediaVertices({ horizontalDegrees: 360, latitudeBands: 4, longitudeBands: 8 });
  assert.equal(half.length, 4 * 8 * 6 * 5);
  assert.equal(full.length, half.length);
  for (let index = 2; index < half.length; index += 5) assert.ok(half[index] <= 1e-9);
  assert.ok([...Array(full.length / 5).keys()].some((index) => full[index * 5 + 2] > 0.5));
});
