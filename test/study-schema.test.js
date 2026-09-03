import test from "node:test";
import assert from "node:assert/strict";
import {
  createBlock,
  createDefaultStudy,
  createQuestionnaireItem,
  declaredCompatibility,
  portableBlockTypeLabel,
  portableQuestionTypeLabel,
  studyIdentifier,
} from "../site/src/study/schema.js";
import { comparisonFrame } from "../site/src/study/affect-comparison.js";

test("default study makes Face and Flubber an instruction presentation", () => {
  const study = createDefaultStudy({ studyId: "study-test" });
  const block = study.sections[0].trials[0].blocks[0];
  assert.deepEqual(
    { type: block.type, presentation: block.presentation },
    { type: "instruction", presentation: "faceFlubberComparison" },
  );
  assert.equal(study.pinnedSettings.acquisition.sampleRateHz, 20);
});

test("comparison frame shares one bounded coordinate and phase snapshot", () => {
  const frame = comparisonFrame({ currentX: 5, currentY: -2, phase: 1.25, sequence: 8 });
  assert.equal(frame.currentX, 1);
  assert.equal(frame.currentY, -1);
  assert.equal(frame.phase, 1.25);
  assert.equal(frame.sequence, 8);
  assert.equal(Object.isFrozen(frame), true);
});

test("YouTube blocks are explicitly Pages-only", () => {
  const study = createDefaultStudy({ studyId: "study-test" });
  study.sections[0].trials[0].blocks.splice(1, 0, {
    type: "video",
    blockId: "browser-video",
    purpose: "stimulus",
    source: { kind: "youtube", videoId: "pY6vrOpnM64", startMs: 0, endMs: 1000 },
    collectAffect: true,
  });
  assert.deepEqual(declaredCompatibility(study), {
    universal: false,
    desktop: false,
    pages2d: true,
    webXr: false,
    badge: "Pages 2D only",
  });
});

test("portable item and block factories reject unknown variants", () => {
  assert.equal(createBlock("instruction", "Intro").blockId, "intro");
  assert.equal(createQuestionnaireItem("affect2d", "Current affect").type, "affect2d");
  assert.throws(() => createBlock("html", "x"), /Unsupported study block type/);
  assert.throws(() => createQuestionnaireItem("freeText", "x"), /Unsupported questionnaire item type/);
});

test("generated study identifiers retain a readable prefix", () => {
  assert.equal(
    studyIdentifier("Pilot Study", () => "123e4567-e89b-12d3-a456-426614174000"),
    "pilot-study-123e4567-e89b-12d3-a456-426614174000",
  );
});

test("builder labels translate portable tokens without changing their schema values", () => {
  assert.equal(portableBlockTypeLabel("questionnaire"), "Questionnaire");
  assert.equal(portableQuestionTypeLabel("singleChoice"), "Single choice");
  assert.equal(portableQuestionTypeLabel("affect2d"), "2D affect response");
  assert.throws(() => portableBlockTypeLabel("randomizer"), /Unsupported study block type/);
  assert.throws(() => portableQuestionTypeLabel("freeText"), /Unsupported questionnaire item type/);
});
