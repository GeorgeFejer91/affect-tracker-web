import { clamp } from "./math.js";
import { createFlubberBroadcaster, createFlubberReceiver } from "./flubber-remote.js?v=collaboration-2";

export const UNIVERSE_ROOM = "affect_tracker_universe_v1";
export const UNIVERSE_STREAM_PREFIX = "aft_universe_";
export const UNIVERSE_CHANNEL = "flubberuniversev1";
export const UNIVERSE_LABEL_SUFFIX = "Universe FLUBBER";
export const PARTY_MAX_GUESTS = 8;

const IDLE_PHASES = new Set(["idle", "error"]);

function detailEvent(type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, "detail", { value: detail, enumerable: true });
  return event;
}

function activePhase(phase) {
  return !IDLE_PHASES.has(phase ?? "idle");
}

export function oneWayGroundRole({
  jsonBroadcastPhase,
  liveBroadcastPhase,
  jsonReceivePhase,
  liveReceivePhase,
} = {}) {
  const sending = activePhase(jsonBroadcastPhase) || activePhase(liveBroadcastPhase);
  const receiving = activePhase(jsonReceivePhase) || activePhase(liveReceivePhase);
  if (sending && receiving) return "conflict";
  if (sending) return "send";
  if (receiving) return "receive";
  return "idle";
}

export function combineUniverseCoordinates(local, remote) {
  const localX = clamp(Number(local?.currentX) || 0);
  const localY = clamp(Number(local?.currentY) || 0);
  if (!Number.isFinite(remote?.currentX) || !Number.isFinite(remote?.currentY)) {
    return { currentX: localX, currentY: localY };
  }
  return {
    currentX: clamp(localX + clamp(remote.currentX)),
    currentY: clamp(localY + clamp(remote.currentY)),
  };
}

export function partyFlubberPlacement({
  index = 0,
  count = 1,
  widgetX,
  widgetY,
  widgetSize,
  viewportWidth,
  viewportHeight,
} = {}) {
  const safeCount = Math.max(1, Math.floor(Number(count) || 1));
  const safeIndex = Math.min(safeCount - 1, Math.max(0, Math.floor(Number(index) || 0)));
  const mainSize = Math.max(1, Number(widgetSize) || 180);
  const width = Math.max(1, Number(viewportWidth) || 1);
  const height = Math.max(1, Number(viewportHeight) || 1);
  const centerX = Number.isFinite(widgetX) ? widgetX : width / 2;
  const centerY = Number.isFinite(widgetY) ? widgetY : height / 2;
  const size = Math.max(72, Math.min(132, mainSize * 0.56));
  const radius = Math.max(mainSize * 0.94, size * 1.4);
  const angle = safeCount === 1 ? 0 : (Math.PI * 2 * safeIndex) / safeCount;
  const directionX = Math.cos(angle);
  const directionY = Math.sin(angle);
  return {
    size,
    angle,
    x: clamp(centerX + directionX * radius, size / 2 + 8, width - size / 2 - 8),
    y: clamp(centerY + directionY * radius, size / 2 + 8, height - size / 2 - 8),
    budX: centerX + directionX * mainSize * 0.42,
    budY: centerY + directionY * mainSize * 0.42,
  };
}

function smoothstep(edge0, edge1, value) {
  const span = edge1 - edge0;
  const t = span <= 0 ? Number(value >= edge1) : clamp((value - edge0) / span, 0, 1);
  return t * t * (3 - 2 * t);
}

function pointAlong(center, direction, axial, lateral = 0) {
  return {
    x: center.x + direction.x * axial - direction.y * lateral,
    y: center.y + direction.y * axial + direction.x * lateral,
  };
}

