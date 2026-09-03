export function swapItems(items, from, to) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array.");
  if (![from, to].every((index) => Number.isSafeInteger(index) && index >= 0 && index < items.length)) {
    throw new RangeError("Move indices must identify existing items.");
  }
  [items[from], items[to]] = [items[to], items[from]];
  return items;
}

export function selectionAfterSwap(selected, from, to) {
  if (selected === from) return to;
  if (selected === to) return from;
  return selected;
}

const ORDER_POLICY_LABELS = Object.freeze({
  fixed: "Fixed",
  seededShuffle: "Seeded shuffle",
  williamsBalancedLatinSquare: "Williams counterbalance",
});

const BRANCHABLE_ITEM_TYPES = new Set([
  "acknowledgement",
  "singleChoice",
  "multipleChoice",
  "likert",
  "vas",
  "numeric",
  "affect2d",
]);

export function orderPolicyLabel(type) {
  const label = ORDER_POLICY_LABELS[type];
  if (!label) throw new TypeError(`Unsupported order policy: ${type}`);
  return label;
}

function completionBlocks(study) {
  const found = [];
  for (const [sectionIndex, section] of (study?.sections ?? []).entries()) {
    for (const [trialIndex, trial] of (section.trials ?? []).entries()) {
      for (const [blockIndex, block] of (trial.blocks ?? []).entries()) {
        if (block.type === "completion") found.push({ sectionIndex, trialIndex, blockIndex });
      }
    }
  }
  return found;
}

export function studyHasCompletionBlock(study) {
  return completionBlocks(study).length > 0;
}

export function isTerminalCompletionBlock(study, sectionIndex, trialIndex, blockIndex) {
  const section = study?.sections?.[sectionIndex];
  const trial = section?.trials?.[trialIndex];
  const block = trial?.blocks?.[blockIndex];
  return block?.type === "completion"
    && section.orderPolicy?.type === "fixed"
    && sectionIndex === study.sections.length - 1
    && trialIndex === section.trials.length - 1
    && blockIndex === trial.blocks.length - 1;
}

export function canAddCompletionBlock(study, sectionIndex, trialIndex) {
  if (studyHasCompletionBlock(study)) return false;
  const section = study?.sections?.[sectionIndex];
  const trial = section?.trials?.[trialIndex];
  return Boolean(
    trial
    && section.orderPolicy?.type === "fixed"
    && sectionIndex === study.sections.length - 1
    && trialIndex === section.trials.length - 1,
  );
}

export function canRemoveCompletionBlock(study, sectionIndex, trialIndex, blockIndex) {
  if (study?.sections?.[sectionIndex]?.trials?.[trialIndex]?.blocks?.[blockIndex]?.type !== "completion") {
    return false;
  }
  if (!study.completionPolicy?.requireCompletionBlock) return true;
  return !isTerminalCompletionBlock(study, sectionIndex, trialIndex, blockIndex);
}

function hasFiniteRange(item, { integer = false } = {}) {
  const min = Number(item?.min);
  const max = Number(item?.max);
  return Number.isFinite(min)
    && Number.isFinite(max)
    && min < max
    && (!integer || (Number.isSafeInteger(min) && Number.isSafeInteger(max) && max - min <= 100));
}

function hasUsableBranchLiteral(item) {
  if (!item?.required || !BRANCHABLE_ITEM_TYPES.has(item.type)) return false;
  if (["singleChoice", "multipleChoice"].includes(item.type)) {
    return Array.isArray(item.options) && item.options.some(({ optionId }) => String(optionId ?? "").length > 0);
  }
  if (item.type === "likert") return hasFiniteRange(item, { integer: true });
  if (["vas", "numeric"].includes(item.type)) {
    const step = Number(item.step);
    return hasFiniteRange(item) && Number.isFinite(step) && step > 0 && step <= Number(item.max) - Number(item.min);
  }
  if (item.type === "affect2d") return Number.isFinite(Number(item.step)) && Number(item.step) > 0 && Number(item.step) <= 2;
  return true;
}

