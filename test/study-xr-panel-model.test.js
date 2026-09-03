import test from "node:test";
import assert from "node:assert/strict";
import {
  assertBoundedXrPanel,
  controllerIntentFromSnapshot,
  createXrPanelState,
  movePanelFocus,
  projectPortableBlockToXrPanel,
  reduceXrPanelController,
  XR_PANEL_LIMITS,
} from "../site/src/study-xr/index.js";

function instruction(overrides = {}) {
  return {
    type: "instruction",
    blockId: "instructions",
    content: "Read the instructions, then continue.",
    presentation: "standard",
    ...overrides,
  };
}

test("portable instruction text is paginated into immutable bounded panels", () => {
  const block = instruction({ content: "participant instruction ".repeat(180) });
  const state = createXrPanelState({ block });
  const first = projectPortableBlockToXrPanel({ block, state });

  assert.equal(assertBoundedXrPanel(first), true);
  assert.ok(first.content.pageCount > 1);
  assert.ok(first.title.lines.length <= XR_PANEL_LIMITS.titleLines);
  assert.ok(first.content.lines.length <= XR_PANEL_LIMITS.bodyLines);
  assert.ok(first.content.lines.every((line) => [...line].length <= XR_PANEL_LIMITS.bodyColumns));
  assert.ok(first.controls.every(({ labelLines }) => labelLines.length > 0));
  assert.equal(first.controls.at(-1).label, "Next");
  assert.equal(Object.isFrozen(first), true);

  const reduced = reduceXrPanelController({ block, state, intent: { type: "activate" } });
  assert.equal(reduced.effect, null);
  assert.equal(reduced.state.pageIndex, 1);
  const second = projectPortableBlockToXrPanel({ block, state: reduced.state });
  assert.equal(second.content.pageIndex, 1);
  assert.equal(second.controls.some(({ id }) => id === "nav:back"), true);
});

test("Face and Flubber share one exact presentation-only instruction snapshot", () => {
  const block = instruction({ presentation: "faceFlubberComparison" });
  const state = createXrPanelState({ block });
  const affectSnapshot = { currentX: 0.125, currentY: -0.75, phase: 2.375, sequence: 91 };
  const panel = projectPortableBlockToXrPanel({ block, state, affectSnapshot });

  assert.equal(panel.blockType, "instruction");
  assert.deepEqual(panel.presentation.snapshot, {
    currentX: 0.125,
    currentY: -0.75,
    phase: 2.375,
  });
  assert.strictEqual(panel.presentation.face.snapshot, panel.presentation.snapshot);
  assert.strictEqual(panel.presentation.flubber.snapshot, panel.presentation.snapshot);
  assert.equal(panel.presentation.presentationOnly, true);
  assert.equal(panel.presentation.diagnostic, false);
  assert.equal(panel.presentation.dataSource, false);
  assert.equal("sequence" in panel.presentation.snapshot, false);
  assert.equal("phase" in panel, false);
  assert.equal(Object.isFrozen(panel.presentation.snapshot), true);

  assert.throws(
    () => projectPortableBlockToXrPanel({
      block,
      state,
      affectSnapshot: { currentX: 1.001, currentY: 0, phase: 0 },
    }),
    /already be within/,
  );
  assert.throws(
    () => projectPortableBlockToXrPanel({ block, state, affectSnapshot: null }),
    /one finite currentX\/currentY\/phase snapshot/,
  );
});

test("break timing disables advancement until the supplied authoritative elapsed time is sufficient", () => {
  const block = {
    type: "break",
    blockId: "rest",
    content: "Rest while keeping the headset comfortable.",
    minimumDurationMs: 5_000,
  };
  const state = createXrPanelState({ block });
  const waiting = projectPortableBlockToXrPanel({ block, state, elapsedMs: 4_999 });
  assert.equal(waiting.timing.remainingMs, 1);
  assert.equal(waiting.controls.at(-1).enabled, false);
  assert.equal(waiting.focusId, null);

  const ignored = reduceXrPanelController({
    block,
    state,
    elapsedMs: 4_999,
    intent: { type: "next" },
  });
  assert.equal(ignored.effect, null);
  assert.strictEqual(ignored.state, state);

  const ready = reduceXrPanelController({
    block,
    state,
    elapsedMs: 5_000,
    intent: { type: "next" },
  });
  assert.deepEqual(ready.effect, {
    type: "studyCommand",
    blockId: "rest",
    command: { type: "advance" },
  });
  assert.strictEqual(ready.state, state);
});

test("completion emits an authority command effect without applying lifecycle locally", () => {
  const block = {
    type: "completion",
    blockId: "complete",
    content: "The study is complete.",
  };
  const state = createXrPanelState({ block });
  const reduced = reduceXrPanelController({ block, state, intent: { type: "activate" } });

  assert.deepEqual(reduced.effect, {
    type: "studyCommand",
    blockId: "complete",
    command: { type: "advance" },
  });
  assert.equal("phase" in reduced.state, false);
});

test("controller input is edge-triggered and spatial focus skips disabled controls", () => {
  assert.deepEqual(
    controllerIntentFromSnapshot(
      { x: 0, y: 0, select: false, back: false },
      { x: 0.8, y: 0, select: false, back: false },
    ),
    { type: "navigate", direction: "right" },
  );
  assert.equal(
    controllerIntentFromSnapshot(
      { x: 0.8, y: 0, select: false, back: false },
      { x: 0.9, y: 0, select: false, back: false },
    ),
    null,
  );
  assert.deepEqual(
    controllerIntentFromSnapshot(
      { select: false, back: false },
      { select: true, back: false },
    ),
    { type: "activate" },
  );
  assert.deepEqual(
    controllerIntentFromSnapshot(
      { select: false, back: false },
      { select: true, back: true },
    ),
    { type: "back" },
  );

  const controls = [
    { id: "left", row: 0, column: 0, enabled: true },
    { id: "blocked", row: 0, column: 1, enabled: false },
    { id: "right", row: 0, column: 2, enabled: true },
  ];
  assert.equal(movePanelFocus(controls, "left", "right"), "right");
  assert.equal(movePanelFocus(controls, "right", "right"), "right");
});
