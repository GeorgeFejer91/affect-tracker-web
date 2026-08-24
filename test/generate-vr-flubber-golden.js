import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  affectPaletteColor,
  buildFlubberPath,
  createProfiles,
  createProjectionOffsets,
  smoothToward,
} from "../site/src/math.js";

const DEFAULT_PALETTE = Object.freeze({
  up: "#ffd166",
  down: "#5c7cfa",
  left: "#ff5b68",
  right: "#5dffb0",
});

const CASES = Object.freeze([
  { name: "neutral", seed: "golden-v1", x: 0, y: 0, phase: 0 },
  { name: "negative-extrema", seed: "golden-v1", x: -1, y: -1, phase: 0.75 },
  { name: "positive-extrema", seed: "golden-v1", x: 1, y: 1, phase: 2.25 },
  { name: "diagonal", seed: "golden-v1", x: 0.5, y: -0.5, phase: 5 },
  { name: "scaled", seed: "advanced-geometry", x: -0.5, y: 0.5, phase: 1, amplitudeScale: 1.8, disorderScale: 0.2 },
  { name: "reduced-motion", seed: "alternate-seed", x: -0.25, y: 0.8, phase: 11.5, reducedMotion: true },
]);

function coordinates(path) {
  return [...path.matchAll(/[ML](-?\d+\.\d+),(-?\d+\.\d+)/g)]
    .map((match) => [Number(match[1]), Number(match[2])]
      .map((value) => (Object.is(value, -0) ? 0 : value)));
}

export function createGoldenFixture() {
  const profiles = createProfiles();
  const cases = CASES.map((entry) => {
    const palette = entry.name === "scaled"
      ? { up: "#ff0000", down: "#00ff00", left: "#0000ff", right: "#ffffff" }
      : DEFAULT_PALETTE;
    const result = buildFlubberPath({
      profiles,
      offsets: createProjectionOffsets(entry.seed),
      x: entry.x,
      y: entry.y,
      phase: entry.phase,
      palette,
      amplitudeScale: entry.amplitudeScale ?? 1,
      disorderScale: entry.disorderScale ?? 1,
      reducedMotion: entry.reducedMotion ?? false,
    });
    return {
      ...entry,
      amplitudeScale: entry.amplitudeScale ?? 1,
      disorderScale: entry.disorderScale ?? 1,
      reducedMotion: entry.reducedMotion ?? false,
      palette,
      color: affectPaletteColor(entry.x, entry.y, palette),
      vertices: coordinates(result.path),
    };
  });
  const smoothing = [
    { current: 0, target: 1, response: 8, deltaSeconds: 0.1 },
    { current: -0.75, target: 0.6, response: 2.5, deltaSeconds: 1 / 72 },
    { current: 0.9, target: -1, response: 16, deltaSeconds: 1 / 120 },
  ].map((entry) => ({ ...entry, expected: smoothToward(entry.current, entry.target, entry.response, entry.deltaSeconds) }));
  return { schema: "affect-tracker-flubber-golden", version: 1, vertexCount: 192, waveCount: 16, tolerance: 0.0002, cases, smoothing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const destination = fileURLToPath(new URL("../vr/contracts/flubber-golden-v1.json", import.meta.url));
  writeFileSync(destination, `${JSON.stringify(createGoldenFixture(), null, 2)}\n`, "utf8");
}
