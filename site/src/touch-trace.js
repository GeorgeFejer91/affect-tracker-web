import { clamp, smoothToward } from "./math.js";

export const TOUCH_TRACE_ALGORITHM_VERSION = "touch-trace-v10";
export const TRACE_DURATION_MS = 4_000;
export const MOTION_TIMEOUT_MS = 400;
export const STROKE_SPEED_CONTINUITY_MS = 900;
export const STROKE_DIRECTION_MIN_DISTANCE = 0.01;
export const FEEDBACK_HOLD_MS = 1_800;
export const TARGET_ATTACK_SECONDS = 0.3;
export const TARGET_RELEASE_SECONDS = 3;
export const TOUCH_FEEDBACK_GATED = "gated";
export const TOUCH_FEEDBACK_CONTINUOUS = "continuous";
export const GATE_DEAD_ZONE = 0.12;
export const GATE_LIVE_ACTIVITY_MS = 80;
export const GATE_LIVE_MIN_RATE = 0.04;
export const GATE_LIVE_MAX_RATE = 0.4;
export const RESAMPLE_SPACING = 0.005;
// Keep enough equal-distance geometry to recognize large, screen-spanning
// zigzags. The previous 32-segment window (0.16 viewport diagonals) often
// contained only the final straight leg of a phone swipe, so an obviously
// angular gesture could look neutral or inherit an earlier round result.
// 512 segments cover 2.56 diagonals while remaining small and deterministic.
export const RESAMPLED_POINT_LIMIT = 513;
export const FEATURE_INTERVAL_MS = 50;
// Literature-informed cold-start anchors in viewport diagonals per second.
// They approximate deliberate drag and quick swipe performance reported by
// Wolf, Schleicher & Rohs (MobileHCI 2014, doi:10.1145/2628363.2634214).
// Participant-adaptive p10/p90 bounds replace their influence over time.
export const SPEED_PRIOR_LOW_DPS = 0.15;
export const SPEED_PRIOR_HIGH_DPS = 0.8;
export const SPEED_PRIOR_NEUTRAL_DPS = Math.expm1(
  (Math.log1p(SPEED_PRIOR_LOW_DPS) + Math.log1p(SPEED_PRIOR_HIGH_DPS)) / 2,
);

const SPEED_DOMAIN_MAX = Math.log1p(4);
const TURN_THRESHOLD = 5 * Math.PI / 180;
const REVERSAL_TURN_START = 2 * Math.PI / 3;
const DOMINANT_CORNER_WINDOW = 4;
const DOMINANT_CORNER_THRESHOLD = 60 * Math.PI / 180;
const DOMINANT_CORNER_MAX_STRAIGHTNESS = 0.85;
const DIRECTION_BIN_COUNT = 8;

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeFeedbackMode(mode) {
  return mode === TOUCH_FEEDBACK_CONTINUOUS ? TOUCH_FEEDBACK_CONTINUOUS : TOUCH_FEEDBACK_GATED;
}

export function gateRateForEvidence(
  value,
  deadZone = GATE_DEAD_ZONE,
  minimumRate = GATE_LIVE_MIN_RATE,
  maximumRate = GATE_LIVE_MAX_RATE,
) {
  const evidence = clamp(finite(value), -1, 1);
  const magnitude = Math.abs(evidence);
  if (magnitude <= deadZone) return 0;
  const strength = (magnitude - deadZone) / Math.max(1 - deadZone, 1e-9);
  return Math.sign(evidence) * (minimumRate + (maximumRate - minimumRate) * strength);
}

class LowPassFilter {
  constructor() {
    this.value = undefined;
  }

  filter(value, alpha) {
    this.value = this.value === undefined ? value : alpha * value + (1 - alpha) * this.value;
    return this.value;
  }

  reset() {
    this.value = undefined;
  }
}

export class OneEuroFilter {
  constructor({ minCutoff = 1, beta = 0.007, derivativeCutoff = 1 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.derivativeCutoff = derivativeCutoff;
    this.signal = new LowPassFilter();
    this.derivative = new LowPassFilter();
    this.lastTime = undefined;
  }

  alpha(deltaSeconds, cutoff) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / Math.max(deltaSeconds, 0.001));
  }

  filter(value, timeMs) {
    if (this.lastTime === undefined || timeMs <= this.lastTime) {
      this.lastTime = timeMs;
      this.derivative.filter(0, 1);
      return this.signal.filter(value, 1);
    }
    const deltaSeconds = (timeMs - this.lastTime) / 1_000;
    const rawDerivative = this.signal.value === undefined ? 0 : (value - this.signal.value) / deltaSeconds;
    const derivative = this.derivative.filter(rawDerivative, this.alpha(deltaSeconds, this.derivativeCutoff));
    const cutoff = this.minCutoff + this.beta * Math.abs(derivative);
    this.lastTime = timeMs;
    return this.signal.filter(value, this.alpha(deltaSeconds, cutoff));
  }

  reset() {
    this.signal.reset();
    this.derivative.reset();
    this.lastTime = undefined;
  }
}

export class AdaptiveRange {
  constructor({
    minimum,
    maximum,
    priorLow,
    priorHigh,
    minimumSpan,
    bins = 128,
    capacity = 1_200,
    bootstrapSamples = 100,
  }) {
    this.minimum = minimum;
    this.maximum = maximum;
    this.priorLow = priorLow;
    this.priorHigh = priorHigh;
    this.minimumSpan = minimumSpan;
    this.binCount = bins;
    this.capacity = capacity;
    this.bootstrapSamples = Math.max(1, bootstrapSamples);
    this.histogram = new Uint16Array(bins);
    this.samples = new Uint16Array(capacity);
    this.reset();
  }

  reset() {
    this.histogram.fill(0);
    this.index = 0;
    this.count = 0;
    this.low = this.priorLow;
    this.high = this.priorHigh;
  }

  binFor(value) {
    const ratio = (clamp(value, this.minimum, this.maximum) - this.minimum) / (this.maximum - this.minimum);
    return Math.min(this.binCount - 1, Math.floor(ratio * this.binCount));
  }

