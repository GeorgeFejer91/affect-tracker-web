import {
  XR_PANEL_LIMITS,
  boundedIndex,
  deepFreeze,
  paginateChoiceOptions,
  paginatePanelText,
} from "./panel-layout.js";
import { initialPanelFocus, movePanelFocus } from "./controller-navigation.js";

export const XR_QUESTIONNAIRE_STATE_SCHEMA = "affect-tracker-study-xr-questionnaire-state";
export const XR_QUESTIONNAIRE_STATE_VERSION = 1;
export const XR_PORTABLE_QUESTION_TYPES = Object.freeze([
  "acknowledgement",
  "singleChoice",
  "multipleChoice",
  "likert",
  "vas",
  "numeric",
  "affect2d",
]);

function assertQuestionnaire(questionnaire) {
  if (!questionnaire || typeof questionnaire.questionnaireId !== "string" || !questionnaire.questionnaireId) {
    throw new TypeError("A questionnaire with a non-empty questionnaireId is required.");
  }
  if (!Array.isArray(questionnaire.items) || questionnaire.items.length === 0) {
    throw new TypeError("The questionnaire must contain at least one item.");
  }
  for (const [index, item] of questionnaire.items.entries()) {
    if (!XR_PORTABLE_QUESTION_TYPES.includes(item?.type)) {
      throw new TypeError(`Unsupported questionnaire item type at items[${index}]: ${item?.type}`);
    }
  }
}

function cloneAnswer(answer) {
  const cloned = { ...answer };
  if (Array.isArray(answer.optionIds)) cloned.optionIds = [...answer.optionIds];
  return cloned;
}

function cloneItem(item) {
  const cloned = { ...item };
  if (Array.isArray(item.options)) cloned.options = item.options.map((option) => ({ ...option }));
  return cloned;
}

function answerMap(answers) {
  const map = new Map();
  for (const answer of answers ?? []) {
    if (!answer || typeof answer.itemId !== "string" || map.has(answer.itemId)) {
      throw new TypeError("Initial questionnaire answers require unique itemId values.");
    }
    map.set(answer.itemId, cloneAnswer(answer));
  }
  return map;
}

function answerFor(state, itemId) {
  return state.answers.find((answer) => answer.itemId === itemId);
}

function roundStable(value) {
  return Number(Number(value).toFixed(12));
}

function alignedValue(min, max, step, index) {
  const maxIndex = Math.max(0, Math.floor((max - min) / step + 1e-10));
  return roundStable(min + Math.max(0, Math.min(maxIndex, index)) * step);
}

function valueIndex(value, min, step) {
  return Math.round((value - min) / step);
}

function defaultScalar(item) {
  if (item.type === "likert") return item.min + Math.floor((item.max - item.min) / 2);
  return alignedValue(item.min, item.max, item.step, Math.floor((item.max - item.min) / item.step / 2));
}

function defaultAffect(item) {
  const value = alignedValue(-1, 1, item.step, Math.floor(2 / item.step / 2));
  return { valence: value, arousal: value };
}

function shownValue(item, answer) {
  if (item.type === "affect2d") {
    return answer ? { valence: answer.valence, arousal: answer.arousal } : defaultAffect(item);
  }
  return answer ? answer.value : defaultScalar(item);
}

function formatValue(value) {
  return Number.isInteger(value) ? String(value) : String(roundStable(value));
}

function scalarAligned(value, min, max, step) {
  if (!Number.isFinite(value) || value < min || value > max) return false;
  const steps = (value - min) / step;
  return Math.abs(steps - Math.round(steps)) <= 1e-8;
}

