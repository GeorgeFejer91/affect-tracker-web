import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AFFECT_MATRIX_SIZE, matrixCoordinate } from "../desktop/src/matrix.js";

test("11 by 11 matrix exposes 121 symmetric VA states with an exact neutral center", () => {
  assert.equal(AFFECT_MATRIX_SIZE, 11);
  const states = [];
  for (let row = 0; row < AFFECT_MATRIX_SIZE; row += 1) {
    for (let column = 0; column < AFFECT_MATRIX_SIZE; column += 1) {
      states.push([matrixCoordinate(column), matrixCoordinate(row)]);
    }
  }
  assert.equal(states.length, 121);
  assert.equal(new Set(states.map(([x, y]) => `${x}:${y}`)).size, 121);
  assert.equal(matrixCoordinate(0), -1);
  assert.equal(matrixCoordinate(10), 1);
  for (let index = 0; index < AFFECT_MATRIX_SIZE; index += 1) {
    assert.ok(Math.abs(matrixCoordinate(index) + matrixCoordinate(10 - index)) < 1e-12);
  }
  assert.equal(matrixCoordinate(5), 0);
});

test("matrix indices reject values outside the closed 11-state axis", () => {
  for (const index of [-1, 11, 1.5, Number.NaN]) {
    assert.throws(() => matrixCoordinate(index), RangeError);
  }
});

test("desktop exposes transient continuous and matrix traversal controls", () => {
  const html = readFileSync(new URL("../desktop/index.html", import.meta.url), "utf8");
  const nativeSource = readFileSync(new URL("../desktop/src/native.js", import.meta.url), "utf8");
  const settingsSource = readFileSync(new URL("../desktop/src/settings.js", import.meta.url), "utf8");
  assert.match(html, /id="continuous-traversal-button"/);
  assert.match(html, /id="matrix-traversal-button"/);
  assert.match(html, /aria-label="121-state valence–arousal matrix"/);
  assert.match(html, /Neutral is the exact central matrix state at valence 0 and arousal 0/);
  assert.match(nativeSource, /invoke\("traverse_affect_matrix", \{ column, row, stepsPerSecond \}\)/);
  assert.match(settingsSource, /nativeApi\.setTraversalMode\("continuous"\)/);
  assert.match(settingsSource, /nativeApi\.setTraversalMode\("matrix"\)/);
  assert.match(settingsSource, /nativeApi\.stopMatrixTraversal/);
});
