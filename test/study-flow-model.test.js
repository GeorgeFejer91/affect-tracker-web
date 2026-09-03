import assert from "node:assert/strict";
import test from "node:test";

import {
  branchSourceCandidates,
  canAddCompletionBlock,
  canRemoveCompletionBlock,
  createDefaultRunCondition,
  instructionPreviewCandidates,
  orderPolicyLabel,
  preferredInstructionPreview,
  questionnaireItemBranchIssues,
  runConditionLiteralIssue,
  selectionAfterSwap,
  setRunConditionExpectedValue,
  studyHasCompletionBlock,
  swapItems,
} from "../site/src/study/flow-model.js";
import { createBlock, createDefaultStudy } from "../site/src/study/schema.js";

test("moving either side of a swap preserves the selected logical item", () => {
  const items = ["first", "selected", "moved"];
  swapItems(items, 2, 1);
  assert.deepEqual(items, ["first", "moved", "selected"]);
  assert.equal(selectionAfterSwap(1, 2, 1), 2);
  assert.equal(selectionAfterSwap(2, 2, 1), 1);
  assert.equal(selectionAfterSwap(0, 2, 1), 0);
});

test("flow moves fail closed for missing items", () => {
  assert.throws(() => swapItems(["only"], 0, 1), RangeError);
  assert.throws(() => swapItems({}, 0, 1), TypeError);
});

function branchFixture() {
  const items = [
    { type: "acknowledgement", itemId: "ready", prompt: "Ready?", required: true },
    { type: "singleChoice", itemId: "choice", prompt: "Choose", required: true, options: [{ optionId: "a", label: "A" }] },
    { type: "multipleChoice", itemId: "multi", prompt: "Choose any", required: true, options: [{ optionId: "b", label: "B" }] },
    { type: "likert", itemId: "likert", prompt: "Rate", required: true, min: 1, max: 5 },
    { type: "vas", itemId: "vas", prompt: "Rate", required: true, min: 0, max: 100, step: 5 },
    { type: "numeric", itemId: "number", prompt: "Number", required: true, min: -10, max: 10, step: 0.5 },
    { type: "affect2d", itemId: "affect", prompt: "Affect", required: true, step: 0.3 },
    { type: "numeric", itemId: "optional", prompt: "Optional", required: false, min: 0, max: 10, step: 1 },
  ];
  return {
    questionnaires: [{ questionnaireId: "source-form", items }],
    sections: [
      {
        sectionId: "source",
        orderPolicy: { type: "fixed" },
        trials: [{
          trialId: "source-trial",
          blocks: [{ type: "questionnaire", blockId: "source-block", questionnaireId: "source-form" }],
        }],
      },
      {
        sectionId: "random-source",
        orderPolicy: { type: "seededShuffle" },
        trials: [{
          trialId: "random-trial",
          blocks: [{ type: "questionnaire", blockId: "random-block", questionnaireId: "source-form" }],
        }],
      },
      { sectionId: "target", orderPolicy: { type: "fixed" }, trials: [] },
    ],
  };
}

test("branch candidates expose every typed value from earlier fixed unconditional sections", () => {
  const candidates = branchSourceCandidates(branchFixture(), 2);
  assert.deepEqual(candidates.map(({ item }) => item.type), [
    "acknowledgement",
    "singleChoice",
    "multipleChoice",
    "likert",
    "vas",
    "numeric",
    "affect2d",
  ]);
  assert.ok(candidates.every(({ block }) => block.blockId === "source-block"));
});

test("branch defaults and edits retain the core's typed runIf shapes", () => {
  const candidates = branchSourceCandidates(branchFixture(), 2);
  const byType = new Map(candidates.map((candidate) => [candidate.item.type, candidate]));

  assert.deepEqual(createDefaultRunCondition(byType.get("acknowledgement")).value, {
    type: "acknowledgement",
    acknowledged: true,
  });
  assert.equal(createDefaultRunCondition(byType.get("singleChoice")).value.optionId, "a");
  assert.equal(createDefaultRunCondition(byType.get("multipleChoice")).optionId, "b");
  assert.deepEqual(createDefaultRunCondition(byType.get("likert")).value, { type: "likert", value: 1 });
  assert.deepEqual(createDefaultRunCondition(byType.get("vas")).value, { type: "vas", value: 0 });
  assert.deepEqual(createDefaultRunCondition(byType.get("numeric")).value, { type: "numeric", value: -10 });
  assert.deepEqual(createDefaultRunCondition(byType.get("affect2d")).value, {
    type: "affect2d",
    valence: -0.1,
    arousal: -0.1,
  });

  const numeric = createDefaultRunCondition(byType.get("numeric"));
  setRunConditionExpectedValue(numeric, byType.get("numeric").item, undefined, "2.5");
  assert.equal(numeric.value.value, 2.5);

  const affect = createDefaultRunCondition(byType.get("affect2d"));
  setRunConditionExpectedValue(affect, byType.get("affect2d").item, "valence", "0.2");
  setRunConditionExpectedValue(affect, byType.get("affect2d").item, "arousal", "-0.4");
  assert.deepEqual(affect.value, { type: "affect2d", valence: 0.2, arousal: -0.4 });
  assert.throws(
    () => setRunConditionExpectedValue(numeric, byType.get("numeric").item, undefined, ""),
    /cannot be blank/,
  );
  assert.throws(
    () => setRunConditionExpectedValue(numeric, byType.get("numeric").item, undefined, "2.25"),
    /configured step/,
  );
  assert.throws(
    () => setRunConditionExpectedValue(affect, byType.get("affect2d").item, "valence", "1.2"),
    /configured step/,
  );
});

