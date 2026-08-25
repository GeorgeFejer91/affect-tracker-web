import { performance } from "node:perf_hooks";
import {
  buildFlubberPath,
  createProfiles,
  createProjectionOffsets,
  FLUBBER_BASE_SHAPES,
} from "../site/src/math.js";

const DEFAULT_FRAME_COUNT = 60 * 60 * 30;
const requestedFrames = Number.parseInt(process.env.FLUBBER_STRESS_FRAMES ?? String(DEFAULT_FRAME_COUNT), 10);
if (!Number.isSafeInteger(requestedFrames) || requestedFrames < FLUBBER_BASE_SHAPES.length) {
  throw new RangeError("FLUBBER_STRESS_FRAMES must be an integer covering every base shape.");
}

const profiles = createProfiles();
const offsets = createProjectionOffsets("flubber-shape-stress", profiles.waveCount);
let checksum = 0;
let maximumPathLength = 0;
const startedAt = performance.now();

for (let frame = 0; frame < requestedFrames; frame += 1) {
  const baseShape = FLUBBER_BASE_SHAPES[frame % FLUBBER_BASE_SHAPES.length];
  const x = Math.sin(frame * 0.0137);
  const y = Math.cos(frame * 0.0179);
  const phase = (frame / 60) * Math.PI * 2 * (1.5 + y);
  const amplitudeScale = (frame % 201) / 100;
  const disorderScale = ((frame * 37) % 201) / 100;
  const result = buildFlubberPath({
    profiles,
    offsets,
    x,
    y,
    phase,
    amplitudeScale,
    disorderScale,
    baseShape,
    reducedMotion: frame % 997 === 0,
  });
  if (!result.path.startsWith("M") || !result.path.endsWith("Z") || /NaN|Infinity/.test(result.path)) {
    throw new Error(`Invalid ${baseShape} path at stress frame ${frame}.`);
  }
  if (frame % 3_600 === 0 && (result.path.match(/L/g) ?? []).length !== profiles.vertexCount - 1) {
    throw new Error(`Unexpected vertex count at stress frame ${frame}.`);
  }
  maximumPathLength = Math.max(maximumPathLength, result.path.length);
  checksum = (checksum + result.path.length + result.path.charCodeAt(frame % result.path.length)) >>> 0;
}

const elapsedMs = performance.now() - startedAt;
const summary = {
  frames: requestedFrames,
  simulatedMinutesAt60Hz: Number((requestedFrames / 60 / 60).toFixed(3)),
  shapes: FLUBBER_BASE_SHAPES,
  elapsedMs: Number(elapsedMs.toFixed(1)),
  averageMsPerFrame: Number((elapsedMs / requestedFrames).toFixed(6)),
  maximumPathLength,
  checksum,
};

if (!Number.isFinite(summary.averageMsPerFrame) || checksum === 0) {
  throw new Error("Flubber stress run did not produce a finite result.");
}
console.log(JSON.stringify(summary));