function itemIssue(item, answer) {
  if (!answer) {
    return item.required
      ? { code: "required", itemId: item.itemId, message: "Choose a response before continuing." }
      : null;
  }
  if (answer.type !== item.type || answer.itemId !== item.itemId) {
    return { code: "answerType", itemId: item.itemId, message: "The response does not match this question." };
  }
  switch (item.type) {
    case "acknowledgement":
      return item.required && answer.acknowledged !== true
        ? { code: "requiredAcknowledgement", itemId: item.itemId, message: "Accept the acknowledgement before continuing." }
        : null;
    case "singleChoice":
      return item.options.some(({ optionId }) => optionId === answer.optionId)
        ? null
        : { code: "unknownOption", itemId: item.itemId, message: "Choose one of the available responses." };
    case "multipleChoice": {
      const ids = Array.isArray(answer.optionIds) ? answer.optionIds : [];
      const unique = new Set(ids);
      const known = ids.every((id) => item.options.some(({ optionId }) => optionId === id));
      return unique.size === ids.length
        && known
        && ids.length >= item.minSelections
        && ids.length <= item.maxSelections
        ? null
        : {
            code: "selectionCount",
            itemId: item.itemId,
            message: `Choose between ${item.minSelections} and ${item.maxSelections} responses.`,
          };
    }
    case "likert":
      return Number.isInteger(answer.value) && answer.value >= item.min && answer.value <= item.max
        ? null
        : { code: "scaleValue", itemId: item.itemId, message: "Choose a value on the displayed scale." };
    case "vas":
    case "numeric":
      return scalarAligned(answer.value, item.min, item.max, item.step)
        ? null
        : { code: "scaleValue", itemId: item.itemId, message: "Choose a value aligned to the displayed scale." };
    case "affect2d":
      return scalarAligned(answer.valence, -1, 1, item.step)
        && scalarAligned(answer.arousal, -1, 1, item.step)
        ? null
        : { code: "affectValue", itemId: item.itemId, message: "Choose a valid valence and arousal point." };
    default:
      return { code: "unsupportedType", itemId: item.itemId, message: "This response type is unsupported." };
  }
}

function questionnaireIssues(questionnaire, answers) {
  const map = answerMap(answers);
  const issues = [];
  for (const item of questionnaire.items) {
    const issue = itemIssue(item, map.get(item.itemId));
    if (issue) issues.push(issue);
  }
  for (const itemId of map.keys()) {
    if (!questionnaire.items.some((item) => item.itemId === itemId)) {
      issues.push({ code: "unknownItem", itemId, message: "The response references an unknown question." });
    }
  }
  return issues;
}

function withAnswer(state, answer) {
  const answers = state.answers.filter(({ itemId }) => itemId !== answer.itemId);
  answers.push(cloneAnswer(answer));
  const order = new Map(state.itemOrder.map((itemId, index) => [itemId, index]));
  answers.sort((left, right) => order.get(left.itemId) - order.get(right.itemId));
  return { ...state, answers, feedback: null, submissionReady: false };
}

function feedbackState(state, issue) {
  return { ...state, feedback: issue, submissionReady: false };
}

export function createXrQuestionnaireState(questionnaire, { answers = [] } = {}) {
  assertQuestionnaire(questionnaire);
  const initialAnswerMap = answerMap(answers);
  const initialAnswers = [...initialAnswerMap.values()];
  const unknown = initialAnswers.find(({ itemId }) => !questionnaire.items.some((item) => item.itemId === itemId));
  if (unknown) throw new TypeError(`Initial answer references unknown item ${unknown.itemId}.`);
  const invalid = questionnaireIssues(questionnaire, initialAnswers)
    .find((issue) => initialAnswerMap.has(issue.itemId));
  if (invalid) throw new TypeError(invalid.message);
  return deepFreeze({
    schema: XR_QUESTIONNAIRE_STATE_SCHEMA,
    version: XR_QUESTIONNAIRE_STATE_VERSION,
    questionnaireId: questionnaire.questionnaireId,
    itemOrder: questionnaire.items.map(({ itemId }) => itemId),
    itemIndex: 0,
    promptPageIndex: 0,
    optionPageIndex: 0,
    focusId: null,
    answers: initialAnswers,
    feedback: null,
    submissionReady: false,
    interactionRevision: 0,
  });
}

function assertState(questionnaire, state) {
  if (state?.schema !== XR_QUESTIONNAIRE_STATE_SCHEMA || state?.version !== XR_QUESTIONNAIRE_STATE_VERSION) {
    throw new TypeError("Expected an Affect Tracker XR questionnaire state version 1.");
  }
  if (state.questionnaireId !== questionnaire.questionnaireId) {
    throw new TypeError("Questionnaire state belongs to a different questionnaire.");
  }
}

function choiceControls(item, state, optionPage) {
  const answer = answerFor(state, item.itemId);
  const selected = item.type === "singleChoice"
    ? new Set(answer ? [answer.optionId] : [])
    : new Set(answer?.optionIds ?? []);
  return optionPage.map((option, index) => ({
    id: `answer:${option.optionId}`,
    kind: "choice",
    role: item.type === "singleChoice" ? "radio" : "checkbox",
    label: option.label,
    labelLines: [...option.labelLines],
    selected: selected.has(option.optionId),
    enabled: true,
    row: index,
    column: 0,
    action: { type: item.type === "singleChoice" ? "chooseSingle" : "toggleMultiple", optionId: option.optionId },
  }));
}

