import test from "node:test";
import assert from "node:assert/strict";
import {
  createXrPanelState,
  createXrQuestionnaireState,
  projectPortableBlockToXrPanel,
  projectXrQuestionnaireView,
  questionnaireSubmission,
  reduceXrPanelController,
  reduceXrQuestionnaireController,
  XR_PANEL_LIMITS,
  XR_PORTABLE_QUESTION_TYPES,
} from "../site/src/study-xr/index.js";

function questionnaire(item, overrides = {}) {
  return {
    questionnaireId: `questionnaire-${item.type}`,
    title: "Participant questionnaire",
    description: "Use the controller to provide one response.",
    items: [{ required: true, ...item }],
    ...overrides,
  };
}

function reduce(definition, state, ...intents) {
  let current = state;
  let effect = null;
  for (const intent of intents) {
    ({ state: current, effect } = reduceXrQuestionnaireController(definition, current, intent));
  }
  return { state: current, effect };
}

test("all seven portable v1 question types project to controller-operable controls", () => {
  assert.deepEqual(XR_PORTABLE_QUESTION_TYPES, [
    "acknowledgement",
    "singleChoice",
    "multipleChoice",
    "likert",
    "vas",
    "numeric",
    "affect2d",
  ]);

  const cases = [
    {
      item: { type: "acknowledgement", itemId: "ack", prompt: "I am ready." },
      intents: [{ type: "activate" }],
      expected: { type: "acknowledgement", itemId: "ack", acknowledged: true },
    },
    {
      item: {
        type: "singleChoice",
        itemId: "single",
        prompt: "Choose one.",
        options: [{ optionId: "a", label: "Alpha" }, { optionId: "b", label: "Beta" }],
      },
      intents: [{ type: "navigate", direction: "down" }, { type: "activate" }],
      expected: { type: "singleChoice", itemId: "single", optionId: "b" },
    },
    {
      item: {
        type: "multipleChoice",
        itemId: "multiple",
        prompt: "Choose two.",
        minSelections: 2,
        maxSelections: 2,
        options: [{ optionId: "a", label: "Alpha" }, { optionId: "b", label: "Beta" }],
      },
      intents: [
        { type: "activate" },
        { type: "navigate", direction: "down" },
        { type: "activate" },
      ],
      expected: { type: "multipleChoice", itemId: "multiple", optionIds: ["a", "b"] },
    },
    {
      item: {
        type: "likert",
        itemId: "likert",
        prompt: "Rate agreement.",
        min: 1,
        max: 5,
        minLabel: "Disagree",
        maxLabel: "Agree",
      },
      intents: [{ type: "navigate", direction: "right" }, { type: "activate" }],
      expected: { type: "likert", itemId: "likert", value: 4 },
      forwardFocus: true,
    },
    {
      item: {
        type: "vas",
        itemId: "vas",
        prompt: "Rate intensity.",
        min: 0,
        max: 100,
        step: 5,
        minLabel: "None",
        maxLabel: "Extreme",
      },
      intents: [{ type: "navigate", direction: "left" }, { type: "activate" }],
      expected: { type: "vas", itemId: "vas", value: 45 },
      forwardFocus: true,
    },
    {
      item: {
        type: "numeric",
        itemId: "numeric",
        prompt: "Choose a value.",
        min: -2,
        max: 2,
        step: 0.5,
        unit: "units",
      },
      intents: [{ type: "navigate", direction: "right" }, { type: "activate" }],
      expected: { type: "numeric", itemId: "numeric", value: 0.5 },
      forwardFocus: true,
    },
    {
      item: { type: "affect2d", itemId: "affect", prompt: "Report current affect.", step: 0.5 },
      intents: [
        { type: "navigate", direction: "right" },
        { type: "navigate", direction: "up" },
        { type: "activate" },
      ],
      expected: { type: "affect2d", itemId: "affect", valence: 0.5, arousal: 0.5 },
      forwardFocus: true,
    },
  ];

  for (const entry of cases) {
    const definition = questionnaire(entry.item);
    const initial = createXrQuestionnaireState(definition);
    const firstView = projectXrQuestionnaireView(definition, initial);
    assert.ok(firstView.focusId?.startsWith("answer:"), entry.item.type);
    const result = reduce(definition, initial, ...entry.intents);
    assert.deepEqual(result.state.answers, [entry.expected], entry.item.type);
    if (entry.forwardFocus) assert.equal(result.state.focusId, "nav:submit", entry.item.type);
    assert.equal(Object.isFrozen(result.state), true, entry.item.type);

    const command = questionnaireSubmission(definition, result.state);
    assert.deepEqual(command, {
      type: "submitQuestionnaire",
      questionnaireId: definition.questionnaireId,
      answers: [entry.expected],
    });
  }
});

test("questionnaire submission emits one typed authority effect and never a lifecycle transition", () => {
  const definition = questionnaire({
    type: "acknowledgement",
    itemId: "ready",
    prompt: "I am ready.",
  });
  const initial = createXrQuestionnaireState(definition);
  const answered = reduce(definition, initial, { type: "activate" }).state;
  const submitted = reduce(definition, answered, { type: "next" });

  assert.deepEqual(submitted.effect, {
    type: "studyCommand",
    command: {
      type: "submitQuestionnaire",
      questionnaireId: definition.questionnaireId,
      answers: [{ type: "acknowledgement", itemId: "ready", acknowledged: true }],
    },
  });
  assert.equal(submitted.state.submissionReady, true);
  assert.equal("phase" in submitted.state, false);
  assert.equal("revision" in submitted.state, false);
});

