import { clamp, smoothToward } from "./math.js";

export const TOUCH_TRACE_ALGORITHM_VERSION = "touch-trace-v1";
export const TRACE_DURATION_MS = 4_000;
export const MOTION_TIMEOUT_MS = 400;
export const RESAMPLE_SPACING = 0.005;
export const RESAMPLED_POINT_LIMIT = 33;
export const FEATURE_INTERVAL_MS = 50;

const SPEED_DOMAIN_MAX = Math.log1p(4);
const TURN_THRESHOLD = 5 * Math.PI / 180;

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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
  }) {
    this.minimum = minimum;
    this.maximum = maximum;
    this.priorLow = priorLow;
    this.priorHigh = priorHigh;
    this.minimumSpan = minimumSpan;
    this.binCount = bins;
    this.capacity = capacity;
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
    const confidence = clamp(this.count / 100, 0, 1);
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

export function computeShapeMetrics(points) {
  if (!Array.isArray(points) || points.length < 9) {
    return { shapeFeature: 0, turnActivity: 0, turnCoherence: 0, signFlipRate: 0, roughness: 0 };
  }
  const turns = [];
  for (let index = 1; index < points.length - 1; index += 1) {
    const before = points[index - 1];
    const current = points[index];
    const after = points[index + 1];
    const ux = current.x - before.x;
    const uy = current.y - before.y;
    const vx = after.x - current.x;
    const vy = after.y - current.y;
    if (Math.hypot(ux, uy) < 1e-9 || Math.hypot(vx, vy) < 1e-9) continue;
    turns.push(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
  }
  if (turns.length === 0) {
    return { shapeFeature: 0, turnActivity: 0, turnCoherence: 0, signFlipRate: 0, roughness: 0 };
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
  const roughness = clamp(Math.max(median(deviations) / (Math.PI / 2), turnConcentration), 0, 1);
  const roundness = turnActivity * turnCoherence;
  const jaggedness = turnActivity * (0.65 * signFlipRate + 0.35 * roughness);
  return {
    shapeFeature: clamp(roundness - jaggedness, -1, 1),
    turnActivity,
    turnCoherence,
    signFlipRate,
    roughness,
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
  constructor({ width = 1, height = 1 } = {}) {
    this.speedRange = new AdaptiveRange({
      minimum: 0,
      maximum: SPEED_DOMAIN_MAX,
      priorLow: Math.log1p(0.02),
      priorHigh: Math.log1p(0.8),
      minimumSpan: 0.15,
    });
    this.shapeRange = new AdaptiveRange({
      minimum: -1,
      maximum: 1,
      priorLow: -0.35,
      priorHigh: 0.35,
      minimumSpan: 0.2,
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
  }

  resetSegment() {
    this.xFilter.reset();
    this.yFilter.reset();
    this.speedWindow = [];
    this.resampledPoints = [];
    this.previousFiltered = undefined;
    this.previousSource = undefined;
    this.resampleCarry = 0;
    this.shape = computeShapeMetrics([]);
    this.shapeConfidence = 0;
  }

  beginStroke(pointerType = "unknown") {
    this.strokeId += 1;
    this.pointerType = pointerType;
    this.resetSegment();
  }

  resize(width, height) {
    this.width = Math.max(1, finite(width, 1));
    this.height = Math.max(1, finite(height, 1));
    this.diagonal = Math.hypot(this.width, this.height);
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
    if (this.lastPointTime !== undefined && time - this.lastPointTime > MOTION_TIMEOUT_MS) this.beginStroke(point.pointerType);
    if (this.strokeId === 0) this.beginStroke(point.pointerType);

    const normalized = { x: clientX / this.diagonal, y: clientY / this.diagonal };
    if (this.previousSource && Math.hypot(normalized.x - this.previousSource.x, normalized.y - this.previousSource.y) < 1e-12) {
      this.lastPointTime = time;
      return { accepted: false, reason: "duplicate" };
    }
    const filtered = {
      x: this.xFilter.filter(normalized.x, time),
      y: this.yFilter.filter(normalized.y, time),
    };
    let rawSpeed = 0;
    if (this.previousFiltered && this.lastPointTime !== undefined) {
      const deltaSeconds = (time - this.lastPointTime) / 1_000;
      rawSpeed = Math.hypot(filtered.x - this.previousFiltered.x, filtered.y - this.previousFiltered.y) / Math.max(deltaSeconds, 0.001);
      this.speedWindow.push(rawSpeed);
      if (this.speedWindow.length > 5) this.speedWindow.shift();
      this.filteredSpeed = median(this.speedWindow);
      this.speedFeature = Math.log1p(this.filteredSpeed);
      this.resampleSegment(this.previousSource, normalized);
      this.shape = computeShapeMetrics(this.resampledPoints);
    } else {
      this.appendResampledPoint(normalized);
    }
    this.rawSpeed = rawSpeed;
    this.previousFiltered = filtered;
    this.previousSource = normalized;
    this.lastPointTime = time;
    this.pointerType = point.pointerType ?? this.pointerType;
    this.motionActive = true;
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
    if (this.motionActive && (this.lastFeatureTime === undefined || now - this.lastFeatureTime >= FEATURE_INTERVAL_MS)) {
      this.lastFeatureTime = now;
      if (this.speedWindow.length > 0) this.speedRange.add(this.speedFeature);
      const qualifiedShape = this.resampledPoints.length >= 9 && (this.resampledPoints.length - 1) * RESAMPLE_SPACING >= 0.04;
      if (qualifiedShape) this.shapeRange.add(this.shape.shapeFeature);
      const boundsDelta = this.lastBoundsTime === undefined ? FEATURE_INTERVAL_MS / 1_000 : (now - this.lastBoundsTime) / 1_000;
      if (this.lastBoundsTime === undefined || now - this.lastBoundsTime >= 500) {
        this.speedRange.update(boundsDelta);
        this.shapeRange.update(boundsDelta);
        this.lastBoundsTime = now;
      }
      this.speedConfidence = clamp(this.speedWindow.length / 5, 0, 1);
      this.shapeConfidence = qualifiedShape ? clamp((this.resampledPoints.length - 8) / 25, 0, 1) : 0;
      this.mappedX = this.shapeRange.normalize(this.shape.shapeFeature) * this.shapeConfidence;
      this.mappedY = this.speedRange.normalize(this.speedFeature) * this.speedConfidence;
    }
    const response = 1 / (this.motionActive ? 0.45 : 0.6);
    const desiredX = this.motionActive ? this.mappedX : 0;
    const desiredY = this.motionActive ? this.mappedY : 0;
    this.targetX = smoothToward(this.targetX, desiredX, response, deltaSeconds);
    this.targetY = smoothToward(this.targetY, desiredY, response, deltaSeconds);
    return this.snapshot();
  }

  snapshot() {
    return {
      algorithmVersion: TOUCH_TRACE_ALGORITHM_VERSION,
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
      tracePoints: this.trace,
    };
  }
}