function answerControls(item, state, optionPage) {
  const answer = answerFor(state, item.itemId);
  if (item.type === "singleChoice" || item.type === "multipleChoice") {
    return choiceControls(item, state, optionPage);
  }
  if (item.type === "acknowledgement") {
    return [{
      id: "answer:acknowledgement",
      kind: "acknowledgement",
      role: "checkbox",
      label: "I acknowledge this statement",
      selected: answer?.acknowledged === true,
      enabled: true,
      row: 0,
      column: 0,
      action: { type: "toggleAcknowledgement" },
    }];
  }
  if (item.type === "affect2d") {
    const value = shownValue(item, answer);
    return [{
      id: "answer:affect2d",
      kind: "affect2d",
      role: "application",
      label: `Valence ${formatValue(value.valence)}, arousal ${formatValue(value.arousal)}`,
      value,
      step: item.step,
      selected: Boolean(answer),
      enabled: true,
      row: 0,
      column: 0,
      action: { type: "commitAffect" },
      help: "Use left/right for valence and up/down for arousal. Press Select to confirm the shown point.",
    }];
  }
  const value = shownValue(item, answer);
  return [{
    id: "answer:value",
    kind: "scale",
    role: "slider",
    label: `${formatValue(value)}${item.unit ? ` ${item.unit}` : ""}`,
    value,
    min: item.min,
    max: item.max,
    step: item.type === "likert" ? 1 : item.step,
    minLabel: item.minLabel ?? formatValue(item.min),
    maxLabel: item.maxLabel ?? formatValue(item.max),
    selected: Boolean(answer),
    enabled: true,
    row: 0,
    column: 0,
    action: { type: "commitScalar" },
    help: "Use left/right to change the value. Press Select to confirm the shown value.",
  }];
}

function itemPresentationText(questionnaire, item, itemIndex) {
  const description = itemIndex === 0 ? String(questionnaire.description ?? "").trim() : "";
  return description ? `${description}\n\n${item.prompt}` : item.prompt;
}

function itemPages(questionnaire, item, itemIndex) {
  const promptPages = paginatePanelText(itemPresentationText(questionnaire, item, itemIndex));
  const optionPages = item.type === "singleChoice" || item.type === "multipleChoice"
    ? paginateChoiceOptions(item.options)
    : Object.freeze([Object.freeze([])]);
  return { promptPages, optionPages };
}

function hasPriorView(state) {
  return state.itemIndex > 0 || state.promptPageIndex > 0 || state.optionPageIndex > 0;
}

export function projectXrQuestionnaireView(questionnaire, state) {
  assertQuestionnaire(questionnaire);
  assertState(questionnaire, state);
  const itemIndex = boundedIndex(state.itemIndex, questionnaire.items.length);
  const item = questionnaire.items[itemIndex];
  const { promptPages, optionPages } = itemPages(questionnaire, item, itemIndex);
  const promptPageIndex = boundedIndex(state.promptPageIndex, promptPages.length);
  const optionPageIndex = boundedIndex(state.optionPageIndex, optionPages.length);
  const promptComplete = promptPageIndex === promptPages.length - 1;
  const visibleAnswers = promptComplete ? answerControls(item, state, optionPages[optionPageIndex]) : [];
  const finalOptionPage = optionPageIndex === optionPages.length - 1;
  const finalItem = itemIndex === questionnaire.items.length - 1;
  const forwardLabel = !promptComplete || !finalOptionPage
    ? "Next"
    : finalItem ? "Submit questionnaire" : item.required ? "Next question" : "Next question (response optional)";
  const navigation = [];
  if (hasPriorView({ ...state, itemIndex, promptPageIndex, optionPageIndex })) {
    navigation.push({
      id: "nav:back",
      kind: "navigation",
      role: "button",
      label: "Back",
      enabled: true,
      row: 20,
      column: 0,
      action: { type: "back" },
    });
  }
  navigation.push({
    id: finalItem && promptComplete && finalOptionPage ? "nav:submit" : "nav:next",
    kind: "navigation",
    role: "button",
    label: forwardLabel,
    enabled: true,
    row: 20,
    column: 1,
    action: { type: finalItem && promptComplete && finalOptionPage ? "submit" : "next" },
  });
  const controls = [...visibleAnswers, ...navigation];
  if (controls.length > XR_PANEL_LIMITS.controlsPerPanel) {
    throw new RangeError("The projected questionnaire page exceeds the bounded XR control limit.");
  }
  const focusId = initialPanelFocus(controls, state.focusId);
  const combinedPageCount = promptPages.length + optionPages.length - 1;
  const combinedPageIndex = promptComplete
    ? promptPages.length - 1 + optionPageIndex
    : promptPageIndex;
  return deepFreeze({
    questionnaireId: questionnaire.questionnaireId,
    title: questionnaire.title,
    description: questionnaire.description ?? "",
    item: cloneItem(item),
    itemIndex,
    itemCount: questionnaire.items.length,
    content: {
      accessibleText: itemPresentationText(questionnaire, item, itemIndex),
      lines: [...promptPages[promptPageIndex]],
      pageIndex: combinedPageIndex,
      pageCount: combinedPageCount,
    },
    optionPageIndex,
    optionPageCount: optionPages.length,
    controls,
    focusId,
    answer: answerFor(state, item.itemId) ?? null,
    feedback: state.feedback,
  });
}