export function branchSourceCandidates(study, targetSectionIndex) {
  if (!study || !Array.isArray(study.sections) || !Array.isArray(study.questionnaires)) {
    throw new TypeError("A study with sections and questionnaires is required.");
  }
  if (!Number.isSafeInteger(targetSectionIndex) || targetSectionIndex < 0 || targetSectionIndex >= study.sections.length) {
    throw new RangeError("The target section must identify an existing section.");
  }

  const questionnaires = new Map(study.questionnaires.map((entry) => [entry.questionnaireId, entry]));
  const sources = [];
  for (const section of study.sections.slice(0, targetSectionIndex)) {
    if (section.orderPolicy?.type !== "fixed" || !Array.isArray(section.trials)) continue;
    for (const trial of section.trials) {
      if (trial.runIf || !Array.isArray(trial.blocks)) continue;
      for (const block of trial.blocks) {
        if (block.type !== "questionnaire") continue;
        const questionnaire = questionnaires.get(block.questionnaireId);
        for (const item of questionnaire?.items ?? []) {
          if (hasUsableBranchLiteral(item)) sources.push({ section, trial, questionnaire, block, item });
        }
      }
    }
  }
  return sources;
}

function firstOptionId(item) {
  const optionId = item.options?.find(({ optionId: candidate }) => String(candidate ?? "").length > 0)?.optionId;
  if (!optionId) throw new TypeError(`${item.type} requires at least one usable option.`);
  return optionId;
}

function affectValueNearestNeutral(step) {
  const numericStep = Number(step);
  if (!Number.isFinite(numericStep) || numericStep <= 0) {
    throw new TypeError("Affect branches require a positive finite step.");
  }
  const stepsFromMinimum = Math.round(1 / numericStep);
  return Math.min(1, Math.max(-1, Number((-1 + stepsFromMinimum * numericStep).toPrecision(12))));
}

export function createDefaultRunCondition(source) {
  const { block, item } = source ?? {};
  if (!block?.blockId || !item?.itemId || !hasUsableBranchLiteral(item)) {
    throw new TypeError("A usable required questionnaire answer is required.");
  }
  const common = { questionnaireBlockId: block.blockId, itemId: item.itemId };
  switch (item.type) {
    case "acknowledgement":
      return { operator: "equals", ...common, value: { type: "acknowledgement", acknowledged: true } };
    case "singleChoice":
      return { operator: "equals", ...common, value: { type: "singleChoice", optionId: firstOptionId(item) } };
    case "multipleChoice":
      return { operator: "contains", ...common, optionId: firstOptionId(item) };
    case "likert":
      return { operator: "equals", ...common, value: { type: "likert", value: Number(item.min) } };
    case "vas":
      return { operator: "equals", ...common, value: { type: "vas", value: Number(item.min) } };
    case "numeric":
      return { operator: "equals", ...common, value: { type: "numeric", value: Number(item.min) } };
    case "affect2d": {
      const neutral = affectValueNearestNeutral(item.step);
      return { operator: "equals", ...common, value: { type: "affect2d", valence: neutral, arousal: neutral } };
    }
    default:
      throw new TypeError(`Unsupported branch source type: ${item.type}`);
  }
}

function numberFromControl(value) {
  if (typeof value === "string" && value.trim() === "") throw new TypeError("Expected value cannot be blank.");
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError("Expected value must be finite.");
  return number;
}

function steppedValueFromControl(value, min, max, step) {
  const number = numberFromControl(value);
  const numericMin = Number(min);
  const numericMax = Number(max);
  const numericStep = Number(step);
  const quotient = (number - numericMin) / numericStep;
  const tolerance = 1e-9 * Math.max(1, Math.abs(quotient));
  if (number < numericMin || number > numericMax || Math.abs(quotient - Math.round(quotient)) > tolerance) {
    throw new RangeError("Expected value must be within the question range and on its configured step.");
  }
  return number;
}

function isConfiguredStep(value, min, max, step) {
  try {
    steppedValueFromControl(value, min, max, step);
    return true;
  } catch {
    return false;
  }
}

