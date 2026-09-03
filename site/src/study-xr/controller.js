import { deepFreeze } from "./panel-layout.js";
import { movePanelFocus } from "./controller-navigation.js";
import {
  createXrPanelState,
  projectPortableBlockToXrPanel,
} from "./panel-model.js";
import { reduceXrQuestionnaireController } from "./questionnaire-controller.js";

export { controllerIntentFromSnapshot } from "./controller-navigation.js";
export { createXrPanelState } from "./panel-model.js";

function unchanged(state) {
  return deepFreeze({ state, effect: null });
}

function advanceEffect(blockId) {
  return {
    type: "studyCommand",
    blockId,
    command: { type: "advance" },
  };
}

function applyGenericAction(block, state, action) {
  if (action.type === "previousPage") {
    return { state: { ...state, pageIndex: Math.max(0, state.pageIndex - 1), focusId: null }, effect: null };
  }
  if (action.type === "nextPage") {
    return { state: { ...state, pageIndex: state.pageIndex + 1, focusId: null }, effect: null };
  }
  if (action.type === "advanceBlock") {
    return { state, effect: advanceEffect(block.blockId) };
  }
  throw new TypeError(`Unsupported XR panel action: ${action.type}`);
}

function genericController(context, state, intent) {
  const panel = projectPortableBlockToXrPanel({ ...context, state });
  if (intent?.type === "navigate") {
    return {
      state: { ...state, focusId: movePanelFocus(panel.controls, panel.focusId, intent.direction) },
      effect: null,
    };
  }
  if (intent?.type === "back") {
    const action = panel.controls.find(({ action }) => action.type === "previousPage")?.action;
    return action ? applyGenericAction(context.block, state, action) : { state, effect: null };
  }
  if (intent?.type === "next") {
    const control = panel.controls.find(({ action }) => ["nextPage", "advanceBlock"].includes(action.type));
    return control?.enabled === false || !control
      ? { state, effect: null }
      : applyGenericAction(context.block, state, control.action);
  }
  if (intent?.type === "activate") {
    const control = panel.controls.find(({ id }) => id === panel.focusId);
    return !control || control.enabled === false
      ? { state, effect: null }
      : applyGenericAction(context.block, state, control.action);
  }
  throw new TypeError(`Unsupported XR panel controller intent: ${intent?.type}`);
}

export function reduceXrPanelController({
  block,
  questionnaire,
  state,
  intent,
  affectSnapshot,
  elapsedMs = 0,
}) {
  if (!state) state = createXrPanelState({ block, questionnaire });
  if (block.type === "questionnaire") {
    const reduced = reduceXrQuestionnaireController(questionnaire, state.questionnaireState, intent);
    const nextState = reduced.state === state.questionnaireState
      ? state
      : { ...state, questionnaireState: reduced.state };
    const effect = reduced.effect ? { ...reduced.effect, blockId: block.blockId } : null;
    return deepFreeze({ state: nextState, effect });
  }
  const result = genericController(
    { block, questionnaire, affectSnapshot, elapsedMs },
    state,
    intent,
  );
  return result.state === state && !result.effect
    ? unchanged(state)
    : deepFreeze(result);
}