  valueForBin(bin) {
    return this.minimum + ((bin + 0.5) / this.binCount) * (this.maximum - this.minimum);
  }

  add(value) {
    if (!Number.isFinite(value)) return;
    const bin = this.binFor(value);
    if (this.count === this.capacity) {
      const old = this.samples[this.index];
      this.histogram[old] -= 1;
    } else {
      this.count += 1;
    }
    this.samples[this.index] = bin;
    this.histogram[bin] += 1;
    this.index = (this.index + 1) % this.capacity;
  }

  quantile(fraction) {
    if (this.count === 0) return fraction < 0.5 ? this.priorLow : this.priorHigh;
    const target = Math.max(1, Math.ceil(this.count * fraction));
    let cumulative = 0;
    for (let index = 0; index < this.histogram.length; index += 1) {
      cumulative += this.histogram[index];
      if (cumulative >= target) return this.valueForBin(index);
    }
    return this.maximum;
  }

  update(deltaSeconds) {
    const confidence = clamp(this.count / this.bootstrapSamples, 0, 1);
    const candidateLow = this.priorLow + (this.quantile(0.1) - this.priorLow) * confidence;
    const candidateHigh = this.priorHigh + (this.quantile(0.9) - this.priorHigh) * confidence;
    const smoothBound = (current, target, outward) => smoothToward(current, target, 1 / (outward ? 1.5 : 45), deltaSeconds);
    this.low = smoothBound(this.low, candidateLow, candidateLow < this.low);
    this.high = smoothBound(this.high, candidateHigh, candidateHigh > this.high);
    if (this.high - this.low < this.minimumSpan) {
      const center = (this.high + this.low) / 2;
      this.low = clamp(center - this.minimumSpan / 2, this.minimum, this.maximum - this.minimumSpan);
      this.high = this.low + this.minimumSpan;
    }
  }

  normalize(value) {
    return 2 * clamp((value - this.low) / Math.max(this.high - this.low, 1e-9), 0, 1) - 1;
  }
}

function emptyShapeMetrics(directionReversal = 0) {
  const reversal = clamp(finite(directionReversal), 0, 1);
  return {
    shapeFeature: reversal === 0 ? 0 : -0.75 * reversal,
    turnActivity: 0,
    turnCoherence: 0,
    signFlipRate: 0,
    roughness: 0,
    directionReversal: reversal,
    circleScore: 0,
    angularScore: 0.75 * reversal,
    windingTurns: 0,
    radialVariation: 1,
    directionEntropy: 0,
    dominantCornerCount: 0,
  };
}

function reversalStrength(angle) {
  return clamp((Math.abs(angle) - REVERSAL_TURN_START) / (Math.PI - REVERSAL_TURN_START), 0, 1);
}

function wrappedAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function directionEntropy(points) {
  const bins = new Uint16Array(DIRECTION_BIN_COUNT);
  let count = 0;
  for (let index = 1; index < points.length; index += 1) {
    const dx = points[index].x - points[index - 1].x;
    const dy = points[index].y - points[index - 1].y;
    if (Math.hypot(dx, dy) < 1e-9) continue;
    const angle = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);
    bins[Math.min(DIRECTION_BIN_COUNT - 1, Math.floor(angle / (Math.PI * 2) * DIRECTION_BIN_COUNT))] += 1;
    count += 1;
  }
  if (count < 2) return 0;
  let entropy = 0;
  for (const bin of bins) {
    if (bin === 0) continue;
    const probability = bin / count;
    entropy -= probability * Math.log(probability);
  }
  return clamp(entropy / Math.log(DIRECTION_BIN_COUNT), 0, 1);
}

