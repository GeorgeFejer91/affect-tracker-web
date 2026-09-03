import assert from "node:assert/strict";
import test from "node:test";

import {
  answerMarkup,
  collectAnswers,
  multipleChoiceSelectionError,
} from "../site/src/study/participant-ui.js";

function answerForm(entries) {
  const values = new Map(Object.entries(entries));
  return {
    elements: { namedItem: (name) => values.get(name) },
  };
}

test("optional VAS is absent until the participant explicitly enables it", () => {
  const item = {
    type: "vas",
    itemId: "comfort",
    prompt: "Comfort",
    required: false,
    min: 0,
    max: 100,
    step: 1,
    minLabel: "Low",
    maxLabel: "High",
  };
  assert.match(answerMarkup(item), /data-answer-enable/);
  assert.match(answerMarkup(item), /type="range"[^>]* disabled/);
  const input = { value: "0", disabled: true };
  assert.deepEqual(collectAnswers(answerForm({ "answer-comfort": input }), { items: [item] }), []);
  input.disabled = false;
  assert.deepEqual(collectAnswers(answerForm({ "answer-comfort": input }), { items: [item] }), [
    { type: "vas", itemId: "comfort", value: 0 },
  ]);
});

test("optional affect2d is omitted until both axes are explicitly enabled", () => {
  const item = { type: "affect2d", itemId: "affect", prompt: "Affect", required: false, step: 0.1 };
  const valence = { value: "0", disabled: true };
  const arousal = { value: "0", disabled: true };
  const form = answerForm({
    "answer-affect-valence": valence,
    "answer-affect-arousal": arousal,
  });
  assert.deepEqual(collectAnswers(form, { items: [item] }), []);
  valence.disabled = false;
  arousal.disabled = false;
  assert.deepEqual(collectAnswers(form, { items: [item] }), [
    { type: "affect2d", itemId: "affect", valence: 0, arousal: 0 },
  ]);
});

test("optional multiple choice may be omitted but validates any supplied selection", () => {
  const item = {
    type: "multipleChoice",
    itemId: "symptoms",
    prompt: "Select two or three",
    required: false,
    minSelections: 2,
    maxSelections: 3,
    options: [],
  };

  assert.equal(multipleChoiceSelectionError(item, 0), undefined);
  assert.equal(multipleChoiceSelectionError(item, 1), "Select between 2 and 3 choices.");
  assert.equal(multipleChoiceSelectionError(item, 2), undefined);
  assert.equal(multipleChoiceSelectionError(item, 4), "Select between 2 and 3 choices.");
});

test("required multiple choice enforces its minimum", () => {
  const item = {
    type: "multipleChoice",
    required: true,
    minSelections: 1,
    maxSelections: 2,
  };
  assert.equal(multipleChoiceSelectionError(item, 0), "Select between 1 and 2 choices.");
  assert.equal(multipleChoiceSelectionError(item, 1), undefined);
});
