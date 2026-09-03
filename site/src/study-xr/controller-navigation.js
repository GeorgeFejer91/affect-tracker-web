import { deepFreeze } from "./panel-layout.js";

export const XR_CONTROLLER_DIRECTIONS = Object.freeze(["up", "down", "left", "right"]);

function enabledControls(controls) {
  if (!Array.isArray(controls)) throw new TypeError("controls must be an array.");
  return controls.filter((control) => control?.enabled !== false);
}

export function initialPanelFocus(controls, requestedId) {
  const enabled = enabledControls(controls);
  if (enabled.some(({ id }) => id === requestedId)) return requestedId;
  return enabled[0]?.id ?? null;
}

function spatialCandidateScore(current, candidate, direction, sourceIndex) {
  const rowDelta = candidate.row - current.row;
  const columnDelta = candidate.column - current.column;
  const inDirection = {
    up: rowDelta < 0,
    down: rowDelta > 0,
    left: columnDelta < 0,
    right: columnDelta > 0,
  }[direction];
  if (!inDirection) return null;
  const primary = direction === "up" || direction === "down" ? Math.abs(rowDelta) : Math.abs(columnDelta);
  const secondary = direction === "up" || direction === "down" ? Math.abs(columnDelta) : Math.abs(rowDelta);
  return primary * 10_000 + secondary * 100 + sourceIndex;
}

export function movePanelFocus(controls, focusId, direction) {
  const enabled = enabledControls(controls);
  if (enabled.length === 0) return null;
  const initial = initialPanelFocus(enabled, focusId);
  if (direction === "next" || direction === "previous") {
    const currentIndex = enabled.findIndex(({ id }) => id === initial);
    const delta = direction === "next" ? 1 : -1;
    return enabled[Math.max(0, Math.min(enabled.length - 1, currentIndex + delta))].id;
  }
  if (!XR_CONTROLLER_DIRECTIONS.includes(direction)) {
    throw new TypeError(`Unsupported controller focus direction: ${direction}`);
  }

  const current = enabled.find(({ id }) => id === initial);
  let winner = current;
  let winnerScore = Number.POSITIVE_INFINITY;
  enabled.forEach((candidate, index) => {
    if (candidate.id === current.id) return;
    const score = spatialCandidateScore(current, candidate, direction, index);
    if (score !== null && score < winnerScore) {
      winner = candidate;
      winnerScore = score;
    }
  });
  return winner.id;
}

function normalizedSnapshot(snapshot = {}) {
  const x = Number(snapshot.x);
  const y = Number(snapshot.y);
  return {
    x: Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0,
    y: Number.isFinite(y) ? Math.max(-1, Math.min(1, y)) : 0,
    select: snapshot.select === true,
    back: snapshot.back === true,
  };
}

export function controllerIntentFromSnapshot(previous, current, { axisThreshold = 0.65 } = {}) {
  if (!Number.isFinite(axisThreshold) || axisThreshold <= 0 || axisThreshold > 1) {
    throw new RangeError("axisThreshold must be finite and within (0, 1].");
  }
  const before = normalizedSnapshot(previous);
  const now = normalizedSnapshot(current);

  if (now.back && !before.back) return deepFreeze({ type: "back" });
  if (now.select && !before.select) return deepFreeze({ type: "activate" });

  const crossedX = Math.abs(before.x) < axisThreshold && Math.abs(now.x) >= axisThreshold;
  const crossedY = Math.abs(before.y) < axisThreshold && Math.abs(now.y) >= axisThreshold;
  if (!crossedX && !crossedY) return null;
  if (crossedX && (!crossedY || Math.abs(now.x) >= Math.abs(now.y))) {
    return deepFreeze({ type: "navigate", direction: now.x < 0 ? "left" : "right" });
  }
  return deepFreeze({ type: "navigate", direction: now.y < 0 ? "up" : "down" });
}