test("flow labels present the three supported section policies in plain language", () => {
  assert.equal(orderPolicyLabel("fixed"), "Fixed");
  assert.equal(orderPolicyLabel("seededShuffle"), "Seeded shuffle");
  assert.equal(orderPolicyLabel("williamsBalancedLatinSquare"), "Williams counterbalance");
  assert.throws(() => orderPolicyLabel("evenlyPresent"), /Unsupported order policy/);
});

test("completion creation is restricted to one final fixed location and malformed legacy blocks remain removable", () => {
  const study = createDefaultStudy({ studyId: "completion-builder-guard" });
  assert.equal(studyHasCompletionBlock(study), true);
  assert.equal(canAddCompletionBlock(study, 1, 0), false);
  assert.equal(canRemoveCompletionBlock(study, 2, 0, 0), false);

  study.sections[1].trials[0].blocks.push(createBlock("completion", "legacy-misplaced"));
  assert.equal(canRemoveCompletionBlock(study, 1, 0, 1), true);
  assert.equal(canRemoveCompletionBlock(study, 2, 0, 0), false);
  study.sections[1].trials[0].blocks.pop();

  study.sections[2].trials[0].blocks.length = 0;
  assert.equal(studyHasCompletionBlock(study), false);
  assert.equal(canAddCompletionBlock(study, 1, 0), false);
  assert.equal(canAddCompletionBlock(study, 2, 0), true);
  study.sections[2].orderPolicy = { type: "seededShuffle" };
  assert.equal(canAddCompletionBlock(study, 2, 0), false);
});

test("stale branch literals are surfaced before a replacement control is rendered", () => {
  const study = branchFixture();
  const candidates = branchSourceCandidates(study, 2);
  const byType = new Map(candidates.map((candidate) => [candidate.item.type, candidate]));

  const choiceSource = byType.get("singleChoice");
  const choice = createDefaultRunCondition(choiceSource);
  assert.equal(runConditionLiteralIssue(choice, choiceSource.item), undefined);
  choiceSource.item.options = [{ optionId: "replacement", label: "Replacement" }];
  assert.match(runConditionLiteralIssue(choice, choiceSource.item), /no longer available/);
  study.sections[2].trials.push({ trialId: "conditional", blocks: [], runIf: choice });
  assert.deepEqual(
    questionnaireItemBranchIssues(study, "source-form", choiceSource.item).map(({ trial, issue }) => [trial.trialId, issue]),
    [["conditional", "The saved expected choice is no longer available."]],
  );
  assert.equal(
    runConditionLiteralIssue(createDefaultRunCondition(choiceSource), choiceSource.item),
    undefined,
  );

  const likertSource = byType.get("likert");
  const likert = createDefaultRunCondition(likertSource);
  likert.value.value = 5;
  likertSource.item.max = 3;
  assert.match(runConditionLiteralIssue(likert, likertSource.item), /outside the current scale/);

  const numericSource = byType.get("numeric");
  const numeric = createDefaultRunCondition(numericSource);
  numeric.value.type = "vas";
  assert.match(runConditionLiteralIssue(numeric, numericSource.item), /range or step/);
});

test("instruction preview initially prefers Face and Flubber and still permits explicit selection", () => {
  const study = createDefaultStudy({ studyId: "instruction-preview-choice" });
  study.sections[0].trials[0].blocks[0].presentation = "standard";
  study.sections[1].trials[0].blocks[0].presentation = "faceFlubberComparison";
  const candidates = instructionPreviewCandidates(study);

  assert.equal(preferredInstructionPreview(candidates)?.block.blockId, "main-instructions");
  assert.equal(
    preferredInstructionPreview(candidates, "instructions")?.block.blockId,
    "instructions",
  );
  assert.equal(preferredInstructionPreview([], "missing"), undefined);
});