export function runConditionLiteralIssue(condition, item) {
  if (!condition || !item || condition.itemId !== item.itemId) {
    return "The saved condition no longer identifies this question.";
  }
  if (!item.required) return "The source answer is no longer required.";

  if (item.type === "acknowledgement") {
    return condition.operator === "equals"
      && condition.value?.type === "acknowledgement"
      && condition.value.acknowledged === true
      ? undefined
      : "A required acknowledgement can only match an acknowledged answer.";
  }
  if (item.type === "singleChoice") {
    return condition.operator === "equals"
      && condition.value?.type === "singleChoice"
      && item.options?.some(({ optionId }) => optionId === condition.value.optionId)
      ? undefined
      : "The saved expected choice is no longer available.";
  }
  if (item.type === "multipleChoice") {
    return condition.operator === "contains"
      && item.options?.some(({ optionId }) => optionId === condition.optionId)
      ? undefined
      : "The saved required choice is no longer available.";
  }
  if (item.type === "likert") {
    return condition.operator === "equals"
      && condition.value?.type === "likert"
      && isConfiguredStep(condition.value.value, item.min, item.max, 1)
      ? undefined
      : "The saved Likert value is outside the current scale.";
  }
  if (["vas", "numeric"].includes(item.type)) {
    return condition.operator === "equals"
      && condition.value?.type === item.type
      && isConfiguredStep(condition.value.value, item.min, item.max, item.step)
      ? undefined
      : "The saved expected value is outside the current range or step.";
  }
  if (item.type === "affect2d") {
    return condition.operator === "equals"
      && condition.value?.type === "affect2d"
      && isConfiguredStep(condition.value.valence, -1, 1, item.step)
      && isConfiguredStep(condition.value.arousal, -1, 1, item.step)
      ? undefined
      : "The saved 2D affect value is outside the current response grid.";
  }
  return "The saved answer type is not portable in this study.";
}

export function questionnaireItemBranchIssues(study, questionnaireId, item) {
  if (!item?.itemId) throw new TypeError("A questionnaire item is required.");
  const sourceBlockIds = new Set();
  for (const section of study?.sections ?? []) {
    for (const trial of section.trials ?? []) {
      for (const block of trial.blocks ?? []) {
        if (block.type === "questionnaire" && block.questionnaireId === questionnaireId) {
          sourceBlockIds.add(block.blockId);
        }
      }
    }
  }

  const issues = [];
  for (const section of study?.sections ?? []) {
    for (const trial of section.trials ?? []) {
      const condition = trial.runIf;
      if (!condition
        || condition.itemId !== item.itemId
        || !sourceBlockIds.has(condition.questionnaireBlockId)) continue;
      const issue = runConditionLiteralIssue(condition, item);
      if (issue) issues.push({ section, trial, condition, issue });
    }
  }
  return issues;
}

export function setRunConditionExpectedValue(condition, item, component, controlValue) {
  if (!condition || !item || condition.itemId !== item.itemId) {
    throw new TypeError("The branch condition and questionnaire item must match.");
  }
  switch (item.type) {
    case "singleChoice":
      if (!item.options.some(({ optionId }) => optionId === controlValue)) throw new TypeError("Unknown expected choice.");
      condition.value.optionId = controlValue;
      break;
    case "multipleChoice":
      if (!item.options.some(({ optionId }) => optionId === controlValue)) throw new TypeError("Unknown required choice.");
      condition.optionId = controlValue;
      break;
    case "likert":
      condition.value.value = steppedValueFromControl(controlValue, item.min, item.max, 1);
      break;
    case "vas":
    case "numeric":
      condition.value.value = steppedValueFromControl(controlValue, item.min, item.max, item.step);
      break;
    case "affect2d":
      if (!["valence", "arousal"].includes(component)) throw new TypeError("Affect branches require a valence or arousal component.");
      condition.value[component] = steppedValueFromControl(controlValue, -1, 1, item.step);
      break;
    case "acknowledgement":
      condition.value.acknowledged = true;
      break;
    default:
      throw new TypeError(`Unsupported branch source type: ${item.type}`);
  }
  return condition;
}

export function instructionPreviewCandidates(study) {
  const candidates = [];
  for (const section of study?.sections ?? []) {
    for (const trial of section.trials ?? []) {
      for (const block of trial.blocks ?? []) {
        if (block.type === "instruction") candidates.push({ section, trial, block });
      }
    }
  }
  return candidates;
}

export function preferredInstructionPreview(candidates, selectedBlockId) {
  if (!Array.isArray(candidates)) throw new TypeError("Instruction candidates must be an array.");
  return candidates.find(({ block }) => block.blockId === selectedBlockId)
    ?? candidates.find(({ block }) => block.presentation === "faceFlubberComparison")
    ?? candidates[0];
}