function goBack(questionnaire, state) {
  if (state.optionPageIndex > 0) return { ...state, optionPageIndex: state.optionPageIndex - 1, focusId: null, feedback: null };
  if (state.promptPageIndex > 0) return { ...state, promptPageIndex: state.promptPageIndex - 1, focusId: null, feedback: null };
  if (state.itemIndex === 0) return state;
  const previousIndex = state.itemIndex - 1;
  const previousPages = itemPages(questionnaire, questionnaire.items[previousIndex], previousIndex);
  return {
    ...state,
    itemIndex: previousIndex,
    promptPageIndex: previousPages.promptPages.length - 1,
    optionPageIndex: previousPages.optionPages.length - 1,
    focusId: null,
    feedback: null,
  };
}

function submissionEffect(questionnaire, state) {
  const issues = questionnaireIssues(questionnaire, state.answers);
  if (issues.length > 0) {
    const first = issues[0];
    const itemIndex = questionnaire.items.findIndex(({ itemId }) => itemId === first.itemId);
    return {
      state: feedbackState({ ...state, itemIndex: Math.max(0, itemIndex), promptPageIndex: 0, optionPageIndex: 0, focusId: null }, first),
      effect: null,
    };
  }
  const order = new Map(questionnaire.items.map(({ itemId }, index) => [itemId, index]));
  const answers = state.answers.map(cloneAnswer).sort((left, right) => order.get(left.itemId) - order.get(right.itemId));
  return {
    state: { ...state, submissionReady: true, feedback: null },
    effect: {
      type: "studyCommand",
      command: {
        type: "submitQuestionnaire",
        questionnaireId: questionnaire.questionnaireId,
        answers,
      },
    },
  };
}

function goNext(questionnaire, state) {
  const item = questionnaire.items[state.itemIndex];
  const pages = itemPages(questionnaire, item, state.itemIndex);
  if (state.promptPageIndex < pages.promptPages.length - 1) {
    return { state: { ...state, promptPageIndex: state.promptPageIndex + 1, focusId: null, feedback: null }, effect: null };
  }
  if (state.optionPageIndex < pages.optionPages.length - 1) {
    return { state: { ...state, optionPageIndex: state.optionPageIndex + 1, focusId: null, feedback: null }, effect: null };
  }
  const issue = itemIssue(item, answerFor(state, item.itemId));
  if (issue) return { state: feedbackState(state, issue), effect: null };
  if (state.itemIndex === questionnaire.items.length - 1) return submissionEffect(questionnaire, state);
  return {
    state: {
      ...state,
      itemIndex: state.itemIndex + 1,
      promptPageIndex: 0,
      optionPageIndex: 0,
      focusId: null,
      feedback: null,
    },
    effect: null,
  };
}

function adjustScalar(item, state, direction) {
  const answer = answerFor(state, item.itemId);
  const current = shownValue(item, answer);
  const step = item.type === "likert" ? 1 : item.step;
  const delta = direction === "left" || direction === "down" ? -1 : 1;
  const value = alignedValue(item.min, item.max, step, valueIndex(current, item.min, step) + delta);
  return withAnswer(state, { type: item.type, itemId: item.itemId, value });
}

function adjustAffect(item, state, direction) {
  const answer = answerFor(state, item.itemId);
  const current = shownValue(item, answer);
  const xDelta = direction === "left" ? -1 : direction === "right" ? 1 : 0;
  const yDelta = direction === "down" ? -1 : direction === "up" ? 1 : 0;
  return withAnswer(state, {
    type: "affect2d",
    itemId: item.itemId,
    valence: alignedValue(-1, 1, item.step, valueIndex(current.valence, -1, item.step) + xDelta),
    arousal: alignedValue(-1, 1, item.step, valueIndex(current.arousal, -1, item.step) + yDelta),
  });
}