function interpolateContourPoint(a, b, aValue, bValue, threshold) {
  const denominator = bValue - aValue;
  const t = Math.abs(denominator) < 1e-9 ? 0.5 : clamp((threshold - aValue) / denominator, 0, 1);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function contourKey(point) {
  return `${point.x.toFixed(3)},${point.y.toFixed(3)}`;
}

function contourSegmentsToPath(segments) {
  const endpointMap = new Map();
  for (let index = 0; index < segments.length; index += 1) {
    for (const point of segments[index]) {
      const key = contourKey(point);
      if (!endpointMap.has(key)) endpointMap.set(key, []);
      endpointMap.get(key).push(index);
    }
  }
  const unused = new Set(segments.map((_, index) => index));
  const contours = [];
  while (unused.size > 0) {
    const firstIndex = unused.values().next().value;
    unused.delete(firstIndex);
    const [start, next] = segments[firstIndex];
    const points = [start, next];
    const startKey = contourKey(start);
    let currentKey = contourKey(next);
    let guard = segments.length + 2;
    while (currentKey !== startKey && guard > 0) {
      guard -= 1;
      const nextIndex = (endpointMap.get(currentKey) ?? []).find((index) => unused.has(index));
      if (nextIndex === undefined) break;
      unused.delete(nextIndex);
      const [a, b] = segments[nextIndex];
      const nextPoint = contourKey(a) === currentKey ? b : a;
      points.push(nextPoint);
      currentKey = contourKey(nextPoint);
    }
    if (points.length >= 4 && currentKey === startKey) contours.push(points);
  }
  return {
    contourCount: contours.length,
    contours,
    path: contours.map((points) => [
      `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`,
      ...points.slice(1).map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`),
      "Z",
    ].join(" ")).join(" "),
  };
}

function parseClosedSvgPath(path) {
  const values = String(path ?? "").match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
  const points = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    if (Number.isFinite(values[index]) && Number.isFinite(values[index + 1])) {
      points.push({ x: values[index], y: values[index + 1] });
    }
  }
  return points;
}

function resampleClosedContour(points, count) {
  if (!Array.isArray(points) || points.length < 2 || count < 2) return [];
  const lengths = new Array(points.length + 1);
  lengths[0] = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    lengths[index + 1] = lengths[index] + Math.hypot(next.x - points[index].x, next.y - points[index].y);
  }
  const perimeter = lengths.at(-1);
  if (!(perimeter > 0)) return Array.from({ length: count }, () => ({ ...points[0] }));
  const sampled = [];
  let segment = 0;
  for (let index = 0; index < count; index += 1) {
    const distance = perimeter * index / count;
    while (segment + 1 < lengths.length && lengths[segment + 1] < distance) segment += 1;
    const start = points[segment % points.length];
    const end = points[(segment + 1) % points.length];
    const span = lengths[segment + 1] - lengths[segment];
    const amount = span > 0 ? (distance - lengths[segment]) / span : 0;
    sampled.push({ x: start.x + (end.x - start.x) * amount, y: start.y + (end.y - start.y) * amount });
  }
  return sampled;
}

function contourCentroid(points) {
  if (!points.length) return { x: 0, y: 0 };
  return points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
}

function alignClosedContour(source, target) {
  const count = target.length;
  if (source.length !== count || count === 0) return source;
  let bestScore = Infinity;
  let bestShift = 0;
  let bestReverse = false;
  const stride = Math.max(1, Math.floor(count / 32));
  for (const reverse of [false, true]) {
    for (let shift = 0; shift < count; shift += 1) {
      let score = 0;
      for (let index = 0; index < count; index += stride) {
        const sourceIndex = reverse
          ? (shift - index + count * 2) % count
          : (shift + index) % count;
        const dx = source[sourceIndex].x - target[index].x;
        const dy = source[sourceIndex].y - target[index].y;
        score += dx * dx + dy * dy;
      }
      if (score < bestScore) {
        bestScore = score;
        bestShift = shift;
        bestReverse = reverse;
      }
    }
  }
  return target.map((_, index) => source[bestReverse
    ? (bestShift - index + count * 2) % count
    : (bestShift + index) % count]);
}

function transformedCanonicalPoints(path, center, size, viewBoxSpan) {
  const scale = Math.max(1, Number(size) || 1) / Math.max(0.001, Number(viewBoxSpan) || 3.24);
  return parseClosedSvgPath(path).map((point) => ({
    x: center.x + point.x * scale,
    y: center.y + point.y * scale,
  }));
}

function pointsToClosedPath(points) {
  if (!points.length) return "";
  return [`M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`,
    ...points.slice(1).map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`), "Z"].join(" ");
}

export function morphPartyBirthContours({
  contours,
  mainPath,
  guestPath,
  mainCenter,
  guestCenter,
  mainSize,
  guestSize,
  progress = 0,
  viewBoxSpan = 3.24,
} = {}) {
  if (!Array.isArray(contours) || contours.length < 2) return { path: "", contours: [] };
  const targets = [
    transformedCanonicalPoints(mainPath, mainCenter, mainSize, viewBoxSpan),
    transformedCanonicalPoints(guestPath, guestCenter, guestSize, viewBoxSpan),
  ];
  if (targets.some((points) => points.length < 3)) return { path: "", contours: [] };
  const available = contours.map((points) => ({ points, center: contourCentroid(points) }));
  const mainIndex = available.reduce((best, item, index) => {
    const distance = Math.hypot(item.center.x - mainCenter.x, item.center.y - mainCenter.y);
    return distance < best.distance ? { index, distance } : best;
  }, { index: 0, distance: Infinity }).index;
  const orderedSources = [available[mainIndex].points, available[mainIndex === 0 ? 1 : 0].points];
  const t = smoothstep(0, 1, clamp(Number(progress) || 0, 0, 1));
  const morphed = targets.map((target, targetIndex) => {
    const source = alignClosedContour(resampleClosedContour(orderedSources[targetIndex], target.length), target);
    return target.map((point, index) => ({
      x: source[index].x + (point.x - source[index].x) * t,
      y: source[index].y + (point.y - source[index].y) * t,
    }));
  });
  return { contours: morphed, path: morphed.map(pointsToClosedPath).join(" ") };
}

function cellularFieldValue(point, cells, phase) {
  let value = 0;
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (cell.weight <= 0) continue;
    const dx = point.x - cell.x;
    const dy = point.y - cell.y;
    const angle = Math.atan2(dy, dx);
    const sinusoid = 1
      + cell.waveAmplitude * Math.sin(angle * cell.waveCount + phase + index * 1.71)
      + cell.waveAmplitude * 0.42 * Math.sin(angle * (cell.waveCount - 2) - phase * 1.37);
    const normalizedDistance = Math.hypot(dx, dy) / Math.max(1, cell.radius * sinusoid);
    value += cell.weight * 2 ** (-(normalizedDistance ** 6));
  }
  return value;
}

function cellularContour(cells, phase, resolution = 58) {
  const threshold = 0.5;
  const padding = Math.max(...cells.map((cell) => cell.radius)) * 0.46 + 8;
  const minX = Math.min(...cells.map((cell) => cell.x - cell.radius)) - padding;
  const maxX = Math.max(...cells.map((cell) => cell.x + cell.radius)) + padding;
  const minY = Math.min(...cells.map((cell) => cell.y - cell.radius)) - padding;
  const maxY = Math.max(...cells.map((cell) => cell.y + cell.radius)) + padding;
  const columns = Math.max(24, Math.floor(resolution));
  const rows = Math.max(24, Math.round(columns * (maxY - minY) / Math.max(1, maxX - minX)));
  const stepX = (maxX - minX) / columns;
  const stepY = (maxY - minY) / rows;
  const values = Array.from({ length: rows + 1 }, (_, row) => Array.from({ length: columns + 1 }, (_, column) => (
    cellularFieldValue({ x: minX + column * stepX, y: minY + row * stepY }, cells, phase)
  )));
  const segments = [];
  const segmentPairs = {
    1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]],
    6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]],
    11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[3, 0]],
  };
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const corners = [
        { x: minX + column * stepX, y: minY + row * stepY },
        { x: minX + (column + 1) * stepX, y: minY + row * stepY },
        { x: minX + (column + 1) * stepX, y: minY + (row + 1) * stepY },
        { x: minX + column * stepX, y: minY + (row + 1) * stepY },
      ];
      const cornerValues = [values[row][column], values[row][column + 1], values[row + 1][column + 1], values[row + 1][column]];
      const mask = cornerValues.reduce((result, value, index) => result | (value >= threshold ? 1 << index : 0), 0);
      if (mask === 0 || mask === 15) continue;
      const edgePoint = (edge) => {
        const endpoints = [[0, 1], [1, 2], [2, 3], [3, 0]][edge];
        return interpolateContourPoint(corners[endpoints[0]], corners[endpoints[1]], cornerValues[endpoints[0]], cornerValues[endpoints[1]], threshold);
      };
      let pairs = segmentPairs[mask];
      if (mask === 5 || mask === 10) {
        const centerValue = cellularFieldValue({ x: corners[0].x + stepX / 2, y: corners[0].y + stepY / 2 }, cells, phase);
        pairs = mask === 5
          ? centerValue >= threshold ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]]
          : centerValue >= threshold ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]];
      }
      for (const [edgeA, edgeB] of pairs ?? []) segments.push([edgePoint(edgeA), edgePoint(edgeB)]);
    }
  }
  return contourSegmentsToPath(segments);
}

