import test from "node:test";
import assert from "node:assert/strict";
import {
  AdaptiveRange,
  computeShapeMetrics,
  fitTracePoints,
  OneEuroFilter,
  TouchTraceAnalyzer,
} from "../site/src/touch-trace.js";

function linePoints(count = 33) {
  return Array.from({ length: count }, (_, index) => ({ x: index * 0.005, y: 0 }));
}

function circlePoints(count = 33) {
  return Array.from({ length: count }, (_, index) => {
    const angle = index / (count - 1) * Math.PI * 1.5;
    return { x: Math.cos(angle), y: Math.sin(angle) };
  });
}

function fullCirclePoints(count = 65) {
  return Array.from({ length: count }, (_, index) => {
    const angle = index / (count - 1) * Math.PI * 2;
    return { x: Math.cos(angle), y: Math.sin(angle) };
  });
}

function zigzagPoints(count = 33) {
  return Array.from({ length: count }, (_, index) => ({ x: index * 0.005, y: index % 2 ? 0.01 : 0 }));
}

function sinusoidPoints(count = 33) {
  return Array.from({ length: count }, (_, index) => ({
    x: index * 0.005,
    y: Math.sin(index / (count - 1) * Math.PI * 6) * 0.018,
  }));
}

test("shape metric separates straight, round, and jagged paths", () => {
  const stationary = computeShapeMetrics(Array.from({ length: 33 }, () => ({ x: 1, y: 1 })));
  const straight = computeShapeMetrics(linePoints());
  const round = computeShapeMetrics(circlePoints());
  const fullCircle = computeShapeMetrics(fullCirclePoints());
  const jagged = computeShapeMetrics(zigzagPoints());
  const sinusoid = computeShapeMetrics(sinusoidPoints());
  assert.equal(stationary.shapeFeature, 0);
  assert.ok(Math.abs(straight.shapeFeature) < 0.01);
  assert.ok(round.shapeFeature > 0.7);
  assert.ok(fullCircle.shapeFeature > 0.7);
  assert.ok(jagged.shapeFeature < -0.5);
  assert.ok(sinusoid.shapeFeature < 0);
  for (const result of [stationary, straight, round, fullCircle, jagged, sinusoid]) {
    assert.ok(Object.values(result).every(Number.isFinite));
  }
});

test("a single abrupt corner is penalized relative to a smooth arc", () => {
  const corner = [
    ...Array.from({ length: 17 }, (_, index) => ({ x: index * 0.005, y: 0 })),
    ...Array.from({ length: 16 }, (_, index) => ({ x: 0.08, y: (index + 1) * 0.005 })),
  ];
  const cornerMetric = computeShapeMetrics(corner);
  const arcMetric = computeShapeMetrics(circlePoints());
  assert.ok(cornerMetric.shapeFeature < arcMetric.shapeFeature);
  assert.ok(cornerMetric.roughness > arcMetric.roughness);
});

test("shape metric is translation, scale, and rotation invariant", () => {
  const source = circlePoints();
  const transformed = source.map(({ x, y }) => ({
    x: 4 + 3 * (x * Math.cos(0.7) - y * Math.sin(0.7)),
    y: -2 + 3 * (x * Math.sin(0.7) + y * Math.cos(0.7)),
  }));
  assert.ok(Math.abs(computeShapeMetrics(source).shapeFeature - computeShapeMetrics(transformed).shapeFeature) < 1e-9);
});

test("one euro filter remains finite and follows a changing signal", () => {
  const filter = new OneEuroFilter();
  let output = 0;
  for (let index = 0; index < 120; index += 1) output = filter.filter(index < 30 ? 0 : 1, index * (1_000 / 60));
  assert.ok(Number.isFinite(output));
  assert.ok(output > 0.9 && output <= 1);
  filter.reset();
  assert.equal(filter.filter(5, 0), 5);
});

