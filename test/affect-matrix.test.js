import assert from "node:assert/strict";
import test from "node:test";
import {
  AFFECT_MATRIX_CENTER_INDEX,
  AFFECT_MATRIX_SIZE,
  AFFECT_MATRIX_STATE_COUNT,
  DEFAULT_AFFECT_MATRIX_STATES_PER_SECOND,
  MAX_AFFECT_MATRIX_STATES_PER_SECOND,
  MIN_AFFECT_MATRIX_STATES_PER_SECOND,
  advanceAffectMatrixTraversal,
  affectMatrixCellCoordinates,
  affectMatrixCellFromCoordinates,
  affectMatrixCoordinate,
  buildAffectMatrixPath,
  createAffectMatrixCell,
  createAffectMatrixTraversal,
  nearestAffectMatrixIndex,
  neutralAffectMatrixCell,
  normalizeAffectMatrixRate,
  resetAffectMatrixTraversal,
  startAffectMatrixTraversal,
  stepAffectMatrixTraversal,
  stopAffectMatrixTraversal,
} from "../site/src/affect-matrix.js";

const approximately = (actual, expected, tolerance = 1e-12) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be near ${expected}`);
};

test("21 by 21 matrix exposes 441 exact symmetric states with neutral at index 10", () => {
  assert.equal(AFFECT_MATRIX_SIZE, 21);
  assert.equal(AFFECT_MATRIX_STATE_COUNT, 441);
  assert.equal(AFFECT_MATRIX_CENTER_INDEX, 10);
  assert.equal(affectMatrixCoordinate(0), -1);
  assert.equal(affectMatrixCoordinate(10), 0);
  assert.equal(affectMatrixCoordinate(20), 1);

  const states = new Set();
  for (let row = 0; row < AFFECT_MATRIX_SIZE; row += 1) {
    for (let column = 0; column < AFFECT_MATRIX_SIZE; column += 1) {
      const x = affectMatrixCoordinate(column);
      const y = affectMatrixCoordinate(row);
      states.add(`${x.toFixed(1)}:${y.toFixed(1)}`);
      assert.equal(nearestAffectMatrixIndex(x), column);
      assert.equal(nearestAffectMatrixIndex(y), row);
      approximately(x, -affectMatrixCoordinate(AFFECT_MATRIX_SIZE - 1 - column));
      approximately(y, -affectMatrixCoordinate(AFFECT_MATRIX_SIZE - 1 - row));
    }
  }
  assert.equal(states.size, AFFECT_MATRIX_STATE_COUNT);
  assert.deepEqual(neutralAffectMatrixCell(), { column: 10, row: 10 });
  assert.deepEqual(affectMatrixCellCoordinates(neutralAffectMatrixCell()), { x: 0, y: 0 });
});

test("nearest-cell conversion clamps endpoints and resolves every half-step toward the positive index", () => {
  assert.equal(nearestAffectMatrixIndex(-99), 0);
  assert.equal(nearestAffectMatrixIndex(99), 20);
  for (let lower = 0; lower < AFFECT_MATRIX_SIZE - 1; lower += 1) {
    const midpoint = (
      affectMatrixCoordinate(lower) + affectMatrixCoordinate(lower + 1)
    ) / 2;
    assert.equal(nearestAffectMatrixIndex(midpoint), lower + 1);
  }
  assert.deepEqual(affectMatrixCellFromCoordinates(-0.95, 0.05), { column: 1, row: 11 });
  assert.throws(() => nearestAffectMatrixIndex(Number.NaN), /finite/);
  assert.throws(() => affectMatrixCoordinate(21), /between 0 and 20/);
});

test("every source and target use the shortest diagonal-then-cardinal 8-connected path", () => {
  for (let fromRow = 0; fromRow < AFFECT_MATRIX_SIZE; fromRow += 1) {
    for (let fromColumn = 0; fromColumn < AFFECT_MATRIX_SIZE; fromColumn += 1) {
      const from = createAffectMatrixCell(fromColumn, fromRow);
      for (let toRow = 0; toRow < AFFECT_MATRIX_SIZE; toRow += 1) {
        for (let toColumn = 0; toColumn < AFFECT_MATRIX_SIZE; toColumn += 1) {
          const to = createAffectMatrixCell(toColumn, toRow);
          const path = buildAffectMatrixPath(from, to);
          assert.equal(path.length, Math.max(
            Math.abs(toColumn - fromColumn),
            Math.abs(toRow - fromRow),
          ));
          let previous = from;
          for (const cell of path) {
            const columnStep = Math.abs(cell.column - previous.column);
            const rowStep = Math.abs(cell.row - previous.row);
            assert.ok(columnStep <= 1 && rowStep <= 1);
            assert.ok(columnStep + rowStep >= 1);
            if (previous.column !== toColumn && previous.row !== toRow) {
              assert.equal(columnStep, 1);
              assert.equal(rowStep, 1);
            }
            previous = cell;
          }
          assert.deepEqual(previous, to);
        }
      }
    }
  }

  assert.deepEqual(
    buildAffectMatrixPath(
      createAffectMatrixCell(0, 0),
      createAffectMatrixCell(3, 8),
    ).slice(0, 4),
    [
      { column: 1, row: 1 },
      { column: 2, row: 2 },
      { column: 3, row: 3 },
      { column: 3, row: 4 },
    ],
  );
});

test("traversal state is deeply immutable and step returns a new exact-node state", () => {
  const idle = createAffectMatrixTraversal();
  const started = startAffectMatrixTraversal(idle, createAffectMatrixCell(12, 8), 5);
  const stepped = stepAffectMatrixTraversal(started);

  assert.equal(Object.isFrozen(idle), true);
  assert.equal(Object.isFrozen(started), true);
  assert.equal(Object.isFrozen(started.currentCell), true);
  assert.equal(Object.isFrozen(started.targetCell), true);
  assert.equal(Object.isFrozen(started.queuedPath), true);
  assert.equal(Object.isFrozen(started.queuedPath[0]), true);
  assert.deepEqual(idle.currentCell, { column: 10, row: 10 });
  assert.deepEqual(started.currentCell, { column: 10, row: 10 });
  assert.deepEqual(stepped.currentCell, { column: 11, row: 9 });
  assert.equal(stepped.currentX, 0.1);
  assert.equal(stepped.currentY, -0.1);
  assert.deepEqual(stepped.targetCell, { column: 12, row: 8 });
  assert.equal(started.queuedPath.length, 2);
  assert.equal(stepped.queuedPath.length, 1);
});

test("time advancement retains sub-step accumulation and can consume several exact states", () => {
  const start = startAffectMatrixTraversal(
    createAffectMatrixTraversal(),
    createAffectMatrixCell(15, 10),
    4,
  );
  const early = advanceAffectMatrixTraversal(start, 0.1);
  assert.deepEqual(early.currentCell, { column: 10, row: 10 });
  approximately(early.accumulatorSeconds, 0.1);

  const first = advanceAffectMatrixTraversal(early, 0.15);
  assert.deepEqual(first.currentCell, { column: 11, row: 10 });
  approximately(first.accumulatorSeconds, 0);

  const several = advanceAffectMatrixTraversal(first, 0.76);
  assert.deepEqual(several.currentCell, { column: 14, row: 10 });
  assert.equal(several.queuedPath.length, 1);
  approximately(several.accumulatorSeconds, 0.01);

  const finished = advanceAffectMatrixTraversal(several, 0.24);
  assert.deepEqual(finished.currentCell, { column: 15, row: 10 });
  assert.deepEqual(finished.targetCell, { column: 15, row: 10 });
  assert.equal(finished.traversing, false);
  assert.equal(finished.accumulatorSeconds, 0);
  assert.equal(finished.currentX, 0.5);
  assert.equal(finished.targetX, 0.5);
});

test("rate bounds, stop, and reset preserve exact held states without mutating prior state", () => {
  assert.equal(DEFAULT_AFFECT_MATRIX_STATES_PER_SECOND, 10);
  assert.equal(normalizeAffectMatrixRate(0.1), MIN_AFFECT_MATRIX_STATES_PER_SECOND);
  assert.equal(normalizeAffectMatrixRate(100), MAX_AFFECT_MATRIX_STATES_PER_SECOND);
  assert.throws(() => normalizeAffectMatrixRate(Infinity), /finite/);

  const started = startAffectMatrixTraversal(
    createAffectMatrixTraversal({
      currentCell: createAffectMatrixCell(4, 16),
      statesPerSecond: 50,
    }),
    createAffectMatrixCell(20, 0),
  );
  assert.equal(started.statesPerSecond, MAX_AFFECT_MATRIX_STATES_PER_SECOND);
  const moved = advanceAffectMatrixTraversal(started, 0.05);
  const stopped = stopAffectMatrixTraversal(moved);
  assert.deepEqual(stopped.currentCell, moved.currentCell);
  assert.deepEqual(stopped.targetCell, moved.currentCell);
  assert.equal(stopped.traversing, false);
  assert.equal(stopped.accumulatorSeconds, 0);
  assert.equal(moved.traversing, true);

  const reset = resetAffectMatrixTraversal(stopped);
  assert.deepEqual(reset.currentCell, { column: 10, row: 10 });
  assert.deepEqual(reset.targetCell, { column: 10, row: 10 });
  assert.equal(reset.currentX, 0);
  assert.equal(reset.currentY, 0);
  assert.equal(reset.statesPerSecond, MAX_AFFECT_MATRIX_STATES_PER_SECOND);
  assert.throws(() => advanceAffectMatrixTraversal(started, -0.1), /cannot be negative/);
});
