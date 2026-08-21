import test from "node:test";
import assert from "node:assert/strict";
import {
  affectParameters,
  buildFlubberPath,
  createProfiles,
  createProjectionOffsets,
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

test("exponential smoothing is stable across equivalent time subdivisions", () => {
  const oneStep = smoothToward(0, 1, 8, 0.1);
  const halfStep = smoothToward(smoothToward(0, 1, 8, 0.05), 1, 8, 0.05);
  assert.ok(Math.abs(oneStep - halfStep) < 1e-12);
});