export function partyBudVectorGeometry({
  progress = 0,
  originX,
  originY,
  centerX,
  centerY,
  finalX,
  finalY,
  mainRadius,
  guestRadius,
} = {}) {
  const p = clamp(Number(progress) || 0, 0, 1);
  const start = {
    x: Number.isFinite(originX) ? originX : Number(centerX) || 0,
    y: Number.isFinite(originY) ? originY : Number(centerY) || 0,
  };
  const center = { x: Number(centerX) || 0, y: Number(centerY) || 0 };
  const target = {
    x: Number.isFinite(finalX) ? finalX : center.x + 1,
    y: Number.isFinite(finalY) ? finalY : center.y,
  };
  const baseMainRadius = Math.max(1, Number(mainRadius) || 90);
  const baseGuestRadius = Math.max(1, Number(guestRadius) || 50);
  const centerProgress = smoothstep(0, 0.18, p);
  const mainCenter = {
    x: start.x + (center.x - start.x) * centerProgress,
    y: start.y + (center.y - start.y) * centerProgress,
  };
  const swell = smoothstep(0.16, 0.56, p) * (1 - smoothstep(0.70, 1, p));
  const shake = Math.sin(p * Math.PI * 18) * 4 * smoothstep(0.20, 0.34, p) * (1 - smoothstep(0.62, 0.78, p));
  const targetVector = { x: target.x - center.x, y: target.y - center.y };
  const targetDistance = Math.max(1, Math.hypot(targetVector.x, targetVector.y));
  const direction = { x: targetVector.x / targetDistance, y: targetVector.y / targetDistance };
  mainCenter.x -= direction.y * shake;
  mainCenter.y += direction.x * shake;
  const currentMainRadius = baseMainRadius * (1 + swell * 0.26);
  const growth = smoothstep(0.18, 0.60, p);
  const currentGuestRadius = baseGuestRadius * (0.06 + growth * 0.94);
  const travel = smoothstep(0.28, 0.84, p);
  const startDistance = currentMainRadius * 0.88;
  const currentDistance = startDistance + (targetDistance - startDistance) * travel;
  const guestCenter = pointAlong(mainCenter, direction, currentDistance, -shake * 0.35);
  const guestWeight = smoothstep(0.14, 0.38, p);
  const cells = [
    { ...mainCenter, radius: currentMainRadius, weight: 1, waveAmplitude: 0.035 + swell * 0.035, waveCount: 7 },
    { ...guestCenter, radius: currentGuestRadius, weight: guestWeight, waveAmplitude: 0.055 * growth, waveCount: 5 },
  ];
  const contour = cellularContour(cells, p * Math.PI * 3.4);
  return {
    progress: p,
    attached: contour.contourCount === 1 && guestWeight > 0.01,
    contourCount: contour.contourCount,
    contours: contour.contours,
    surfacePath: contour.path,
    main: { ...mainCenter, radius: currentMainRadius },
    guest: { ...guestCenter, radius: currentGuestRadius, opacity: smoothstep(0.24, 0.40, p) },
  };
}

