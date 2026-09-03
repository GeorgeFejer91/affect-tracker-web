import {
  XR_PANEL_LIMITS,
  assertBoundedXrPanel,
  boundedPanelTitle,
  boundedIndex,
  deepFreeze,
  paginatePanelText,
  wrapPanelText,
} from "./panel-layout.js";
import {
  createXrQuestionnaireState,
  projectXrQuestionnaireView,
} from "./questionnaire-controller.js";

export const XR_PANEL_MODEL_SCHEMA = "affect-tracker-study-xr-panel";
export const XR_PANEL_MODEL_VERSION = 1;
export const XR_PANEL_STATE_SCHEMA = "affect-tracker-study-xr-panel-state";
export const XR_PANEL_STATE_VERSION = 1;
export const XR_PORTABLE_PANEL_BLOCK_TYPES = Object.freeze([
  "instruction",
  "questionnaire",
  "break",
  "completion",
]);

const PANEL_PLACEMENT = Object.freeze({
  anchor: "headForward",
  gazeAligned: true,
  distanceMeters: 1.55,
  widthMeters: 1.2,
  heightMeters: 0.72,
});

function assertPanelBlock(block) {
  if (!block || !XR_PORTABLE_PANEL_BLOCK_TYPES.includes(block.type)) {
    throw new TypeError(`Unsupported portable XR panel block: ${block?.type}`);
  }
  if (typeof block.blockId !== "string" || !block.blockId) {
    throw new TypeError("Portable XR panel blocks require a non-empty blockId.");
  }
}

function assertQuestionnaireBinding(block, questionnaire) {
  if (!questionnaire || questionnaire.questionnaireId !== block.questionnaireId) {
    throw new TypeError(`Questionnaire block ${block.blockId} requires definition ${block.questionnaireId}.`);
  }
}

export function createXrPanelState({ block, questionnaire, answers = [] }) {
  assertPanelBlock(block);
  if (block.type === "questionnaire") assertQuestionnaireBinding(block, questionnaire);
  return deepFreeze({
    schema: XR_PANEL_STATE_SCHEMA,
    version: XR_PANEL_STATE_VERSION,
    blockId: block.blockId,
    pageIndex: 0,
    focusId: null,
    questionnaireState: block.type === "questionnaire"
      ? createXrQuestionnaireState(questionnaire, { answers })
      : null,
  });
}

function assertPanelState(block, state) {
  if (state?.schema !== XR_PANEL_STATE_SCHEMA || state?.version !== XR_PANEL_STATE_VERSION) {
    throw new TypeError("Expected an Affect Tracker XR panel state version 1.");
  }
  if (state.blockId !== block.blockId) {
    throw new TypeError("XR panel state belongs to a different portable block.");
  }
}

function captureComparisonSnapshot(snapshot) {
  if (!snapshot || !Number.isFinite(snapshot.currentX) || !Number.isFinite(snapshot.currentY) || !Number.isFinite(snapshot.phase)) {
    throw new TypeError("Face + Flubber presentation requires one finite currentX/currentY/phase snapshot.");
  }
  if (snapshot.currentX < -1 || snapshot.currentX > 1 || snapshot.currentY < -1 || snapshot.currentY > 1) {
    throw new RangeError("Face + Flubber coordinates must already be within [-1, 1].");
  }
  return Object.freeze({
    currentX: snapshot.currentX,
    currentY: snapshot.currentY,
    phase: snapshot.phase,
  });
}

function instructionPresentation(block, affectSnapshot) {
  if (block.presentation === "standard") return { type: "standard" };
  if (block.presentation !== "faceFlubberComparison") {
    throw new TypeError(`Unsupported instruction presentation: ${block.presentation}`);
  }
  const snapshot = captureComparisonSnapshot(affectSnapshot);
  return {
    type: "faceFlubberComparison",
    presentationOnly: true,
    diagnostic: false,
    dataSource: false,
    snapshot,
    face: { snapshot },
    flubber: { snapshot },
  };
}

function genericTitle(block) {
  return {
    instruction: "Instructions",
    break: "Break",
    completion: "Complete",
  }[block.type];
}

function genericForwardLabel(block, finalPage) {
  if (!finalPage) return "Next";
  if (block.type === "completion") return "Finish";
  if (block.type === "break") return "Continue";
  return "Continue";
}