test("one euro filter matches the official repository ground truth", () => {
  const timestamps = [0, 0.00833333, 0.0166667, 0.025, 0.0333333, 0.0416667, 0.05, 0.0583333, 0.0666667, 0.075, 0.0833333];
  const noisy = [-0.0385099, -0.0280664, 0.048622, 0.111498, 0.053026, 0.120548, 0.00972308, 0.074193, -0.0236801, 0.0462396, 0.0892027];
  const expected = [-0.0385099, -0.0379872, -0.0334427, -0.0252696, -0.0207099, -0.0119912, -0.0106507, -0.00526521, -0.00641239, -0.00308863, 0.00291027];
  const filter = new OneEuroFilter({ minCutoff: 1, beta: 0.1, derivativeCutoff: 1 });
  const actual = noisy.map((value, index) => filter.filter(value, timestamps[index] * 1_000));
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 0.0001, `${index}: ${value} != ${expected[index]}`));
});

test("adaptive range rolls over chronologically and keeps a usable span", () => {
  const range = new AdaptiveRange({ minimum: -1, maximum: 1, priorLow: -0.35, priorHigh: 0.35, minimumSpan: 0.2, capacity: 10 });
  for (let index = 0; index < 30; index += 1) range.add(index < 20 ? -0.8 : 0.8);
  range.update(1);
  assert.equal(range.count, 10);
  assert.ok(range.high > range.low);
  assert.ok(range.high - range.low >= 0.2 - 1e-9);
  assert.ok(range.normalize(range.low) <= -0.99);
  assert.ok(range.normalize(range.high) >= 0.99);
});

test("adaptive bounds expand quickly and contract slowly", () => {
  const range = new AdaptiveRange({ minimum: -1, maximum: 1, priorLow: -0.35, priorHigh: 0.35, minimumSpan: 0.2, capacity: 100 });
  for (let index = 0; index < 100; index += 1) range.add(0.9);
  range.update(1.5);
  const expandedHigh = range.high;
  assert.ok(expandedHigh > 0.6);
  for (let index = 0; index < 100; index += 1) range.add(-0.8);
  range.update(1.5);
  assert.ok(expandedHigh - range.high < 0.1);
  assert.ok(range.low < -0.5);
  assert.ok(range.high - range.low >= 0.2);
});

test("equal-distance resampling produces the configured spatial interval", () => {
  const analyzer = new TouchTraceAnalyzer({ width: 800, height: 600 });
  for (let index = 0; index <= 20; index += 1) {
    analyzer.ingest({ clientX: 100 + index * 10, clientY: 200, time: index * 10, pointerType: "mouse" });
  }
  const distances = analyzer.resampledPoints.slice(1).map((point, index) => {
    const before = analyzer.resampledPoints[index];
    return Math.hypot(point.x - before.x, point.y - before.y);
  });
  assert.ok(distances.length >= 8);
  distances.forEach((distance) => assert.ok(Math.abs(distance - 0.005) < 1e-9));
});

test("touch analyzer is stable across 30, 60, 120, and 240 Hz input", () => {
  const simulate = (hz) => {
    const analyzer = new TouchTraceAnalyzer({ width: 1_000, height: 1_000 });
    analyzer.beginStroke("mouse");
    const duration = 2;
    for (let index = 0; index <= duration * hz; index += 1) {
      const seconds = index / hz;
      analyzer.ingest({
        clientX: 100 + seconds * 250,
        clientY: 500 + Math.sin(seconds * Math.PI) * 100,
        time: seconds * 1_000,
        pointerType: "mouse",
      });
      analyzer.update(seconds * 1_000, 1 / hz);
    }
    return analyzer.snapshot();
  };
  const snapshots = [30, 60, 120, 240].map(simulate);
  const baseline = snapshots[0];
  for (const snapshot of snapshots.slice(1)) {
    assert.ok(Math.abs(baseline.filteredSpeed - snapshot.filteredSpeed) < 0.08);
    assert.ok(Math.abs(baseline.shapeFeature - snapshot.shapeFeature) < 0.15);
  }
});