function pathTurns(points, window = 1) {
  const turns = [];
  for (let index = window; index < points.length - window; index += 1) {
    const before = points[index - window];
    const current = points[index];
    const after = points[index + window];
    const ux = current.x - before.x;
    const uy = current.y - before.y;
    const vx = after.x - current.x;
    const vy = after.y - current.y;
    if (Math.hypot(ux, uy) < 1e-9 || Math.hypot(vx, vy) < 1e-9) continue;
    turns.push(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
  }
  return turns;
}

function dominantCorners(points) {
  if (points.length < DOMINANT_CORNER_WINDOW * 2 + 1) return [];
  const candidates = [];
  for (let index = DOMINANT_CORNER_WINDOW; index < points.length - DOMINANT_CORNER_WINDOW; index += 1) {
    const before = points[index - DOMINANT_CORNER_WINDOW];
    const current = points[index];
    const after = points[index + DOMINANT_CORNER_WINDOW];
    const ux = current.x - before.x;
    const uy = current.y - before.y;
    const vx = after.x - current.x;
    const vy = after.y - current.y;
    if (Math.hypot(ux, uy) < 1e-9 || Math.hypot(vx, vy) < 1e-9) continue;
    const angle = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    let localLength = 0;
    for (let pathIndex = index - DOMINANT_CORNER_WINDOW + 1; pathIndex <= index + DOMINANT_CORNER_WINDOW; pathIndex += 1) {
      localLength += Math.hypot(
        points[pathIndex].x - points[pathIndex - 1].x,
        points[pathIndex].y - points[pathIndex - 1].y,
      );
    }
    const chordLength = Math.hypot(after.x - before.x, after.y - before.y);
    const straightness = localLength > 1e-9 ? chordLength / localLength : 1;
    if (
      Math.abs(angle) >= DOMINANT_CORNER_THRESHOLD
      && straightness <= DOMINANT_CORNER_MAX_STRAIGHTNESS
    ) candidates.push({ index, angle, straightness });
  }
  candidates.sort((a, b) => Math.abs(b.angle) - Math.abs(a.angle));
  const selected = [];
  for (const candidate of candidates) {
    if (selected.some((corner) => Math.abs(corner.index - candidate.index) <= DOMINANT_CORNER_WINDOW * 2)) continue;
    selected.push(candidate);
  }
  return selected.sort((a, b) => a.index - b.index);
}

function loopGeometry(points) {
  const center = points.reduce(
    (result, point) => ({ x: result.x + point.x / points.length, y: result.y + point.y / points.length }),
    { x: 0, y: 0 },
  );
  let covarianceX = 0;
  let covarianceY = 0;
  let covarianceXY = 0;
  for (const point of points) {
    const x = point.x - center.x;
    const y = point.y - center.y;
    covarianceX += x * x / points.length;
    covarianceY += y * y / points.length;
    covarianceXY += x * y / points.length;
  }
  const trace = covarianceX + covarianceY;
  const discriminant = Math.sqrt(Math.max(0, (covarianceX - covarianceY) ** 2 + 4 * covarianceXY ** 2));
  const major = Math.max((trace + discriminant) / 2, 1e-12);
  const minor = Math.max((trace - discriminant) / 2, 0);
  const nonDegenerate = clamp((minor / major) / 0.04, 0, 1);
  if (nonDegenerate === 0) {
    return { windingTurns: 0, radialVariation: 1, nonDegenerate: 0, closure: 0 };
  }

  // Whitening makes the loop check tolerant of the ellipses produced by a
  // thumb's constrained reach. This coordinate transform is classifier-only;
  // it is never used to draw or cosmetically smooth the participant trace.
  const axisAngle = 0.5 * Math.atan2(2 * covarianceXY, covarianceX - covarianceY);
  const cosine = Math.cos(axisAngle);
  const sine = Math.sin(axisAngle);
  const whitened = points.map((point) => {
    const x = point.x - center.x;
    const y = point.y - center.y;
    return {
      x: (x * cosine + y * sine) / Math.sqrt(major),
      y: (-x * sine + y * cosine) / Math.sqrt(Math.max(minor, 1e-12)),
    };
  });
  const radii = whitened.map((point) => Math.hypot(point.x, point.y));
  const meanRadius = radii.reduce((sum, radius) => sum + radius, 0) / radii.length;
  const radiusVariance = radii.reduce((sum, radius) => sum + (radius - meanRadius) ** 2, 0) / radii.length;
  const radialVariation = meanRadius > 1e-9 ? Math.sqrt(radiusVariance) / meanRadius : 1;
  let accumulatedAngle = 0;
  let previousAngle = Math.atan2(whitened[0].y, whitened[0].x);
  for (let index = 1; index < whitened.length; index += 1) {
    const angle = Math.atan2(whitened[index].y, whitened[index].x);
    accumulatedAngle += wrappedAngle(angle - previousAngle);
    previousAngle = angle;
  }
  let pathLength = 0;
  for (let index = 1; index < points.length; index += 1) {
    pathLength += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  const endpointDistance = Math.hypot(
    points.at(-1).x - points[0].x,
    points.at(-1).y - points[0].y,
  );
  return {
    windingTurns: Math.abs(accumulatedAngle) / (Math.PI * 2),
    radialVariation: finite(radialVariation, 1),
    nonDegenerate,
    closure: clamp(1 - endpointDistance / Math.max(pathLength, 1e-9), 0, 1),
  };
}

export function computeShapeMetrics(points, { crossStrokeReversal = 0 } = {}) {
  if (!Array.isArray(points) || points.length < 9) {
    return emptyShapeMetrics(crossStrokeReversal);
  }
  // Classify the participant's structural path direction over 0.02D chords.
  // Adjacent 0.005D vectors remain available only for explicit reversals, so
  // ordinary mouse micro-jitter cannot make every curved path look angular.
  const adjacentTurns = pathTurns(points);
  const turns = pathTurns(points, DOMINANT_CORNER_WINDOW);
  if (turns.length === 0 && adjacentTurns.length === 0) {
    return emptyShapeMetrics(crossStrokeReversal);
  }
  const sumAbs = turns.reduce((sum, angle) => sum + Math.abs(angle), 0);
  const signedSum = turns.reduce((sum, angle) => sum + angle, 0);
  const turnActivity = clamp(sumAbs / (Math.PI / 2), 0, 1);
  const turnCoherence = sumAbs < TURN_THRESHOLD ? 0 : clamp(Math.abs(signedSum) / sumAbs, 0, 1);
  const significant = turns.filter((angle) => Math.abs(angle) >= TURN_THRESHOLD);
  let flips = 0;
  for (let index = 1; index < significant.length; index += 1) {
    if (Math.sign(significant[index]) !== Math.sign(significant[index - 1])) flips += 1;
  }
  const signFlipRate = significant.length > 1 ? flips / (significant.length - 1) : 0;
  const deviations = turns.map((angle, index) => {
    const local = turns.slice(Math.max(0, index - 2), Math.min(turns.length, index + 3));
    return Math.abs(angle - median(local));
  });
  const turnConcentration = sumAbs > 1e-9 ? Math.max(...turns.map(Math.abs)) / sumAbs : 0;
  const roughness = turns.length
    ? clamp(Math.max(median(deviations) / (Math.PI / 2), turnConcentration), 0, 1)
    : 0;
  const reversalValues = adjacentTurns.map(reversalStrength);
  const reversalPeak = reversalValues.length ? Math.max(...reversalValues) : 0;
  const reversalCoverage = reversalValues.length
    ? reversalValues.filter((value) => value > 0).length / reversalValues.length
    : 0;
  const withinStrokeReversal = clamp(0.8 * reversalPeak + 0.2 * reversalCoverage, 0, 1);
  const directionReversal = Math.max(clamp(finite(crossStrokeReversal), 0, 1), withinStrokeReversal);
  const corners = dominantCorners(points);
  const cornerDensity = clamp(corners.length / 4, 0, 1);
  const cornerStrength = corners.length
    ? median(corners.map(({ angle }) => clamp(
      (Math.abs(angle) - DOMINANT_CORNER_THRESHOLD) / (Math.PI - DOMINANT_CORNER_THRESHOLD),
      0,
      1,
    )))
    : 0;
  const headingEntropy = directionEntropy(points);
  const loop = loopGeometry(points);
  // A generous variation tolerance keeps incomplete and thumb-distorted
  // ellipses responsive while winding/coherence still reject random bends.
  const radialRegularity = clamp(1 - loop.radialVariation / 0.8, 0, 1);
  const turnCoverage = clamp(sumAbs / Math.PI, 0, 1);
  // A centroid can appear to rotate substantially around a short open arc.
  // Require the endpoints to close at least 10% of their travelled distance,
  // reaching full closure evidence by 60%, before winding becomes strong.
  const closureCoverage = clamp((loop.closure - 0.1) / 0.5, 0, 1);
  const windingCoverage = clamp(loop.windingTurns, 0, 1) * closureCoverage;
  // A circular command must accumulate coherent rotation around a stable
  // center. Merely bending in one direction is weak evidence; a complete,
  // possibly elliptical thumb loop is strong evidence.
  const rawCircleScore = clamp(
    turnCoherence
      * (1 - directionReversal)
      * loop.nonDegenerate
      * (0.15 * turnCoverage + 0.85 * windingCoverage * radialRegularity),
    0,
    1,
  );
  // The angular/random command is represented by dominant changes between
  // movement legs and disordered headings. Natural curvature within a thumb
  // leg is allowed; only the raw equal-distance path contributes here.
  const directionalDisorder = headingEntropy * Math.sqrt(Math.max(0, 1 - turnCoherence));
  const cornerEvidence = corners.length
    ? 0.55 * cornerDensity + 0.25 * cornerStrength + 0.2 * headingEntropy
    : 0;
  const adjacentSignificant = adjacentTurns.filter((angle) => Math.abs(angle) >= TURN_THRESHOLD);
  let adjacentFlips = 0;
  for (let index = 1; index < adjacentSignificant.length; index += 1) {
    if (Math.sign(adjacentSignificant[index]) !== Math.sign(adjacentSignificant[index - 1])) adjacentFlips += 1;
  }
  const adjacentSignFlipRate = adjacentSignificant.length > 1
    ? adjacentFlips / (adjacentSignificant.length - 1)
    : 0;
  const microReversalDisorder = adjacentSignFlipRate * clamp(directionReversal * 2.5, 0, 1);
  // Winding alone must not turn a square or angular closed scribble into a
  // circular command. Dominant corners attenuate loop evidence directly.
  const circleScore = rawCircleScore * (1 - 0.7 * cornerDensity);
  const angularScore = clamp(Math.max(
    0.9 * directionReversal,
    directionalDisorder,
    cornerEvidence,
    turnActivity * signFlipRate,
    microReversalDisorder,
  ), 0, 1);
  return {
    shapeFeature: clamp(circleScore - angularScore, -1, 1),
    turnActivity,
    turnCoherence,
    signFlipRate,
    roughness,
    directionReversal,
    circleScore,
    angularScore,
    windingTurns: loop.windingTurns,
    radialVariation: loop.radialVariation,
    directionEntropy: headingEntropy,
    dominantCornerCount: corners.length,
  };
}

export function fitTracePoints(points, width, height, paddingRatio = 0.08) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const safeWidth = Math.max(1, finite(width, 1));
  const safeHeight = Math.max(1, finite(height, 1));
  const padding = Math.min(safeWidth, safeHeight) * clamp(paddingRatio, 0, 0.4);
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const rawSpanX = maxX - minX;
  const rawSpanY = maxY - minY;
  if (rawSpanX < 1e-9 && rawSpanY < 1e-9) {
    return points.map((point) => ({ ...point, x: safeWidth / 2, y: safeHeight / 2 }));
  }
  const spanX = Math.max(rawSpanX, 1e-9);
  const spanY = Math.max(rawSpanY, 1e-9);
  const scale = rawSpanX < 1e-9
    ? (safeHeight - 2 * padding) / spanY
    : rawSpanY < 1e-9
      ? (safeWidth - 2 * padding) / spanX
      : Math.min((safeWidth - 2 * padding) / spanX, (safeHeight - 2 * padding) / spanY);
  const drawnWidth = spanX * scale;
  const drawnHeight = spanY * scale;
  const offsetX = (safeWidth - drawnWidth) / 2;
  const offsetY = (safeHeight - drawnHeight) / 2;
  return points.map((point) => ({
    ...point,
    x: offsetX + (point.x - minX) * scale,
    y: offsetY + (point.y - minY) * scale,
  }));
}

export class TouchTraceAnalyzer {
  constructor({ width = 1, height = 1, feedbackMode = TOUCH_FEEDBACK_GATED } = {}) {
    this.feedbackMode = normalizeFeedbackMode(feedbackMode);
    this.speedRange = new AdaptiveRange({
      minimum: 0,
      maximum: SPEED_DOMAIN_MAX,
      priorLow: Math.log1p(SPEED_PRIOR_LOW_DPS),
      priorHigh: Math.log1p(SPEED_PRIOR_HIGH_DPS),
      minimumSpan: 0.15,
      capacity: this.feedbackMode === TOUCH_FEEDBACK_GATED ? 120 : 1_200,
      bootstrapSamples: this.feedbackMode === TOUCH_FEEDBACK_GATED ? 20 : 100,
    });
    this.shapeRange = new AdaptiveRange({
      minimum: -1,
      maximum: 1,
      priorLow: -0.35,
      priorHigh: 0.35,
      minimumSpan: 0.2,
      capacity: this.feedbackMode === TOUCH_FEEDBACK_GATED ? 120 : 1_200,
      bootstrapSamples: this.feedbackMode === TOUCH_FEEDBACK_GATED ? 20 : 100,
    });
    this.xFilter = new OneEuroFilter();
    this.yFilter = new OneEuroFilter();
    this.reset({ width, height });
  }

  reset({ width = this.width, height = this.height } = {}) {
    this.width = Math.max(1, finite(width, 1));
    this.height = Math.max(1, finite(height, 1));
    this.diagonal = Math.hypot(this.width, this.height);
    this.xFilter.reset();
    this.yFilter.reset();
    this.speedRange.reset();
    this.shapeRange.reset();
    this.speedWindow = [];
    this.sourceSpeedWindow = [];
    this.recentStrokeDirections = [];
    this.strokeStartSource = undefined;
    this.strokePathDistance = 0;
    this.strokeAlternation = 0;
    this.directionTransitionCount = 0;
    this.resampledPoints = [];
    this.trace = [];
    this.previousFiltered = undefined;
    this.previousSource = undefined;
    this.resampleCarry = 0;
    this.lastPointTime = undefined;
    this.lastFeatureTime = undefined;
    this.lastBoundsTime = undefined;
    this.strokeId = 0;
    this.pointerType = "unknown";
    this.rawSpeed = 0;
    this.filteredSpeed = 0;
    this.speedFeature = 0;
    this.shape = computeShapeMetrics([]);
    this.speedConfidence = 0;
    this.shapeConfidence = 0;
    this.mappedX = 0;
    this.mappedY = 0;
    this.targetX = 0;
    this.targetY = 0;
    this.motionActive = false;
    this.liveInputEnded = false;
    this.feedbackHeld = false;
    this.speedContinuityActive = false;
    this.pointSequence = 0;
    this.lastGateFeaturePointSequence = -1;
    this.lastLiveFeaturePointSequence = -1;
    this.lastLiveIntegrationTime = undefined;
    this.gateId = 0;
    this.gateOpen = false;
    this.gateStartedAt = undefined;
    this.gateDurationMs = 0;
    this.gateSpeedFeatures = [];
    this.gateShapeFeatures = [];
    this.gateSpeedConfidence = 0;
    this.gateShapeConfidence = 0;
    this.gateCommitSequence = 0;
    this.gateDeltaX = 0;
    this.gateDeltaY = 0;
    this.gateLiveActive = false;
    this.gateLiveRateX = 0;
    this.gateLiveRateY = 0;
    this.gateLiveDeltaX = 0;
    this.gateLiveDeltaY = 0;
  }

  setFeedbackMode(mode, { targetX = this.targetX, targetY = this.targetY } = {}) {
    const normalized = normalizeFeedbackMode(mode);
    if (normalized === this.feedbackMode) return;
    this.feedbackMode = normalized;
    const rangeCapacity = normalized === TOUCH_FEEDBACK_GATED ? 120 : 1_200;
    const bootstrapSamples = normalized === TOUCH_FEEDBACK_GATED ? 20 : 100;
    this.speedRange.capacity = rangeCapacity;
    this.speedRange.samples = new Uint16Array(rangeCapacity);
    this.speedRange.bootstrapSamples = bootstrapSamples;
    this.shapeRange.capacity = rangeCapacity;
    this.shapeRange.samples = new Uint16Array(rangeCapacity);
    this.shapeRange.bootstrapSamples = bootstrapSamples;
    this.reset({ width: this.width, height: this.height });
    this.targetX = clamp(finite(targetX), -1, 1);
    this.targetY = clamp(finite(targetY), -1, 1);
  }

  startGate(time) {
    this.gateId += 1;
    this.gateOpen = true;
    this.gateStartedAt = time;
    this.gateDurationMs = 0;
    this.gateSpeedFeatures = [];
    this.gateShapeFeatures = [];
    this.gateSpeedConfidence = 0;
    this.gateShapeConfidence = 0;
    this.gateDeltaX = 0;
    this.gateDeltaY = 0;
    this.gateLiveActive = false;
    this.gateLiveRateX = 0;
    this.gateLiveRateY = 0;
    this.gateLiveDeltaX = 0;
    this.gateLiveDeltaY = 0;
    this.lastGateFeaturePointSequence = -1;
    this.lastLiveFeaturePointSequence = -1;
    this.lastLiveIntegrationTime = time;
    this.lastFeatureTime = undefined;
  }

  cancelGate() {
    this.gateOpen = false;
    this.gateStartedAt = undefined;
    this.gateSpeedFeatures = [];
    this.gateShapeFeatures = [];
    this.gateSpeedConfidence = 0;
    this.gateShapeConfidence = 0;
    this.gateLiveActive = false;
    this.gateLiveRateX = 0;
    this.gateLiveRateY = 0;
    this.lastGateFeaturePointSequence = -1;
    this.lastLiveFeaturePointSequence = -1;
    this.lastLiveIntegrationTime = undefined;
  }

  resetSegment({ preserveSpeed = false, preserveDirectionContext = false } = {}) {
    this.xFilter.reset();
    this.yFilter.reset();
    if (!preserveSpeed) {
      this.speedWindow = [];
      this.sourceSpeedWindow = [];
    }
    if (!preserveDirectionContext) {
      this.recentStrokeDirections = [];
      this.strokeAlternation = 0;
      this.directionTransitionCount = 0;
    }
    this.strokeStartSource = undefined;
    this.strokePathDistance = 0;
    this.resampledPoints = [];
    this.previousFiltered = undefined;
    this.previousSource = undefined;
    this.resampleCarry = 0;
    this.shape = computeShapeMetrics([], { crossStrokeReversal: this.strokeAlternation });
    this.shapeConfidence = 0;
    this.speedContinuityActive = preserveSpeed;
  }

  shouldPreserveSpeed(time) {
    return Number.isFinite(time)
      && this.lastPointTime !== undefined
      && time >= this.lastPointTime
      && time - this.lastPointTime <= STROKE_SPEED_CONTINUITY_MS
      && this.sourceSpeedWindow.length > 0;
  }

  beginStroke(
    pointerType = "unknown",
    { preserveSpeed = false, preserveDirectionContext = preserveSpeed } = {},
  ) {
    this.strokeId += 1;
    this.pointerType = pointerType;
    this.liveInputEnded = false;
    this.resetSegment({ preserveSpeed, preserveDirectionContext });
    // A new stroke never measures the lifted-finger displacement. Clearing
    // the timestamp also prevents the gap detector from immediately undoing
    // deliberate short-stroke speed continuity on the first new point.
    this.lastPointTime = undefined;
  }

  endStroke(time = this.lastPointTime) {
    this.finalizeStrokeDirection(time);
    this.liveInputEnded = true;
    this.gateLiveActive = false;
    this.gateLiveRateX = 0;
    this.gateLiveRateY = 0;
  }

  pruneStrokeDirections(now) {
    if (!Number.isFinite(now)) return;
    const cutoff = now - STROKE_SPEED_CONTINUITY_MS;
    while (this.recentStrokeDirections.length && this.recentStrokeDirections[0].time < cutoff) {
      this.recentStrokeDirections.shift();
    }
    if (this.recentStrokeDirections.length > 6) {
      this.recentStrokeDirections.splice(0, this.recentStrokeDirections.length - 6);
    }
  }

  currentStrokeDirection(time = this.lastPointTime) {
    if (!this.strokeStartSource || !this.previousSource || this.strokePathDistance < STROKE_DIRECTION_MIN_DISTANCE) {
      return undefined;
    }
    const dx = this.previousSource.x - this.strokeStartSource.x;
    const dy = this.previousSource.y - this.strokeStartSource.y;
    const displacement = Math.hypot(dx, dy);
    if (displacement < STROKE_DIRECTION_MIN_DISTANCE) return undefined;
    return { x: dx / displacement, y: dy / displacement, time: finite(time, this.lastPointTime) };
  }

  strokeReversalEvidence(time = this.lastPointTime) {
    this.pruneStrokeDirections(time);
    const directions = [...this.recentStrokeDirections];
    const current = this.currentStrokeDirection(time);
    if (current) directions.push(current);
    const reversals = [];
    for (let index = 1; index < directions.length; index += 1) {
      const before = directions[index - 1];
      const after = directions[index];
      const dot = clamp(before.x * after.x + before.y * after.y, -1, 1);
      reversals.push(reversalStrength(Math.acos(dot)));
    }
    this.directionTransitionCount = reversals.length;
    if (reversals.length === 0) {
      this.strokeAlternation = 0;
      return 0;
    }
    // A second opposing stroke begins to register immediately; a third
    // establishes full confidence in an alternating command sequence.
    const transitionConfidence = clamp(reversals.length / 2, 0, 1);
    this.strokeAlternation = median(reversals) * transitionConfidence;
    return this.strokeAlternation;
  }

  finalizeStrokeDirection(time = this.lastPointTime) {
    const direction = this.currentStrokeDirection(time);
    if (!direction) return false;
    this.pruneStrokeDirections(direction.time);
    this.recentStrokeDirections.push(direction);
    this.strokeStartSource = undefined;
    this.strokePathDistance = 0;
    this.strokeReversalEvidence(direction.time);
    return true;
  }

  shapeQualification() {
    const pathQualified = this.resampledPoints.length >= 9
      && (this.resampledPoints.length - 1) * RESAMPLE_SPACING >= 0.04;
    const pathConfidence = pathQualified ? clamp((this.resampledPoints.length - 8) / 25, 0, 1) : 0;
    const reversalQualified = this.strokeAlternation > 0.05 && this.directionTransitionCount > 0;
    const reversalConfidence = reversalQualified ? clamp(this.directionTransitionCount / 2, 0, 1) : 0;
    return {
      qualified: pathQualified || reversalQualified,
      confidence: Math.max(pathConfidence, reversalConfidence),
    };
  }

  resize(width, height) {
    this.width = Math.max(1, finite(width, 1));
    this.height = Math.max(1, finite(height, 1));
    this.diagonal = Math.hypot(this.width, this.height);
    this.cancelGate();
    this.beginStroke(this.pointerType);
  }

  appendResampledPoint(point) {
    this.resampledPoints.push(point);
    if (this.resampledPoints.length > RESAMPLED_POINT_LIMIT) this.resampledPoints.shift();
  }

  resampleSegment(from, to) {
    let start = { ...from };
    let remaining = Math.hypot(to.x - start.x, to.y - start.y);
    if (remaining < 1e-12) return;
    while (this.resampleCarry + remaining >= RESAMPLE_SPACING) {
      const required = RESAMPLE_SPACING - this.resampleCarry;
      const ratio = required / remaining;
      start = {
        x: start.x + (to.x - start.x) * ratio,
        y: start.y + (to.y - start.y) * ratio,
      };
      this.appendResampledPoint(start);
      remaining = Math.hypot(to.x - start.x, to.y - start.y);
      this.resampleCarry = 0;
    }
    this.resampleCarry += remaining;
  }

  ingest(point) {
    const time = finite(point.time, NaN);
    const clientX = finite(point.clientX, NaN);
    const clientY = finite(point.clientY, NaN);
    if (![time, clientX, clientY].every(Number.isFinite)) return { accepted: false, reason: "non-finite" };
    if (this.lastPointTime !== undefined && time - this.lastPointTime < 1) return { accepted: false, reason: "sub-millisecond" };
    if (this.lastPointTime !== undefined && time - this.lastPointTime > MOTION_TIMEOUT_MS) {
      if (this.feedbackMode === TOUCH_FEEDBACK_GATED && this.gateOpen) this.commitGate(time);
      this.beginStroke(point.pointerType);
    }
    if (this.strokeId === 0) this.beginStroke(point.pointerType);

    const normalized = { x: clientX / this.diagonal, y: clientY / this.diagonal };
    if (this.previousSource && Math.hypot(normalized.x - this.previousSource.x, normalized.y - this.previousSource.y) < 1e-12) {
      this.lastPointTime = time;
      return { accepted: false, reason: "duplicate" };
    }
    if (this.feedbackMode === TOUCH_FEEDBACK_GATED && !this.gateOpen) this.startGate(time);
    const filtered = {
      x: this.xFilter.filter(normalized.x, time),
      y: this.yFilter.filter(normalized.y, time),
    };
    if (!this.strokeStartSource) this.strokeStartSource = normalized;
    let rawSpeed = 0;
    if (this.previousFiltered && this.lastPointTime !== undefined) {
      const deltaSeconds = (time - this.lastPointTime) / 1_000;
      const sourceDistance = Math.hypot(normalized.x - this.previousSource.x, normalized.y - this.previousSource.y);
      this.strokePathDistance += sourceDistance;
      rawSpeed = sourceDistance / Math.max(deltaSeconds, 0.001);
      const positionFilteredSpeed = Math.hypot(filtered.x - this.previousFiltered.x, filtered.y - this.previousFiltered.y) / Math.max(deltaSeconds, 0.001);
      this.speedWindow.push(positionFilteredSpeed);
      this.sourceSpeedWindow.push(rawSpeed);
      if (this.speedWindow.length > 5) this.speedWindow.shift();
      if (this.sourceSpeedWindow.length > 5) this.sourceSpeedWindow.shift();
      // The coordinate-filtered estimate suppresses jitter during sustained
      // movement; the raw-distance median preserves the onset of a brief
      // swipe that the 1€ position filter would otherwise attenuate.
      this.filteredSpeed = Math.max(median(this.speedWindow), median(this.sourceSpeedWindow));
      this.speedFeature = Math.log1p(this.filteredSpeed);
      this.resampleSegment(this.previousSource, normalized);
      this.previousSource = normalized;
      this.shape = computeShapeMetrics(this.resampledPoints, {
        crossStrokeReversal: this.strokeReversalEvidence(time),
      });
    } else {
      this.appendResampledPoint(normalized);
      this.shape = computeShapeMetrics(this.resampledPoints, {
        crossStrokeReversal: this.strokeReversalEvidence(time),
      });
    }
    this.rawSpeed = rawSpeed;
    this.previousFiltered = filtered;
    this.previousSource = normalized;
    this.lastPointTime = time;
    this.pointSequence += 1;
    this.pointerType = point.pointerType ?? this.pointerType;
    this.liveInputEnded = false;
    this.motionActive = true;
    if (this.feedbackMode === TOUCH_FEEDBACK_GATED && this.gateOpen) {
      this.refreshFeatureMetrics();
      this.lastLiveFeaturePointSequence = this.pointSequence;
      this.applyLiveGateFeedback(time);
    }
    this.trace.push({ x: clientX, y: clientY, time, strokeId: this.strokeId });
    this.pruneTrace(time);
    return {
      accepted: true,
      strokeId: this.strokeId,
      normalizedX: normalized.x,
      normalizedY: normalized.y,
      rawSpeed: this.rawSpeed,
      filteredSpeed: this.filteredSpeed,
    };
  }

  pruneTrace(now) {
    const cutoff = now - TRACE_DURATION_MS;
    while (this.trace.length && this.trace[0].time < cutoff) this.trace.shift();
    if (this.trace.length > 1_024) this.trace.splice(0, this.trace.length - 1_024);
  }

  update(now, deltaSeconds) {
    this.pruneTrace(now);
    this.motionActive = this.lastPointTime !== undefined && now - this.lastPointTime <= MOTION_TIMEOUT_MS;
    if (this.feedbackMode === TOUCH_FEEDBACK_GATED) {
      if (this.gateOpen && this.pointSequence !== this.lastLiveFeaturePointSequence) {
        this.refreshFeatureMetrics();
        this.lastLiveFeaturePointSequence = this.pointSequence;
      }
      if (
        this.gateOpen
        && this.pointSequence !== this.lastGateFeaturePointSequence
        && (this.lastFeatureTime === undefined || now - this.lastFeatureTime >= FEATURE_INTERVAL_MS)
      ) {
        this.captureGateFeature();
        this.lastFeatureTime = now;
      }
      this.applyLiveGateFeedback(now);
      if (this.gateOpen && !this.motionActive) this.commitGate(now);
      this.feedbackHeld = false;
      return this.snapshot();
    }
    if (this.motionActive && (this.lastFeatureTime === undefined || now - this.lastFeatureTime >= FEATURE_INTERVAL_MS)) {
      this.lastFeatureTime = now;
      if (this.speedWindow.length > 0) this.speedRange.add(this.speedFeature);
      const shapeQualification = this.shapeQualification();
      if (shapeQualification.qualified) this.shapeRange.add(this.shape.shapeFeature);
      const boundsDelta = this.lastBoundsTime === undefined ? FEATURE_INTERVAL_MS / 1_000 : (now - this.lastBoundsTime) / 1_000;
      if (this.lastBoundsTime === undefined || now - this.lastBoundsTime >= 500) {
        this.speedRange.update(boundsDelta);
        this.shapeRange.update(boundsDelta);
        this.lastBoundsTime = now;
      }
      // Two measured segments are enough for full burst sensitivity. The
      // five-sample median still replaces isolated timing spikes as a burst
      // continues, without making a short fast swipe wait for a long path.
      this.speedConfidence = clamp(this.speedWindow.length / 2, 0, 1);
      this.shapeConfidence = shapeQualification.confidence;
      this.mappedX = this.shapeRange.normalize(this.shape.shapeFeature) * this.shapeConfidence;
      this.mappedY = this.speedRange.normalize(this.speedFeature) * this.speedConfidence;
    }
    this.feedbackHeld = this.lastPointTime !== undefined && now - this.lastPointTime <= FEEDBACK_HOLD_MS;
    const response = 1 / (this.feedbackHeld ? TARGET_ATTACK_SECONDS : TARGET_RELEASE_SECONDS);
    const desiredX = this.feedbackHeld ? this.mappedX : 0;
    const desiredY = this.feedbackHeld ? this.mappedY : 0;
    this.targetX = smoothToward(this.targetX, desiredX, response, deltaSeconds);
    this.targetY = smoothToward(this.targetY, desiredY, response, deltaSeconds);
    return this.snapshot();
  }

  refreshFeatureMetrics() {
    const shapeQualification = this.shapeQualification();
    this.speedConfidence = clamp(this.speedWindow.length / 2, 0, 1);
    this.shapeConfidence = shapeQualification.confidence;
    this.mappedX = this.shapeRange.normalize(this.shape.shapeFeature) * this.shapeConfidence;
    this.mappedY = this.speedRange.normalize(this.speedFeature) * this.speedConfidence;
    return shapeQualification.qualified;
  }

  captureGateFeature() {
    const qualifiedShape = this.refreshFeatureMetrics();
    if (this.speedWindow.length > 0) {
      this.gateSpeedFeatures.push(this.speedFeature);
      if (this.gateSpeedFeatures.length > 32) this.gateSpeedFeatures.shift();
      this.gateSpeedConfidence = Math.max(this.gateSpeedConfidence, this.speedConfidence);
    }
    if (qualifiedShape) {
      this.gateShapeFeatures.push(this.shape.shapeFeature);
      if (this.gateShapeFeatures.length > 32) this.gateShapeFeatures.shift();
      this.gateShapeConfidence = Math.max(this.gateShapeConfidence, this.shapeConfidence);
    }
    this.lastGateFeaturePointSequence = this.pointSequence;
  }

  applyLiveGateFeedback(now) {
    const integrationTime = finite(now, NaN);
    if (!Number.isFinite(integrationTime)) return;
    const elapsedSeconds = this.lastLiveIntegrationTime === undefined
      ? 0
      : clamp((integrationTime - this.lastLiveIntegrationTime) / 1_000, 0, 0.1);
    this.lastLiveIntegrationTime = integrationTime;
    const recentlyMoving = !this.liveInputEnded
      && this.lastPointTime !== undefined
      && integrationTime - this.lastPointTime <= GATE_LIVE_ACTIVITY_MS;
    this.gateLiveRateX = this.gateOpen && recentlyMoving ? gateRateForEvidence(this.mappedX) : 0;
    this.gateLiveRateY = this.gateOpen && recentlyMoving ? gateRateForEvidence(this.mappedY) : 0;
    this.gateLiveActive = this.gateLiveRateX !== 0 || this.gateLiveRateY !== 0;
    if (!this.gateLiveActive) return;

    const beforeX = this.targetX;
    const beforeY = this.targetY;
    this.targetX = clamp(this.targetX + this.gateLiveRateX * elapsedSeconds, -1, 1);
    this.targetY = clamp(this.targetY + this.gateLiveRateY * elapsedSeconds, -1, 1);
    this.gateLiveDeltaX += this.targetX - beforeX;
    this.gateLiveDeltaY += this.targetY - beforeY;
    this.gateDeltaX = this.gateLiveDeltaX;
    this.gateDeltaY = this.gateLiveDeltaY;
  }

  commitGate(now) {
    if (!this.gateOpen) return false;
    if (this.pointSequence !== this.lastGateFeaturePointSequence) this.captureGateFeature();
    const speedFeature = this.gateSpeedFeatures.length ? median(this.gateSpeedFeatures) : undefined;
    const shapeFeature = this.gateShapeFeatures.length ? median(this.gateShapeFeatures) : undefined;
    const mappedY = speedFeature === undefined ? 0 : this.speedRange.normalize(speedFeature) * this.gateSpeedConfidence;
    const mappedX = shapeFeature === undefined ? 0 : this.shapeRange.normalize(shapeFeature) * this.gateShapeConfidence;
    this.mappedX = mappedX;
    this.mappedY = mappedY;
    this.speedConfidence = this.gateSpeedConfidence;
    this.shapeConfidence = this.gateShapeConfidence;
    // Closing a gate freezes the exact live-controlled target. It must not add
    // a release-time step, because the participant stops moving when the
    // displayed point reaches the position they want to keep.
    this.gateDeltaX = this.gateLiveDeltaX;
    this.gateDeltaY = this.gateLiveDeltaY;
    this.gateDurationMs = Math.max(0, finite(now) - finite(this.gateStartedAt));
    this.gateCommitSequence += 1;
    if (speedFeature !== undefined) this.speedRange.add(speedFeature);
    if (shapeFeature !== undefined) this.shapeRange.add(shapeFeature);
    const boundsDelta = this.lastBoundsTime === undefined ? FEATURE_INTERVAL_MS / 1_000 : Math.max(0, (now - this.lastBoundsTime) / 1_000);
    this.speedRange.update(boundsDelta);
    this.shapeRange.update(boundsDelta);
    this.lastBoundsTime = now;
    this.gateOpen = false;
    this.gateStartedAt = undefined;
    this.gateLiveActive = false;
    this.gateLiveRateX = 0;
    this.gateLiveRateY = 0;
    return true;
  }

  snapshot() {
    return {
      algorithmVersion: TOUCH_TRACE_ALGORITHM_VERSION,
      feedbackMode: this.feedbackMode,
      pointerType: this.pointerType,
      strokeId: this.strokeId,
      rawSpeed: this.rawSpeed,
      filteredSpeed: this.filteredSpeed,
      speedFeature: this.speedFeature,
      shapeFeature: this.shape.shapeFeature,
      turnActivity: this.shape.turnActivity,
      turnCoherence: this.shape.turnCoherence,
      signFlipRate: this.shape.signFlipRate,
      roughness: this.shape.roughness,
      directionReversal: this.shape.directionReversal,
      circleScore: this.shape.circleScore,
      angularScore: this.shape.angularScore,
      windingTurns: this.shape.windingTurns,
      radialVariation: this.shape.radialVariation,
      directionEntropy: this.shape.directionEntropy,
      dominantCornerCount: this.shape.dominantCornerCount,
      speedLower: this.speedRange.low,
      speedUpper: this.speedRange.high,
      shapeLower: this.shapeRange.low,
      shapeUpper: this.shapeRange.high,
      mappedX: this.mappedX,
      mappedY: this.mappedY,
      targetX: this.targetX,
      targetY: this.targetY,
      speedConfidence: this.speedConfidence,
      shapeConfidence: this.shapeConfidence,
      motionActive: this.motionActive,
      feedbackHeld: this.feedbackHeld,
      speedContinuityActive: this.speedContinuityActive,
      gateId: this.gateId,
      gateOpen: this.gateOpen,
      gateCommitSequence: this.gateCommitSequence,
      gateDurationMs: this.gateDurationMs,
      gateDeltaX: this.gateDeltaX,
      gateDeltaY: this.gateDeltaY,
      gateLiveActive: this.gateLiveActive,
      gateLiveRateX: this.gateLiveRateX,
      gateLiveRateY: this.gateLiveRateY,
      gateLiveDeltaX: this.gateLiveDeltaX,
      gateLiveDeltaY: this.gateLiveDeltaY,
      speedCalibrationSamples: this.speedRange.count,
      shapeCalibrationSamples: this.shapeRange.count,
      tracePoints: this.trace,
    };
  }
}
