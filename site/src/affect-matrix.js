export const AFFECT_MATRIX_SIZE = 21;
export const AFFECT_MATRIX_STATE_COUNT = AFFECT_MATRIX_SIZE * AFFECT_MATRIX_SIZE;
export const AFFECT_MATRIX_CENTER_INDEX = (AFFECT_MATRIX_SIZE - 1) / 2;
export const MIN_AFFECT_MATRIX_STATES_PER_SECOND = 0.5;
export const MAX_AFFECT_MATRIX_STATES_PER_SECOND = 20;
export const DEFAULT_AFFECT_MATRIX_STATES_PER_SECOND = 10;

const HALF_STEP_TOLERANCE = 1e-12;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function assertFiniteNumber(value, label) {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
  return value;
}

function assertMatrixIndex(index, label = "Matrix index") {
  if (!Number.isInteger(index) || index < 0 || index >= AFFECT_MATRIX_SIZE) {
    throw new RangeError(`${label} must be an integer between 0 and 20.`);
  }
  return index;
}

export function affectMatrixCoordinate(index) {
  return (assertMatrixIndex(index) - AFFECT_MATRIX_CENTER_INDEX) / AFFECT_MATRIX_CENTER_INDEX;
}

/**
 * Return the closest matrix index after clamping a finite coordinate to
 * [-1, 1]. An exact half-step always selects the greater (positive) index.
 */
export function nearestAffectMatrixIndex(coordinate) {
  const bounded = clamp(assertFiniteNumber(coordinate, "Matrix coordinate"), -1, 1);
  const scaled = (bounded + 1) * AFFECT_MATRIX_CENTER_INDEX;
  const lower = Math.floor(scaled);
  const upper = Math.ceil(scaled);
  if (lower === upper) return lower;
  const fraction = scaled - lower;
  return fraction < 0.5 - HALF_STEP_TOLERANCE ? lower : upper;
}

export function createAffectMatrixCell(column, row) {
  return Object.freeze({
    column: assertMatrixIndex(column, "Matrix column"),
    row: assertMatrixIndex(row, "Matrix row"),
  });
}

export function neutralAffectMatrixCell() {
  return createAffectMatrixCell(AFFECT_MATRIX_CENTER_INDEX, AFFECT_MATRIX_CENTER_INDEX);
}

export function affectMatrixCellFromCoordinates(x, y) {
  return createAffectMatrixCell(
    nearestAffectMatrixIndex(x),
    nearestAffectMatrixIndex(y),
  );
}

export function affectMatrixCellCoordinates(cell) {
  const normalized = normalizeCell(cell);
  return Object.freeze({
    x: affectMatrixCoordinate(normalized.column),
    y: affectMatrixCoordinate(normalized.row),
  });
}

function normalizeCell(cell, label = "Matrix cell") {
  if (!cell || typeof cell !== "object") {
    throw new TypeError(`${label} must provide column and row indices.`);
  }
  return createAffectMatrixCell(cell.column, cell.row);
}

const cellsEqual = (left, right) => (
  left.column === right.column && left.row === right.row
);

const stepIndexToward = (value, target) => value + Math.sign(target - value);

/**
 * Build the shortest 8-connected route, excluding the source and including
 * the destination. Both axes move while both differ, then the remaining axis
 * moves cardinally.
 */
export function buildAffectMatrixPath(fromCell, toCell) {
  const from = normalizeCell(fromCell, "Source matrix cell");
  const to = normalizeCell(toCell, "Target matrix cell");
  const path = [];
  let cursor = from;
  while (!cellsEqual(cursor, to)) {
    cursor = createAffectMatrixCell(
      stepIndexToward(cursor.column, to.column),
      stepIndexToward(cursor.row, to.row),
    );
    path.push(cursor);
  }
  return Object.freeze(path);
}

export function normalizeAffectMatrixRate(statesPerSecond) {
  return clamp(
    assertFiniteNumber(statesPerSecond, "Matrix traversal rate"),
    MIN_AFFECT_MATRIX_STATES_PER_SECOND,
    MAX_AFFECT_MATRIX_STATES_PER_SECOND,
  );
}

function createTraversalState({
  currentCell,
  targetCell,
  queuedPath,
  statesPerSecond,
  accumulatorSeconds,
}) {
  const current = normalizeCell(currentCell, "Current matrix cell");
  const target = normalizeCell(targetCell, "Target matrix cell");
  const path = Object.freeze(queuedPath.map((cell) => normalizeCell(cell, "Queued matrix cell")));
  const currentCoordinates = affectMatrixCellCoordinates(current);
  const targetCoordinates = affectMatrixCellCoordinates(target);
  return Object.freeze({
    currentCell: current,
    targetCell: target,
    currentX: currentCoordinates.x,
    currentY: currentCoordinates.y,
    targetX: targetCoordinates.x,
    targetY: targetCoordinates.y,
    queuedPath: path,
    statesPerSecond: normalizeAffectMatrixRate(statesPerSecond),
    accumulatorSeconds: Math.max(
      0,
      assertFiniteNumber(accumulatorSeconds, "Matrix traversal accumulator"),
    ),
    traversing: path.length > 0,
  });
}

