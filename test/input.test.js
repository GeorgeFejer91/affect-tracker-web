import test from "node:test";
import assert from "node:assert/strict";
import {
  applyStep,
  constrainWidgetPosition,
  continuousMovement,
  directionForKey,
  normalizeWheel,
} from "../site/src/input.js";

test("arrow and WASD keys map to semantic directions", () => {
  assert.equal(directionForKey("ArrowLeft"), "left");
  assert.equal(directionForKey("D"), "right");
  assert.equal(directionForKey("w"), "up");
  assert.equal(directionForKey("s"), "down");
  assert.equal(directionForKey("Tab"), null);
});

test("step input moves and clamps targets", () => {
  assert.deepEqual(applyStep(0, 0, "up"), { x: 0, y: 0.1 });
  assert.deepEqual(applyStep(0.98, 0, "right"), { x: 1, y: 0 });
  assert.deepEqual(applyStep(-0.98, 0, "left"), { x: -1, y: 0 });
});

test("continuous input is frame-rate independent and opposite keys cancel", () => {
  const directions = new Set(["right", "up"]);
  assert.deepEqual(continuousMovement(directions, 0.5, 0.8), { x: 0.4, y: 0.4 });
  const firstHalf = continuousMovement(directions, 0.25, 0.8);
  const secondHalf = continuousMovement(directions, 0.25, 0.8);
  assert.equal(firstHalf.x + secondHalf.x, 0.4);
  assert.deepEqual(continuousMovement(new Set(["left", "right"]), 1, 0.8), { x: 0, y: 0 });
});

test("wheel values are normalized and capped", () => {
  assert.equal(normalizeWheel(-20), 0.03);
  assert.equal(normalizeWheel(1000), -0.15);
  assert.equal(normalizeWheel(-1000), 0.15);
});

test("widget position stays inside normal and undersized viewports", () => {
  assert.deepEqual(constrainWidgetPosition(-20, 999, 180, 800, 600), { x: 90, y: 510 });
  assert.deepEqual(constrainWidgetPosition(0, 0, 180, 100, 80), { x: 50, y: 40 });
});
