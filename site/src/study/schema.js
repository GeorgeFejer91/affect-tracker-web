export const STUDY_SCHEMA = "affect-tracker-study";
export const STUDY_VERSION = 1;
export const DEFAULT_SETTINGS_SHA256 = "0".repeat(64);

export const PORTABLE_QUESTION_TYPES = Object.freeze([
  "acknowledgement",
  "singleChoice",
  "multipleChoice",
  "likert",
  "vas",
  "numeric",
  "affect2d",
]);

export const PORTABLE_BLOCK_TYPES = Object.freeze([
  "instruction",
  "video",
  "questionnaire",
  "break",
  "completion",
]);

const QUESTION_TYPE_LABELS = Object.freeze({
  acknowledgement: "Acknowledgement",
  singleChoice: "Single choice",
  multipleChoice: "Multiple choice",
  likert: "Likert scale",
  vas: "VAS / slider",
  numeric: "Numeric",
  affect2d: "2D affect response",
});

const BLOCK_TYPE_LABELS = Object.freeze({
  instruction: "Instruction",
  video: "Video",
  questionnaire: "Questionnaire",
  break: "Break",
  completion: "Completion",
});

export function portableQuestionTypeLabel(type) {
  const label = QUESTION_TYPE_LABELS[type];
  if (!label) throw new TypeError(`Unsupported questionnaire item type: ${type}`);
  return label;
}

export function portableBlockTypeLabel(type) {
  const label = BLOCK_TYPE_LABELS[type];
  if (!label) throw new TypeError(`Unsupported study block type: ${type}`);
  return label;
}

const DEFAULT_PALETTE = Object.freeze({
  up: "#f2c94c",
  down: "#2f80ed",
  left: "#eb5757",
  right: "#27ae60",
});

function safeIdentifierPart(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function studyIdentifier(label = "study", randomUuid = () => globalThis.crypto?.randomUUID?.()) {
  const prefix = safeIdentifierPart(label) || "study";
  const generated = randomUuid?.();
  if (generated) return `${prefix}-${String(generated).toLowerCase()}`;
  return `${prefix}-${Date.now().toString(36)}`;
}

export function createDefaultStudy({
  studyId = studyIdentifier("study"),
  title = "Untitled affect study",
} = {}) {
  return {
    schema: STUDY_SCHEMA,
    version: STUDY_VERSION,
    studyId,
    revision: 1,
    title,
    description: "",
    pinnedSettings: {
      portableSettingsSha256: DEFAULT_SETTINGS_SHA256,
      acquisition: {
        sampleRateHz: 20,
        resetPolicy: "neutralAtRunStart",
      },
      visual: {
        baseShape: "circle",
        palette: { ...DEFAULT_PALETTE },
        animationSpeedMultiplier: 1,
        pulseAmplitudeMultiplier: 1,
        disorderMultiplier: 1,
        opacity: 1,
        widgetScale: 1,
      },
    },
    // Block- and asset-specific capabilities are derived by the shared core so
    // deleting a presentation or questionnaire cannot leave stale demands.
    requiredCapabilities: ["affectInput", "durableJournal"],
    media: [],
    questionnaires: [
      {
        questionnaireId: "pre-run",
        title: "Before the study",
        description: "",
        items: [
          {
            type: "acknowledgement",
            itemId: "ready",
            prompt: "I have read the instructions and am ready to begin.",
            required: true,
          },
        ],
      },
    ],
    sections: [
      {
        sectionId: "onboarding",
        title: "Onboarding",
        orderPolicy: { type: "fixed" },
        trials: [
          {
            trialId: "onboarding-main",
            label: "Instructions and pre-study questionnaire",
            blocks: [
              {
                type: "instruction",
                blockId: "instructions",
                content: "Use the affect controls to report your current valence and arousal.",
                presentation: "faceFlubberComparison",
              },
              {
                type: "questionnaire",
                blockId: "pre-run-questionnaire",
                questionnaireId: "pre-run",
              },
            ],
          },
        ],
      },
      {
        sectionId: "main",
        title: "Main sequence",
        orderPolicy: { type: "fixed" },
        trials: [
          {
            trialId: "main-trial-1",
            label: "Trial group 1",
            blocks: [
              {
                type: "instruction",
                blockId: "main-instructions",
                content: "The main part of the study is about to begin.",
                presentation: "standard",
              },
            ],
          },
        ],
      },
      {
        sectionId: "finish",
        title: "Completion",
        orderPolicy: { type: "fixed" },
        trials: [
          {
            trialId: "finish-main",
            label: "Completion",
            blocks: [
              {
                type: "completion",
                blockId: "completion",
                content: "This study is complete. Thank you.",
              },
            ],
          },
        ],
      },
    ],
    completionPolicy: {
      allowEarlyStop: true,
      requireCompletionBlock: true,
    },
  };
}

export function createBlock(type, id, { questionnaireId, assetId } = {}) {
  const blockId = safeIdentifierPart(id) || `${type}-${Date.now().toString(36)}`;
  switch (type) {
    case "instruction":
      return { type, blockId, content: "Instructions", presentation: "standard" };
    case "video":
      return {
        type,
        blockId,
        purpose: "stimulus",
        source: { kind: "contentAsset", assetId: assetId || "select-an-asset" },
        collectAffect: true,
      };
    case "questionnaire":
      return { type, blockId, questionnaireId: questionnaireId || "select-a-questionnaire" };
    case "break":
      return { type, blockId, content: "You may take a short break.", minimumDurationMs: 0 };
    case "completion":
      return { type, blockId, content: "This study is complete. Thank you." };
    default:
      throw new TypeError(`Unsupported study block type: ${type}`);
  }
}

export function createQuestionnaireItem(type, itemId) {
  const id = safeIdentifierPart(itemId) || `${type}-${Date.now().toString(36)}`;
  const common = { type, itemId: id, prompt: "Question", required: true };
  switch (type) {
    case "acknowledgement":
      return common;
    case "singleChoice":
      return { ...common, options: [{ optionId: "yes", label: "Yes" }, { optionId: "no", label: "No" }] };
    case "multipleChoice":
      return {
        ...common,
        minSelections: 1,
        maxSelections: 2,
        options: [{ optionId: "option-1", label: "Option 1" }, { optionId: "option-2", label: "Option 2" }],
      };
    case "likert":
      return { ...common, min: 1, max: 5, minLabel: "Strongly disagree", maxLabel: "Strongly agree" };
    case "vas":
      return { ...common, min: 0, max: 100, step: 1, minLabel: "Not at all", maxLabel: "Extremely" };
    case "numeric":
      return { ...common, min: 0, max: 100, step: 1 };
    case "affect2d":
      return { ...common, step: 0.1 };
    default:
      throw new TypeError(`Unsupported questionnaire item type: ${type}`);
  }
}

export function declaredCompatibility(study) {
  let universal = true;
  let youtube = false;
  let immersive = true;
  for (const section of study.sections ?? []) {
    for (const trial of section.trials ?? []) {
      for (const block of trial.blocks ?? []) {
        if (block.type === "video" && block.source?.kind === "youtube") {
          youtube = true;
          universal = false;
          immersive = false;
        }
      }
    }
  }
  return Object.freeze({
    universal,
    desktop: !youtube,
    pages2d: true,
    webXr: immersive,
    badge: universal ? "Universal v1" : "Pages 2D only",
  });
}

export function cloneStudy(study) {
  return globalThis.structuredClone
    ? globalThis.structuredClone(study)
    : JSON.parse(JSON.stringify(study));
}