test("the block adapter adds block identity to a questionnaire command without changing its payload", () => {
  const definition = questionnaire({
    type: "acknowledgement",
    itemId: "ready",
    prompt: "I am ready.",
  });
  const block = {
    type: "questionnaire",
    blockId: "pre-run-questionnaire",
    questionnaireId: definition.questionnaireId,
  };
  let state = createXrPanelState({ block, questionnaire: definition });
  const panel = projectPortableBlockToXrPanel({ block, questionnaire: definition, state });
  assert.equal(panel.response.questionnaireId, definition.questionnaireId);
  assert.equal(panel.response.questionType, "acknowledgement");

  state = reduceXrPanelController({
    block,
    questionnaire: definition,
    state,
    intent: { type: "activate" },
  }).state;
  const submitted = reduceXrPanelController({
    block,
    questionnaire: definition,
    state,
    intent: { type: "next" },
  });
  assert.deepEqual(submitted.effect, {
    type: "studyCommand",
    blockId: "pre-run-questionnaire",
    command: {
      type: "submitQuestionnaire",
      questionnaireId: definition.questionnaireId,
      answers: [{ type: "acknowledgement", itemId: "ready", acknowledged: true }],
    },
  });
  assert.equal("authorityGeneration" in submitted.effect, false);
  assert.equal("expectedRevision" in submitted.effect, false);
});

test("required responses fail locally with actionable feedback while optional omissions submit", () => {
  const required = questionnaire({
    type: "singleChoice",
    itemId: "required-choice",
    prompt: "Choose one.",
    options: [{ optionId: "yes", label: "Yes" }, { optionId: "no", label: "No" }],
  });
  const blocked = reduce(required, createXrQuestionnaireState(required), { type: "next" });
  assert.equal(blocked.effect, null);
  assert.deepEqual(blocked.state.feedback, {
    code: "required",
    itemId: "required-choice",
    message: "Choose a response before continuing.",
  });

  const optional = questionnaire({
    type: "numeric",
    itemId: "optional-number",
    prompt: "You may provide a value.",
    required: false,
    min: 0,
    max: 10,
    step: 1,
  });
  const submitted = reduce(optional, createXrQuestionnaireState(optional), { type: "next" });
  assert.deepEqual(submitted.effect.command.answers, []);
});

test("multiple-choice maximum is enforced without discarding prior selections", () => {
  const definition = questionnaire({
    type: "multipleChoice",
    itemId: "bounded-multiple",
    prompt: "Choose no more than two.",
    minSelections: 1,
    maxSelections: 2,
    options: [
      { optionId: "a", label: "Alpha" },
      { optionId: "b", label: "Beta" },
      { optionId: "c", label: "Gamma" },
    ],
  });
  let state = createXrQuestionnaireState(definition);
  state = reduce(definition, state, { type: "activate" }).state;
  state = reduce(definition, state, { type: "navigate", direction: "down" }, { type: "activate" }).state;
  const rejected = reduce(
    definition,
    state,
    { type: "navigate", direction: "down" },
    { type: "activate" },
  );
  assert.deepEqual(rejected.state.answers[0].optionIds, ["a", "b"]);
  assert.equal(rejected.state.feedback.code, "maximumSelections");
});

test("long prompts and choice labels are bounded and paginated without truncating source text", () => {
  const options = Array.from({ length: 13 }, (_, index) => ({
    optionId: `option-${index + 1}`,
    label: `Response ${index + 1} with a label that remains completely available to assistive rendering`,
  }));
  const definition = questionnaire({
    type: "singleChoice",
    itemId: "long-choice",
    prompt: "This is a deliberately long participant prompt. ".repeat(60),
    options,
  }, { description: "Important questionnaire context. ".repeat(20) });
  let state = createXrQuestionnaireState(definition);
  let view = projectXrQuestionnaireView(definition, state);

  assert.ok(view.content.pageCount > 3);
  assert.ok(view.content.lines.length <= XR_PANEL_LIMITS.bodyLines);
  assert.equal(view.controls.some(({ kind }) => kind === "choice"), false);
  assert.match(view.content.accessibleText, /Important questionnaire context/);
  assert.match(view.content.accessibleText, /deliberately long participant prompt/);

  while (!view.controls.some(({ kind }) => kind === "choice")) {
    state = reduce(definition, state, { type: "next" }).state;
    view = projectXrQuestionnaireView(definition, state);
  }
  assert.ok(view.optionPageCount >= 3);
  assert.ok(view.controls.filter(({ kind }) => kind === "choice").length <= XR_PANEL_LIMITS.choicesPerPage);
  assert.ok(view.controls.length <= XR_PANEL_LIMITS.controlsPerPanel);
  assert.equal(view.controls.find(({ id }) => id === "answer:option-1").label, options[0].label);
});

test("projection clones question definitions and never freezes caller-owned study data", () => {
  const item = {
    type: "singleChoice",
    itemId: "mutable-source",
    prompt: "Choose one.",
    required: true,
    options: [{ optionId: "a", label: "Alpha" }],
  };
  const definition = questionnaire(item);
  const view = projectXrQuestionnaireView(definition, createXrQuestionnaireState(definition));

  assert.equal(Object.isFrozen(view.item), true);
  assert.equal(Object.isFrozen(definition.items[0]), false);
  definition.items[0].prompt = "Still mutable outside the adapter";
  assert.equal(definition.items[0].prompt, "Still mutable outside the adapter");
});