export function createAffectMatrixTraversal({
  currentCell = neutralAffectMatrixCell(),
  statesPerSecond = DEFAULT_AFFECT_MATRIX_STATES_PER_SECOND,
} = {}) {
  const current = normalizeCell(currentCell, "Current matrix cell");
  return createTraversalState({
    currentCell: current,
    targetCell: current,
    queuedPath: [],
    statesPerSecond,
    accumulatorSeconds: 0,
  });
}

export function startAffectMatrixTraversal(
  traversal,
  targetCell,
  statesPerSecond = traversal?.statesPerSecond,
) {
  const current = normalizeCell(traversal?.currentCell, "Current matrix cell");
  const target = normalizeCell(targetCell, "Target matrix cell");
  return createTraversalState({
    currentCell: current,
    targetCell: target,
    queuedPath: buildAffectMatrixPath(current, target),
    statesPerSecond,
    accumulatorSeconds: 0,
  });
}

export function stepAffectMatrixTraversal(traversal) {
  const current = normalizeCell(traversal?.currentCell, "Current matrix cell");
  const target = normalizeCell(traversal?.targetCell, "Target matrix cell");
  const queuedPath = traversal?.queuedPath ?? [];
  if (!Array.isArray(queuedPath)) throw new TypeError("Queued matrix path must be an array.");
  if (queuedPath.length === 0) {
    return createTraversalState({
      currentCell: current,
      targetCell: current,
      queuedPath: [],
      statesPerSecond: traversal.statesPerSecond,
      accumulatorSeconds: 0,
    });
  }
  return createTraversalState({
    currentCell: queuedPath[0],
    targetCell: target,
    queuedPath: queuedPath.slice(1),
    statesPerSecond: traversal.statesPerSecond,
    accumulatorSeconds: 0,
  });
}

/**
 * Advance an immutable traversal by elapsed time. Callers that need every
 * visited node rendered should pass their frame-clamped delta; app.js already
 * bounds animation deltas to one 20 Hz matrix interval.
 */
export function advanceAffectMatrixTraversal(traversal, deltaSeconds) {
  const elapsed = assertFiniteNumber(deltaSeconds, "Matrix traversal delta");
  if (elapsed < 0) throw new RangeError("Matrix traversal delta cannot be negative.");

  const current = normalizeCell(traversal?.currentCell, "Current matrix cell");
  const target = normalizeCell(traversal?.targetCell, "Target matrix cell");
  const queuedPath = traversal?.queuedPath ?? [];
  if (!Array.isArray(queuedPath)) throw new TypeError("Queued matrix path must be an array.");
  const statesPerSecond = normalizeAffectMatrixRate(traversal?.statesPerSecond);
  if (queuedPath.length === 0) {
    return createTraversalState({
      currentCell: current,
      targetCell: current,
      queuedPath: [],
      statesPerSecond,
      accumulatorSeconds: 0,
    });
  }

  const interval = 1 / statesPerSecond;
  const accumulated = Math.max(
    0,
    assertFiniteNumber(traversal?.accumulatorSeconds, "Matrix traversal accumulator"),
  ) + elapsed;
  const availableSteps = Math.floor((accumulated + Number.EPSILON) / interval);
  if (availableSteps === 0) {
    return createTraversalState({
      currentCell: current,
      targetCell: target,
      queuedPath,
      statesPerSecond,
      accumulatorSeconds: accumulated,
    });
  }

  const completedSteps = Math.min(availableSteps, queuedPath.length);
  const nextPath = queuedPath.slice(completedSteps);
  return createTraversalState({
    currentCell: queuedPath[completedSteps - 1],
    targetCell: target,
    queuedPath: nextPath,
    statesPerSecond,
    accumulatorSeconds: nextPath.length > 0
      ? Math.max(0, accumulated - completedSteps * interval)
      : 0,
  });
}

export function stopAffectMatrixTraversal(traversal) {
  return createAffectMatrixTraversal({
    currentCell: traversal?.currentCell,
    statesPerSecond: traversal?.statesPerSecond,
  });
}

export function resetAffectMatrixTraversal(traversal) {
  return createAffectMatrixTraversal({
    currentCell: neutralAffectMatrixCell(),
    statesPerSecond: traversal?.statesPerSecond ?? DEFAULT_AFFECT_MATRIX_STATES_PER_SECOND,
  });
}