function genericPanel(block, state, { affectSnapshot, elapsedMs = 0 } = {}) {
  const pages = paginatePanelText(block.content);
  const pageIndex = boundedIndex(state.pageIndex, pages.length);
  const finalPage = pageIndex === pages.length - 1;
  const minimumDurationMs = block.type === "break"
    ? Math.max(0, Number.isFinite(block.minimumDurationMs) ? block.minimumDurationMs : 0)
    : 0;
  const observedElapsedMs = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  const remainingMs = Math.max(0, minimumDurationMs - observedElapsedMs);
  const controls = [];
  if (pageIndex > 0) {
    controls.push({
      id: "nav:back",
      kind: "navigation",
      role: "button",
      label: "Back",
      enabled: true,
      row: 20,
      column: 0,
      action: { type: "previousPage" },
    });
  }
  controls.push({
    id: finalPage ? "nav:advance" : "nav:next",
    kind: "navigation",
    role: "button",
    label: genericForwardLabel(block, finalPage),
    enabled: !(block.type === "break" && finalPage && remainingMs > 0),
    row: 20,
    column: 1,
    action: { type: finalPage ? "advanceBlock" : "nextPage" },
  });
  const focusId = controls.some(({ id, enabled }) => id === state.focusId && enabled !== false)
    ? state.focusId
    : controls.find(({ enabled }) => enabled !== false)?.id ?? null;
  return {
    schema: XR_PANEL_MODEL_SCHEMA,
    version: XR_PANEL_MODEL_VERSION,
    surface: "webXr",
    blockId: block.blockId,
    blockType: block.type,
    title: genericTitle(block),
    placement: { ...PANEL_PLACEMENT },
    content: {
      accessibleText: block.content,
      lines: [...pages[pageIndex]],
      pageIndex,
      pageCount: pages.length,
    },
    progress: { pageIndex, pageCount: pages.length },
    controls,
    focusId,
    presentation: block.type === "instruction"
      ? instructionPresentation(block, affectSnapshot)
      : { type: "standard" },
    timing: block.type === "break"
      ? { minimumDurationMs, elapsedMs: observedElapsedMs, remainingMs }
      : null,
    response: null,
  };
}

function questionnairePanel(block, questionnaire, state) {
  assertQuestionnaireBinding(block, questionnaire);
  const view = projectXrQuestionnaireView(questionnaire, state.questionnaireState);
  return {
    schema: XR_PANEL_MODEL_SCHEMA,
    version: XR_PANEL_MODEL_VERSION,
    surface: "webXr",
    blockId: block.blockId,
    blockType: block.type,
    title: view.title,
    placement: { ...PANEL_PLACEMENT },
    content: { ...view.content, lines: [...view.content.lines] },
    progress: {
      itemIndex: view.itemIndex,
      itemCount: view.itemCount,
      pageIndex: view.content.pageIndex,
      pageCount: view.content.pageCount,
      optionPageIndex: view.optionPageIndex,
      optionPageCount: view.optionPageCount,
    },
    controls: view.controls.map((control) => ({
      ...control,
      labelLines: control.labelLines ? [...control.labelLines] : undefined,
      action: { ...control.action },
    })),
    focusId: view.focusId,
    presentation: { type: "standard" },
    timing: null,
    response: {
      questionnaireId: questionnaire.questionnaireId,
      itemId: view.item.itemId,
      questionType: view.item.type,
      required: view.item.required,
      answer: view.answer
        ? {
            ...view.answer,
            ...(view.answer.optionIds ? { optionIds: [...view.answer.optionIds] } : {}),
          }
        : null,
      feedback: view.feedback ? { ...view.feedback } : null,
    },
  };
}

function boundedControl(control) {
  if (!control || typeof control.label !== "string" || !control.label.trim()) {
    throw new TypeError("XR controls require a non-empty label.");
  }
  return {
    ...control,
    labelLines: control.labelLines
      ? [...control.labelLines]
      : [...wrapPanelText(control.label, { columns: XR_PANEL_LIMITS.choiceColumns })],
    action: { ...control.action },
  };
}

function boundVisualSurface(panel) {
  return {
    ...panel,
    title: boundedPanelTitle(panel.title),
    controls: panel.controls.map(boundedControl),
  };
}

export function projectPortableBlockToXrPanel({
  block,
  questionnaire,
  state,
  affectSnapshot,
  elapsedMs = 0,
}) {
  assertPanelBlock(block);
  assertPanelState(block, state);
  const projected = block.type === "questionnaire"
    ? questionnairePanel(block, questionnaire, state)
    : genericPanel(block, state, { affectSnapshot, elapsedMs });
  const panel = boundVisualSurface(projected);
  assertBoundedXrPanel(panel);
  return deepFreeze(panel);
}
