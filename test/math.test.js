import test from "node:test";
import assert from "node:assert/strict";
import {
  affectPaletteColor,
  affectParameters,
  buildFlubberPath,
  createProfiles,
  createProjectionOffsets,
  FLUBBER_BASE_SHAPES,
  smoothToward,
} from "../site/src/math.js";

test("arousal maps to the expected frequency and amplitude extrema", () => {
  const expected = [[0.5, 0.2], [1.5, 0.3], [2.5, 0.4]];
  [-1, 0, 1].forEach((y, index) => {
    const result = affectParameters(0, y);
    assert.ok(Math.abs(result.frequency - expected[index][0]) < 1e-12);
    assert.ok(Math.abs(result.amplitude - expected[index][1]) < 1e-12);
  });
});

test("valence maps to the expected shape and disorder extrema", () => {
  assert.deepEqual(
    [-1, 0, 1].map((x) => {
      const result = affectParameters(x, 0);
      return [result.shapeMix, result.disorder];
    }),
    [[0, 0.8], [0.5, 0.4], [1, 0]],
  );
});

test("four-anchor palette maps axes, blends diagonals, and stays neutral at center", () => {
  const palette = { up: "#ff0000", down: "#00ff00", left: "#0000ff", right: "#ffffff" };
  assert.equal(affectPaletteColor(0, 0, palette), "rgb(183 183 183)");
  assert.equal(affectPaletteColor(0, 1, palette), "rgb(255 0 0)");
  assert.equal(affectPaletteColor(-1, 0, palette), "rgb(0 0 255)");
  assert.equal(affectPaletteColor(1, 1, palette), "rgb(255 128 128)");
});

test("profiles are finite, normalized, and use requested dimensions", () => {
  const profiles = createProfiles();
  assert.equal(profiles.vertexCount, 192);
  assert.equal(profiles.waveCount, 16);
  for (const profile of [profiles.pointy, profiles.rounded]) {
    assert.equal(profile.length, 192);
    assert.equal(Math.min(...profile), 0);
    assert.equal(Math.max(...profile), 1);
    assert.ok(profile.every(Number.isFinite));
  }
  for (const name of FLUBBER_BASE_SHAPES) {
    const base = profiles.baseShapes[name];
    assert.equal(base.x.length, 192);
    assert.equal(base.y.length, 192);
    assert.ok([...base.x, ...base.y].every(Number.isFinite));
    assert.ok(base.x.every((value, index) => Math.hypot(value, base.y[index]) <= 1.0000000001));
  }
});

test("projection offsets are deterministic for a session seed", () => {
  const first = createProjectionOffsets("session-one");
  const second = createProjectionOffsets("session-one");
  const different = createProjectionOffsets("session-two");
  assert.deepEqual([...first.phases], [...second.phases]);
  assert.deepEqual([...first.amplitudes], [...second.amplitudes]);
  assert.notDeepEqual([...first.phases], [...different.phases]);
});

test("generated SVG path is closed and contains only finite coordinates", () => {
  const profiles = createProfiles();
  const offsets = createProjectionOffsets("path-test");
  const output = buildFlubberPath({ profiles, offsets, x: -0.4, y: 0.7, phase: 2.1 });
  assert.match(output.path, /^M/);
  assert.match(output.path, /Z$/);
  assert.equal((output.path.match(/L/g) ?? []).length, 191);
  assert.doesNotMatch(output.path, /NaN|Infinity/);
  assert.match(output.color, /^rgb\(\d+ \d+ \d+\)$/);
});

test("circle, heart, triangle, and square envelopes stay distinct, finite, and closed", () => {
  const profiles = createProfiles();
  const offsets = createProjectionOffsets("base-shapes");
  const paths = FLUBBER_BASE_SHAPES.map((baseShape) => buildFlubberPath({
    profiles,
    offsets,
    x: 0,
    y: 1,
    phase: 2,
    baseShape,
  }).path);
  assert.equal(new Set(paths).size, FLUBBER_BASE_SHAPES.length);
  for (const path of paths) {
    assert.match(path, /^M/);
    assert.match(path, /Z$/);
    assert.equal((path.match(/L/g) ?? []).length, 191);
    assert.doesNotMatch(path, /NaN|Infinity/);
  }
  assert.throws(
    () => buildFlubberPath({ profiles, offsets, x: 0, y: 0, phase: 0, baseShape: "star" }),
    /Unsupported Flubber base shape/,
  );
});

test("heart envelope retains two upper lobes, a notch, and a downward point", () => {
  const { heart } = createProfiles().baseShapes;
  const topNotch = heart.y[0];
  const upperLobe = Math.min(...heart.y);
  const lowerPoint = heart.y[heart.y.length / 2];
  assert.ok(upperLobe < topNotch - 0.2);
  assert.ok(topNotch < 0);
  assert.ok(lowerPoint > 0.75);
  assert.ok(Math.abs(heart.x[heart.x.length / 2]) < 1e-12);
});

test("advanced amplitude and disorder scales alter geometry without invalid coordinates", () => {
  const profiles = createProfiles();
  const offsets = createProjectionOffsets("advanced-geometry");
  const neutral = buildFlubberPath({ profiles, offsets, x: -0.5, y: 0.5, phase: 1, amplitudeScale: 1, disorderScale: 1 });
  const adjusted = buildFlubberPath({ profiles, offsets, x: -0.5, y: 0.5, phase: 1, amplitudeScale: 1.8, disorderScale: 0.2 });
  assert.notEqual(adjusted.path, neutral.path);
  assert.doesNotMatch(adjusted.path, /NaN|Infinity/);
  assert.match(adjusted.path, /Z$/);
});

test("exponential smoothing is stable across equivalent time subdivisions", () => {
  const oneStep = smoothToward(0, 1, 8, 0.1);
  const halfStep = smoothToward(smoothToward(0, 1, 8, 0.05), 1, 8, 0.05);
  assert.ok(Math.abs(oneStep - halfStep) < 1e-12);
});
