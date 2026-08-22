import test from "node:test";
import assert from "node:assert/strict";
import {
  AdaptiveRange,
  computeShapeMetrics,
  FEEDBACK_HOLD_MS,
  fitTracePoints,
  gateRateForEvidence,
  OneEuroFilter,
  SPEED_PRIOR_HIGH_DPS,
  SPEED_PRIOR_LOW_DPS,
  SPEED_PRIOR_NEUTRAL_DPS,
  STROKE_DIRECTION_MIN_DISTANCE,
  STROKE_SPEED_CONTINUITY_MS,
  TOUCH_FEEDBACK_CONTINUOUS,
  TOUCH_FEEDBACK_GATED,
  TOUCH_TRACE_ALGORITHM_VERSION,
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

function backtrackingPoints(count = 33) {
  return Array.from({ length: count }, (_, index) => ({
    x: 0,
    y: index % 2 ? 0.08 : 0,
  }));
}

function fullSurfaceZigzagPoints() {
  const vertices = [
    [140, 740],
    [300, 180],
    [450, 800],
    [600, 160],
    [760, 820],
    [880, 220],
  ];
  const points = [];
  for (let segment = 0; segment < vertices.length - 1; segment += 1) {
    const [startX, startY] = vertices[segment];
    const [endX, endY] = vertices[segment + 1];
    for (let step = 0; step < 18; step += 1) {
      const amount = step / 18;
      points.push({
        clientX: startX + (endX - startX) * amount,
        clientY: startY + (endY - startY) * amount,
        time: points.length * 16,
        pointerType: "touch",
      });
    }
  }
  points.push({
    clientX: vertices.at(-1)[0],
    clientY: vertices.at(-1)[1],
    time: points.length * 16,
    pointerType: "touch",
  });
  return points;
}

test("shape metric separates straight, round, and jagged paths", () => {
  const stationary = computeShapeMetrics(Array.from({ length: 33 }, () => ({ x: 1, y: 1 })));
  const straight = computeShapeMetrics(linePoints());
  const round = computeShapeMetrics(circlePoints());
  const fullCircle = computeShapeMetrics(fullCirclePoints());
  const jagged = computeShapeMetrics(zigzagPoints());
  const sinusoid = computeShapeMetrics(sinusoidPoints());
  const backtracking = computeShapeMetrics(backtrackingPoints());
  assert.equal(stationary.shapeFeature, 0);
  assert.ok(Math.abs(straight.shapeFeature) < 0.01);
  assert.ok(round.shapeFeature > 0.7);
  assert.ok(fullCircle.shapeFeature > 0.7);
  assert.ok(jagged.shapeFeature < -0.5);
  assert.ok(sinusoid.shapeFeature < 0);
  assert.ok(backtracking.shapeFeature < -0.6);
  assert.ok(backtracking.directionReversal > 0.8);
  for (const result of [stationary, straight, round, fullCircle, jagged, sinusoid, backtracking]) {
    assert.ok(Object.values(result).every(Number.isFinite));
  }
});

test("roundness requires sustained coherent curvature rather than a short bend", () => {
  const shortArc = Array.from({ length: 33 }, (_, index) => {
    const angle = index / 32 * Math.PI / 2;
    return { x: Math.cos(angle), y: Math.sin(angle) };
  });
  const shortMetric = computeShapeMetrics(shortArc);
  const longMetric = computeShapeMetrics(circlePoints());
  assert.ok(shortMetric.shapeFeature > 0);
  assert.ok(shortMetric.shapeFeature < 0.65);
  assert.ok(longMetric.shapeFeature > shortMetric.shapeFeature + 0.25);
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

test("cold-start speed anchors use literature-informed viewport rates", () => {
  const analyzer = new TouchTraceAnalyzer({ width: 1_000, height: 1_000 });
  const snapshot = analyzer.snapshot();

  assert.equal(SPEED_PRIOR_LOW_DPS, 0.15);
  assert.equal(SPEED_PRIOR_HIGH_DPS, 0.8);
  assert.ok(Math.abs(SPEED_PRIOR_NEUTRAL_DPS - 0.4387) < 0.001);
  assert.ok(Math.abs(snapshot.speedLower - Math.log1p(SPEED_PRIOR_LOW_DPS)) < 1e-12);
  assert.ok(Math.abs(snapshot.speedUpper - Math.log1p(SPEED_PRIOR_HIGH_DPS)) < 1e-12);
  assert.equal(TOUCH_TRACE_ALGORITHM_VERSION, "touch-trace-v8");
});

test("gate evidence uses a dead zone and bounded signed live rates", () => {
  assert.equal(gateRateForEvidence(0.1), 0);
  assert.equal(gateRateForEvidence(-0.1), 0);
  assert.ok(gateRateForEvidence(0.6) > 0.04);
  assert.ok(gateRateForEvidence(-0.6) < -0.04);
  assert.equal(gateRateForEvidence(1), 0.4);
  assert.equal(gateRateForEvidence(-1), -0.4);
});

test("gated live target integration is frame-rate independent", () => {
  const targets = [30, 60, 120, 240].map((rate) => {
    const analyzer = new TouchTraceAnalyzer({ width: 1_000, height: 1_000 });
    analyzer.startGate(0);
    analyzer.mappedY = 1;
    const delta = 1 / rate;
    for (let index = 1; index <= rate; index += 1) {
      const now = index * delta * 1_000;
      analyzer.lastPointTime = now;
      analyzer.applyLiveGateFeedback(now);
    }
    return analyzer.targetY;
  });
  for (const target of targets) assert.ok(Math.abs(target - 0.4) < 1e-9);
});

test("ending a direct pointer stroke stops gated motion immediately", () => {
  const analyzer = new TouchTraceAnalyzer({ width: 1_000, height: 1_000 });
  analyzer.startGate(0);
  analyzer.mappedY = 1;
  analyzer.lastPointTime = 20;
  analyzer.applyLiveGateFeedback(20);
  const reached = analyzer.targetY;
  analyzer.endStroke();
  analyzer.applyLiveGateFeedback(40);
  assert.equal(analyzer.targetY, reached);
  assert.equal(analyzer.gateLiveActive, false);
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

test("a short rapid burst reaches high arousal and remains available as feedback", () => {
  const analyzer = new TouchTraceAnalyzer({ width: 1_000, height: 1_000, feedbackMode: TOUCH_FEEDBACK_CONTINUOUS });
  analyzer.beginStroke("touch");
  const burst = [
    { clientX: 50, clientY: 500, time: 0, pointerType: "touch" },
    { clientX: 500, clientY: 500, time: 20, pointerType: "touch" },
    { clientX: 950, clientY: 500, time: 40, pointerType: "touch" },
  ];
  burst.forEach((point) => analyzer.ingest(point));
  for (let now = 60; now <= 1_000; now += 20) analyzer.update(now, 0.02);
  const snapshot = analyzer.snapshot();

  assert.equal(TOUCH_TRACE_ALGORITHM_VERSION, "touch-trace-v8");
  assert.equal(snapshot.motionActive, false);
  assert.equal(snapshot.feedbackHeld, true);
  assert.ok(snapshot.speedConfidence >= 0.99);
  assert.ok(snapshot.mappedY > 0.9);
  assert.ok(snapshot.targetY > 0.85);
});

test("rapid lifted-finger micro-strokes share speed evidence without joining their geometry", () => {
  const analyzer = new TouchTraceAnalyzer({ width: 1_000, height: 1_000 });
  analyzer.beginStroke("touch");
  analyzer.ingest({ clientX: 100, clientY: 500, time: 0, pointerType: "touch" });
  analyzer.ingest({ clientX: 100, clientY: 400, time: 20, pointerType: "touch" });
  analyzer.update(50, 0.05);

  assert.equal(analyzer.speedWindow.length, 1);
  assert.equal(analyzer.speedConfidence, 0.5);
  assert.equal(analyzer.shouldPreserveSpeed(100), true);

  analyzer.beginStroke("touch", { preserveSpeed: true });
  assert.equal(analyzer.resampledPoints.length, 0);
  assert.equal(analyzer.speedWindow.length, 1);
  analyzer.ingest({ clientX: 900, clientY: 400, time: 100, pointerType: "touch" });
  analyzer.ingest({ clientX: 900, clientY: 500, time: 120, pointerType: "touch" });
  analyzer.update(120, 0.07);
  const snapshot = analyzer.snapshot();

  assert.equal(snapshot.speedContinuityActive, true);
  assert.equal(snapshot.speedConfidence, 1);
  assert.ok(snapshot.mappedY > 0.9);
  assert.ok(snapshot.rawSpeed < 4, "the lifted-finger jump must not count as movement speed");
  assert.equal(analyzer.shouldPreserveSpeed(120 + STROKE_SPEED_CONTINUITY_MS + 1), false);

  analyzer.beginStroke("touch");
  assert.equal(analyzer.speedWindow.length, 0);
  assert.equal(analyzer.snapshot().speedContinuityActive, false);
});

test("alternating lifted-finger swipe directions become live jagged evidence", () => {
  const analyzer = new TouchTraceAnalyzer({ width: 1_000, height: 1_000 });
  const stroke = (startY, endY, startTime) => {
    const preserveSpeed = analyzer.shouldPreserveSpeed(startTime);
    analyzer.beginStroke("touch", { preserveSpeed });
    const middleY = (startY + endY) / 2;
    [startY, middleY, endY].forEach((clientY, index) => {
      const time = startTime + index * 20;
      analyzer.ingest({ clientX: 500, clientY, time, pointerType: "touch" });
      analyzer.update(time, 0.02);
    });
  };

  stroke(750, 250, 0);
  analyzer.endStroke();
  stroke(250, 750, 100);
  const secondStrokeLive = analyzer.snapshot();
  assert.ok(secondStrokeLive.directionReversal >= 0.45);
  assert.ok(secondStrokeLive.shapeFeature < 0);
  analyzer.endStroke();

  stroke(750, 250, 200);
  const thirdStrokeLive = analyzer.snapshot();
  assert.ok(thirdStrokeLive.directionReversal > 0.9);
  assert.ok(thirdStrokeLive.shapeFeature < -0.7);
  assert.ok(thirdStrokeLive.shapeConfidence > 0.9);
  assert.ok(thirdStrokeLive.mappedX < -0.9);
  assert.ok(analyzer.strokePathDistance >= STROKE_DIRECTION_MIN_DISTANCE);
  assert.ok(thirdStrokeLive.rawSpeed < 20, "lifted-finger displacement must remain excluded from speed");
});

test("same-direction strokes and expired stroke context do not become jagged", () => {
  const analyzer = new TouchTraceAnalyzer({ width: 1_000, height: 1_000 });
  const stroke = (startTime, preserveSpeed) => {
    analyzer.beginStroke("touch", { preserveSpeed });
    analyzer.ingest({ clientX: 500, clientY: 750, time: startTime, pointerType: "touch" });
    analyzer.ingest({ clientX: 500, clientY: 250, time: startTime + 40, pointerType: "touch" });
    analyzer.update(startTime + 40, 0.04);
    analyzer.endStroke();
  };

  stroke(0, false);
  stroke(100, true);
  stroke(200, true);
  const repeated = analyzer.snapshot();
  assert.equal(repeated.directionReversal, 0);
  assert.ok(repeated.shapeFeature >= 0);

  const afterExpiry = 240 + STROKE_SPEED_CONTINUITY_MS + 1;
  assert.equal(analyzer.shouldPreserveSpeed(afterExpiry), false);
  stroke(afterExpiry, false);
  assert.equal(analyzer.recentStrokeDirections.length, 1);
  assert.equal(analyzer.snapshot().directionReversal, 0);
});

test("inactivity holds the last result before a gradual return to neutral", () => {
  const analyzer = new TouchTraceAnalyzer({ width: 500, height: 500, feedbackMode: TOUCH_FEEDBACK_CONTINUOUS });
  analyzer.beginStroke("touch");
  for (let index = 0; index < 40; index += 1) {
    analyzer.ingest({ clientX: 20 + index * 5, clientY: 50 + (index % 2) * 15, time: index * 20, pointerType: "touch" });
    analyzer.update(index * 20, 0.02);
  }
  const activeMagnitude = Math.hypot(analyzer.targetX, analyzer.targetY);
  const lastMovementTime = 39 * 20;
  for (let now = 800; now <= lastMovementTime + FEEDBACK_HOLD_MS - 20; now += 20) analyzer.update(now, 0.02);
  const heldMagnitude = Math.hypot(analyzer.targetX, analyzer.targetY);
  assert.equal(analyzer.motionActive, false);
  assert.equal(analyzer.feedbackHeld, true);
  assert.ok(heldMagnitude >= activeMagnitude * 0.9);
  for (let now = lastMovementTime + FEEDBACK_HOLD_MS + 20; now <= 16_000; now += 20) analyzer.update(now, 0.02);
  assert.ok(activeMagnitude > 0.05);
  assert.ok(Math.hypot(analyzer.targetX, analyzer.targetY) < activeMagnitude * 0.1);
  assert.equal(analyzer.motionActive, false);
  assert.equal(analyzer.feedbackHeld, false);
});

function completeGate(analyzer, points, endTime) {
  for (const point of points) {
    analyzer.ingest(point);
    analyzer.update(point.time, 0.02);
  }
  analyzer.update(endTime, Math.min((endTime - points.at(-1).time) / 1_000, 0.05));
  return analyzer.snapshot();
}

test("gated occasional swipes move live and hold their resulting arousal", () => {
  const analyzer = new TouchTraceAnalyzer({ width: 1_000, height: 1_000 });
  const fast = completeGate(analyzer, [
    { clientX: 50, clientY: 500, time: 0, pointerType: "touch" },
    { clientX: 500, clientY: 500, time: 20, pointerType: "touch" },
    { clientX: 950, clientY: 500, time: 40, pointerType: "touch" },
  ], 500);
  assert.equal(fast.feedbackMode, TOUCH_FEEDBACK_GATED);
  assert.equal(fast.gateOpen, false);
  assert.equal(fast.gateCommitSequence, 1);
  assert.ok(fast.gateDeltaY > 0.005);
  assert.equal(fast.targetY, fast.gateLiveDeltaY);
  assert.equal(fast.speedCalibrationSamples, 1, "one completed movement window contributes one calibration sample");

  const heldTarget = fast.targetY;
  for (let now = 520; now <= 15_000; now += 20) analyzer.update(now, 0.02);
  assert.equal(analyzer.targetY, heldTarget, "gated feedback must not decay without another swipe");

  analyzer.beginStroke("touch");
  const slow = completeGate(analyzer, [
    { clientX: 300, clientY: 500, time: 16_000, pointerType: "touch" },
    { clientX: 310, clientY: 500, time: 16_200, pointerType: "touch" },
    { clientX: 320, clientY: 500, time: 16_400, pointerType: "touch" },
  ], 16_850);
  assert.ok(slow.gateDeltaY < 0);
  assert.ok(slow.targetY < heldTarget);
  assert.equal(slow.speedCalibrationSamples, 2);
});

test("gated shape windows move valence round/right and jagged/left", () => {
  const roundAnalyzer = new TouchTraceAnalyzer({ width: 1_000, height: 1_000 });
  const roundPoints = Array.from({ length: 25 }, (_, index) => {
    const angle = index / 24 * Math.PI * 1.25;
    return {
      clientX: 500 + Math.cos(angle) * 220,
      clientY: 500 + Math.sin(angle) * 220,
      time: index * 20,
      pointerType: "pen",
    };
  });
  const round = completeGate(roundAnalyzer, roundPoints, 900);
  assert.ok(round.gateDeltaX > 0.05);
  assert.equal(round.shapeCalibrationSamples, 1);

  const jaggedAnalyzer = new TouchTraceAnalyzer({ width: 1_000, height: 1_000 });
  const jaggedPoints = Array.from({ length: 25 }, (_, index) => ({
    clientX: 300 + index * 7,
    clientY: index % 2 ? 507 : 493,
    time: index * 20,
    pointerType: "pen",
  }));
  const jagged = completeGate(jaggedAnalyzer, jaggedPoints, 900);
  assert.ok(jagged.gateDeltaX < -0.05);
  assert.equal(jagged.shapeCalibrationSamples, 1);
});

test("screen-spanning angular swipes remain jagged between widely spaced corners", () => {
  const analyzer = new TouchTraceAnalyzer({ width: 1_000, height: 1_000 });
  const points = fullSurfaceZigzagPoints();
  let strongestJagged = 0;
  for (const point of points) {
    analyzer.ingest(point);
    analyzer.update(point.time, 0.016);
    strongestJagged = Math.min(strongestJagged, analyzer.snapshot().mappedX);
  }
  const live = analyzer.snapshot();
  assert.ok(live.shapeFeature < -0.25, `expected angular path, got ${live.shapeFeature}`);
  assert.ok(live.mappedX < -0.8, `expected strong live jagged mapping, got ${live.mappedX}`);
  assert.ok(strongestJagged < -0.8);
  assert.ok(live.targetX < -0.15, `expected sustained leftward movement, got ${live.targetX}`);
});

test("sustained gated movement reaches the selected extreme before release", () => {
  const analyzer = new TouchTraceAnalyzer({ width: 1_000, height: 1_000 });
  for (let index = 0; index < 130; index += 1) {
    const time = index * 20;
    analyzer.ingest({
      clientX: index % 2 ? 900 : 100,
      clientY: 500,
      time,
      pointerType: "touch",
    });
    analyzer.update(time, 0.02);
  }
  const live = analyzer.snapshot();
  assert.equal(live.gateOpen, true);
  assert.equal(live.gateCommitSequence, 0);
  assert.equal(live.gateLiveActive, true);
  assert.equal(live.targetY, 1);
  assert.equal(live.speedCalibrationSamples, 0, "an open gate must not bias calibration by duration");

  analyzer.update(3_100, 0.05);
  const held = analyzer.snapshot();
  assert.equal(held.gateOpen, false);
  assert.equal(held.gateCommitSequence, 1);
  assert.equal(held.targetY, live.targetY, "release must not add a step or move the chosen point");
  assert.equal(held.gateDeltaY, 1);
  assert.equal(held.speedCalibrationSamples, 1);
});

test("repeated short gated windows accumulate and reset clears the held result", () => {
  const analyzer = new TouchTraceAnalyzer({ width: 1_000, height: 1_000 });
  for (let gate = 0; gate < 6; gate += 1) {
    const start = gate * 1_000;
    analyzer.beginStroke("touch");
    completeGate(analyzer, [
      { clientX: 50, clientY: 500, time: start, pointerType: "touch" },
      { clientX: 500, clientY: 500, time: start + 20, pointerType: "touch" },
      { clientX: 950, clientY: 500, time: start + 40, pointerType: "touch" },
    ], start + 500);
  }
  assert.ok(analyzer.targetY > 0.05);
  assert.ok(analyzer.targetY < 1, "short windows should move less than sustained interaction");
  assert.equal(analyzer.speedRange.count, 6, "gesture duration must not multiply calibration votes");
  analyzer.reset({ width: 1_000, height: 1_000 });
  const reset = analyzer.snapshot();
  assert.equal(reset.targetY, 0);
  assert.equal(reset.gateCommitSequence, 0);
  assert.equal(reset.speedCalibrationSamples, 0);
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