const UNIVERSE_PROTOCOL = Object.freeze({
  room: UNIVERSE_ROOM,
  streamPrefix: UNIVERSE_STREAM_PREFIX,
  channelName: UNIVERSE_CHANNEL,
  labelSuffix: UNIVERSE_LABEL_SUFFIX,
});

export class UniverseLink extends EventTarget {
  constructor({
    broadcasterFactory = createFlubberBroadcaster,
    receiverFactory = createFlubberReceiver,
  } = {}) {
    super();
    this.broadcaster = broadcasterFactory(UNIVERSE_PROTOCOL);
    this.receiver = receiverFactory({
      ...UNIVERSE_PROTOCOL,
      autoSelect: false,
      receiverLabel: "Affect Tracker Universe partner",
      excludeSource: (streamId) => streamId === this.broadcaster.snapshot().streamId,
    });
    this.started = false;
    this.forward = () => this.dispatchEvent(detailEvent("statechange", this.snapshot()));
    this.forwardFrame = () => {
      this.dispatchEvent(detailEvent("frame", this.snapshot()));
    };
    this.broadcaster.addEventListener("statechange", this.forward);
    this.receiver.addEventListener("statechange", this.forward);
    this.receiver.addEventListener("frame", this.forwardFrame);
  }

  snapshot() {
    const sending = this.broadcaster.snapshot();
    const receiving = this.receiver.snapshot();
    const receivingCoordinates = (receiving.phase === "live" || receiving.phase === "stale") && receiving.latest;
    const reciprocal = Boolean(receivingCoordinates && sending.listenerCount > 0);
    let phase = "idle";
    if (sending.phase === "error" || receiving.phase === "error") phase = "error";
    else if (reciprocal && receiving.phase === "stale") phase = "stale";
    else if (reciprocal) phase = "live";
    else if (receivingCoordinates) phase = "awaiting-reciprocal";
    else if (receiving.phase === "connecting") phase = "connecting";
    else if (this.started) phase = "discovering";
    return {
      phase,
      enabled: this.started,
      reciprocal,
      sending,
      receiving,
      sources: receiving.sources ?? [],
      sourceLabel: receiving.sourceLabel ?? "",
      latest: receiving.latest,
      message: phase === "live"
        ? `Synchronized with ${receiving.sourceLabel}. Both local controls share one Flubber.`
        : phase === "awaiting-reciprocal"
          ? `Receiving ${receiving.sourceLabel}; waiting for that browser to choose your Universe signal.`
          : phase === "stale"
            ? `Universe signal lost; holding the last shared position.`
            : this.started ? "Announced to the Universe room. Choose a partner and ask them to choose you." : "Universe link off",
    };
  }