function activateAnswer(item, state, action) {
  const current = answerFor(state, item.itemId);
  switch (action.type) {
    case "toggleAcknowledgement":
      return withAnswer(state, {
        type: "acknowledgement",
        itemId: item.itemId,
        acknowledged: current?.acknowledged !== true,
      });
    case "chooseSingle":
      return withAnswer(state, { type: "singleChoice", itemId: item.itemId, optionId: action.optionId });
    case "toggleMultiple": {
      const selected = [...(current?.optionIds ?? [])];
      const index = selected.indexOf(action.optionId);
      if (index >= 0) selected.splice(index, 1);
      else if (selected.length >= item.maxSelections) {
        return feedbackState(state, {
          code: "maximumSelections",
          itemId: item.itemId,
          message: `Choose no more than ${item.maxSelections} responses.`,
        });
      } else selected.push(action.optionId);
      const sourceOrder = new Map(item.options.map(({ optionId }, optionIndex) => [optionId, optionIndex]));
      selected.sort((left, right) => sourceOrder.get(left) - sourceOrder.get(right));
      return withAnswer(state, { type: "multipleChoice", itemId: item.itemId, optionIds: selected });
    }
    case "commitScalar":
      return withAnswer(state, { type: item.type, itemId: item.itemId, value: shownValue(item, current) });
    case "commitAffect": {
      const value = shownValue(item, current);
      return withAnswer(state, { type: "affect2d", itemId: item.itemId, ...value });
    }
    default:
      return state;
  }
}

function reduceIntent(questionnaire, state, intent) {
  const view = projectXrQuestionnaireView(questionnaire, state);
  const item = view.item;
  if (intent?.type === "back") return { state: goBack(questionnaire, state), effect: null };
  if (intent?.type === "next") return goNext(questionnaire, state);
  if (intent?.type === "submit") return submissionEffect(questionnaire, state);

  if (intent?.type === "navigate") {
    const focused = view.controls.find(({ id }) => id === view.focusId);
    if (focused?.kind === "scale" && ["left", "right"].includes(intent.direction)) {
      return { state: adjustScalar(item, state, intent.direction), effect: null };
    }
    if (focused?.kind === "affect2d" && ["up", "down", "left", "right"].includes(intent.direction)) {
      return { state: adjustAffect(item, state, intent.direction), effect: null };
    }
    return {
      state: { ...state, focusId: movePanelFocus(view.controls, view.focusId, intent.direction), feedback: null },
      effect: null,
    };
  }

  if (intent?.type === "activate") {
    const focused = view.controls.find(({ id }) => id === view.focusId);
    if (!focused || focused.enabled === false) return { state, effect: null };
    if (focused.action.type === "back") return { state: goBack(questionnaire, state), effect: null };
    if (focused.action.type === "next") return goNext(questionnaire, state);
    if (focused.action.type === "submit") return submissionEffect(questionnaire, state);
    const nextState = activateAnswer(item, state, focused.action);
    if (["commitScalar", "commitAffect"].includes(focused.action.type)) {
      const forward = view.controls.find(({ action }) => ["next", "submit"].includes(action.type));
      return {
        state: forward ? { ...nextState, focusId: forward.id } : nextState,
        effect: null,
      };
    }
    return { state: nextState, effect: null };
  }

  throw new TypeError(`Unsupported questionnaire controller intent: ${intent?.type}`);
}

export function reduceXrQuestionnaireController(questionnaire, state, intent) {
  assertQuestionnaire(questionnaire);
  assertState(questionnaire, state);
  const result = reduceIntent(questionnaire, state, intent);
  const changed = result.state !== state;
  const nextState = changed
    ? { ...result.state, interactionRevision: state.interactionRevision + 1 }
    : result.state;
  return deepFreeze({ state: nextState, effect: result.effect });
}

export function questionnaireSubmission(questionnaire, state) {
  assertQuestionnaire(questionnaire);
  assertState(questionnaire, state);
  const result = submissionEffect(questionnaire, state);
  if (!result.effect) {
    const error = new Error(result.state.feedback?.message ?? "Questionnaire responses are incomplete.");
    error.code = result.state.feedback?.code ?? "incompleteQuestionnaire";
    throw error;
  }
  return result.effect.command;
}