test("equivalent diagonal-normalized paths survive viewport aspect changes", () => {
  const simulate = (width, height) => {
    const diagonal = Math.hypot(width, height);
    const analyzer = new TouchTraceAnalyzer({ width, height });
    for (let index = 0; index <= 120; index += 1) {
      const angle = index / 120 * Math.PI;
      analyzer.ingest({
        clientX: diagonal * (0.35 + Math.cos(angle) * 0.12),
        clientY: diagonal * (0.28 + Math.sin(angle) * 0.12),
        time: index * (1_000 / 60),
        pointerType: "touch",
      });
      analyzer.update(index * (1_000 / 60), 1 / 60);
    }
    return analyzer.snapshot();
  };
  const landscape = simulate(1_200, 600);
  const portrait = simulate(600, 1_200);
  assert.ok(Math.abs(landscape.filteredSpeed - portrait.filteredSpeed) < 1e-9);
  assert.ok(Math.abs(landscape.shapeFeature - portrait.shapeFeature) < 1e-9);
});

test("duplicates, non-monotonic times, and long gaps are segmented safely", () => {
  const analyzer = new TouchTraceAnalyzer({ width: 400, height: 300 });
  const first = analyzer.ingest({ clientX: 10, clientY: 10, time: 10, pointerType: "pen" });
  const duplicate = analyzer.ingest({ clientX: 10, clientY: 10, time: 20, pointerType: "pen" });
  const backwards = analyzer.ingest({ clientX: 20, clientY: 20, time: 19, pointerType: "pen" });
  const strokeBeforeGap = analyzer.strokeId;
  const afterGap = analyzer.ingest({ clientX: 30, clientY: 30, time: 500, pointerType: "pen" });
  assert.equal(first.accepted, true);
  assert.equal(duplicate.reason, "duplicate");
  assert.equal(backwards.accepted, false);
  assert.equal(afterGap.accepted, true);
  assert.ok(analyzer.strokeId > strokeBeforeGap);
  assert.ok(Object.values(analyzer.snapshot()).filter((value) => typeof value === "number").every(Number.isFinite));
});

test("inactivity returns the touch target toward neutral", () => {
  const analyzer = new TouchTraceAnalyzer({ width: 500, height: 500 });
  analyzer.beginStroke("touch");
  for (let index = 0; index < 40; index += 1) {
    analyzer.ingest({ clientX: 20 + index * 5, clientY: 50 + (index % 2) * 15, time: index * 20, pointerType: "touch" });
    analyzer.update(index * 20, 0.02);
  }
  const activeMagnitude = Math.hypot(analyzer.targetX, analyzer.targetY);
  for (let index = 0; index < 120; index += 1) analyzer.update(1_000 + index * 20, 0.02);
  assert.ok(activeMagnitude > 0.05);
  assert.ok(Math.hypot(analyzer.targetX, analyzer.targetY) < activeMagnitude * 0.1);
  assert.equal(analyzer.motionActive, false);
});

test("trace fitting preserves aspect ratio and centers degenerate axes", () => {
  const horizontal = fitTracePoints([{ x: 10, y: 5 }, { x: 30, y: 5 }], 200, 100);
  assert.equal(horizontal.length, 2);
  assert.ok(horizontal[0].x < horizontal[1].x);
  assert.ok(Math.abs(horizontal[0].y - 50) < 0.01);
  const square = fitTracePoints([{ x: 0, y: 0 }, { x: 10, y: 10 }], 200, 100);
  assert.ok(Math.abs((square[1].x - square[0].x) - (square[1].y - square[0].y)) < 1e-9);
  const vertical = fitTracePoints([{ x: 5, y: 10 }, { x: 5, y: 30 }], 200, 100);
  assert.ok(Math.abs(vertical[0].x - 100) < 0.01);
  const stationary = fitTracePoints([{ x: 5, y: 10 }], 200, 100);
  assert.deepEqual(stationary.map(({ x, y }) => [x, y]), [[100, 50]]);
});