  async start({ sourceName }) {
    if (this.started) return this.snapshot();
    this.started = true;
    try {
      await this.broadcaster.start({ sourceName });
      await this.receiver.startDiscovery();
      this.forward();
      return this.snapshot();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async selectSource(streamId) {
    if (!this.started) return this.snapshot();
    await this.receiver.selectSource(streamId);
    return this.snapshot();
  }

  offer(currentX, currentY) {
    return this.broadcaster.offer(currentX, currentY);
  }

  async stop() {
    this.started = false;
    await Promise.all([this.receiver.stop(), this.broadcaster.stop()]);
    this.forward();
  }
}

export class FlubberParty extends EventTarget {
  constructor({
    discoveryFactory = createFlubberReceiver,
    receiverFactory = createFlubberReceiver,
    maxGuests = PARTY_MAX_GUESTS,
  } = {}) {
    super();
    this.receiverFactory = receiverFactory;
    this.maxGuests = Math.max(1, Math.floor(maxGuests));
    this.discovery = discoveryFactory({ autoSelect: false, receiverLabel: "Affect Tracker party radar" });
    this.guests = new Map();
    this.discovery.addEventListener("statechange", () => this.emitState());
  }

  snapshot() {
    return {
      phase: this.discovery.snapshot().phase,
      enabled: activePhase(this.discovery.snapshot().phase) || this.guests.size > 0,
      sources: this.discovery.snapshot().sources ?? [],
      guests: Array.from(this.guests, ([streamId, guest]) => ({
        streamId,
        label: guest.label,
        ...guest.receiver.snapshot(),
      })),
      maxGuests: this.maxGuests,
    };
  }

  emitState() {
    this.dispatchEvent(detailEvent("statechange", this.snapshot()));
  }

  async startDiscovery() {
    await this.discovery.startDiscovery();
    this.emitState();
    return this.snapshot();
  }

  async invite(streamId) {
    if (this.guests.has(streamId)) return this.snapshot();
    if (this.guests.size >= this.maxGuests) {
      throw new Error(`A FLUBBER party is limited to ${this.maxGuests} invited signals per browser.`);
    }
    const source = this.discovery.snapshot().sources.find((item) => item.streamId === streamId);
    if (!source) throw new Error("That FLUBBER signal is no longer visible on radar.");
    const receiver = this.receiverFactory({ autoSelect: false, receiverLabel: "Affect Tracker party guest" });
    const guest = { label: source.label, receiver };
    this.guests.set(streamId, guest);
    const forward = () => this.emitState();
    const forwardFrame = () => {
      this.dispatchEvent(detailEvent("frame", this.snapshot()));
    };
    guest.forward = forward;
    guest.forwardFrame = forwardFrame;
    receiver.addEventListener("statechange", forward);
    receiver.addEventListener("frame", forwardFrame);
    try {
      await receiver.startDiscovery();
      await receiver.selectSource(streamId);
      this.emitState();
      return this.snapshot();
    } catch (error) {
      await this.remove(streamId);
      throw error;
    }
  }

  async remove(streamId) {
    const guest = this.guests.get(streamId);
    if (!guest) return this.snapshot();
    this.guests.delete(streamId);
    guest.receiver.removeEventListener("statechange", guest.forward);
    guest.receiver.removeEventListener("frame", guest.forwardFrame);
    await guest.receiver.stop();
    this.emitState();
    return this.snapshot();
  }

  async stop() {
    const guests = Array.from(this.guests.values());
    this.guests.clear();
    for (const guest of guests) {
      guest.receiver.removeEventListener("statechange", guest.forward);
      guest.receiver.removeEventListener("frame", guest.forwardFrame);
    }
    await Promise.all([this.discovery.stop(), ...guests.map((guest) => guest.receiver.stop())]);
    this.emitState();
  }
}

export function createUniverseLink(options) {
  return new UniverseLink(options);
}

export function createFlubberParty(options) {
  return new FlubberParty(options);
}
