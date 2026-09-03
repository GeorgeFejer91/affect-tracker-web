import {
  boundedPanelTitle,
  deepFreeze,
  paginateChoiceOptions,
  paginatePanelText,
} from "./panel-layout.js";
import { XR_PORTABLE_QUESTION_TYPES } from "./questionnaire-controller.js";

export const WEBXR_PREFLIGHT_SCHEMA = "affect-tracker-study-xr-preflight";
export const WEBXR_PREFLIGHT_VERSION = 1;
export const XR_PANEL_ADAPTER_CAPABILITIES = Object.freeze([
  "questionnaires",
  "faceFlubberComparison",
  "immersivePanels",
]);

const PROJECTION_CAPABILITY = Object.freeze({
  flat: "flatVideo",
  equirectangular180: "equirectangular180",
  equirectangular360: "equirectangular360",
});

const STEREO_CAPABILITY = Object.freeze({
  mono: null,
  sideBySideLeftRight: "sideBySideStereo",
  topBottom: "topBottomStereo",
});

function capabilitySet(value) {
  if (value instanceof Set) return new Set(value);
  if (Array.isArray(value)) return new Set(value);
  if (value && typeof value === "object") {
    return new Set(Object.entries(value).filter(([, enabled]) => enabled === true).map(([name]) => name));
  }
  return new Set();
}

function verifiedSet(value) {
  if (value instanceof Set) return new Set(value);
  if (Array.isArray(value)) return new Set(value);
  if (value instanceof Map) {
    return new Set([...value.entries()]
      .filter(([, binding]) => binding === true || binding?.verified === true)
      .map(([assetId]) => assetId));
  }
  if (value && typeof value === "object") {
    return new Set(Object.entries(value)
      .filter(([, binding]) => binding === true || binding?.verified === true)
      .map(([assetId]) => assetId));
  }
  return new Set();
}

function optionalStringSet(value, label) {
  if (value === null || value === undefined) return null;
  const set = value instanceof Set ? new Set(value) : Array.isArray(value) ? new Set(value) : null;
  if (!set || [...set].some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new TypeError(`${label} must be null or a collection of non-empty strings.`);
  }
  return new Set([...set].map((entry) => entry.trim().toLowerCase()));
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function evaluateWebXrPreflight(study, {
  availableCapabilities = [],
  verifiedAssetIds = [],
  requireVerifiedAssets = true,
  supportedMimeTypes = null,
} = {}) {
  const available = capabilitySet(availableCapabilities);
  const verified = verifiedSet(verifiedAssetIds);
  const supportedMedia = optionalStringSet(supportedMimeTypes, "supportedMimeTypes");
  const required = new Set(study?.requiredCapabilities ?? []);
  const issues = [];
  const issueKeys = new Set();
  const addIssue = (code, path, message, details = {}) => {
    const key = `${code}\u0000${path}\u0000${details.capability ?? details.assetId ?? ""}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push({ code, path, message, ...details });
  };
  const requireCapability = (capability, path) => {
    if (!capability) return;
    required.add(capability);
    if (!available.has(capability)) {
      addIssue(
        "missingCapability",
        path,
        `The observed WebXR runtime does not provide ${capability}.`,
        { capability },
      );
    }
  };

  if (study?.schema !== "affect-tracker-study" || study?.version !== 1) {
    addIssue("invalidStudyContract", "study", "Expected StudyDefinitionV1 before WebXR preflight.");
  }
  requireCapability("durableJournal", "runtime.storage");
  for (const capability of study?.requiredCapabilities ?? []) {
    requireCapability(capability, "study.requiredCapabilities");
  }

  const questionnaires = new Map((study?.questionnaires ?? []).map((definition) => [definition.questionnaireId, definition]));
  const assets = new Map((study?.media ?? []).map((asset) => [asset.assetId, asset]));
  for (const [sectionIndex, section] of (study?.sections ?? []).entries()) {
    for (const [trialIndex, trial] of (section.trials ?? []).entries()) {
      for (const [blockIndex, block] of (trial.blocks ?? []).entries()) {
        const path = `study.sections[${sectionIndex}].trials[${trialIndex}].blocks[${blockIndex}]`;
        if (["instruction", "questionnaire", "break", "completion"].includes(block.type)) {
          requireCapability("immersivePanels", `${path}.type`);
          requireCapability("controllerInput", `${path}.type`);
        }
        if (block.type === "instruction") {
          try { paginatePanelText(block.content); } catch (error) {
            addIssue("panelProjection", `${path}.content`, error.message);
          }
          if (block.presentation === "faceFlubberComparison") {
            requireCapability("faceFlubberComparison", `${path}.presentation`);
          } else if (block.presentation !== "standard") {
            addIssue("unsupportedPresentation", `${path}.presentation`, `Unsupported instruction presentation ${block.presentation}.`);
          }
          continue;
        }
        if (block.type === "break" || block.type === "completion") {
          try { paginatePanelText(block.content); } catch (error) {
            addIssue("panelProjection", `${path}.content`, error.message);
          }
          continue;
        }
        if (block.type === "questionnaire") {
          requireCapability("questionnaires", `${path}.type`);
          const questionnaire = questionnaires.get(block.questionnaireId);
          if (!questionnaire) {
            addIssue("missingQuestionnaire", `${path}.questionnaireId`, `Questionnaire ${block.questionnaireId} was not found.`);
            continue;
          }
          try { boundedPanelTitle(questionnaire.title); } catch (error) {
            addIssue("panelProjection", `study.questionnaires[${block.questionnaireId}].title`, error.message);
          }
          for (const [itemIndex, item] of (questionnaire.items ?? []).entries()) {
            const itemPath = `study.questionnaires[${block.questionnaireId}].items[${itemIndex}]`;
            if (!XR_PORTABLE_QUESTION_TYPES.includes(item.type)) {
              addIssue("unsupportedQuestionType", `${itemPath}.type`, `Unsupported WebXR question type ${item.type}.`);
              continue;
            }
            try {
              paginatePanelText(itemIndex === 0 && questionnaire.description
                ? `${questionnaire.description}\n\n${item.prompt}`
                : item.prompt);
              if (["singleChoice", "multipleChoice"].includes(item.type)) paginateChoiceOptions(item.options);
            } catch (error) {
              addIssue("panelProjection", itemPath, error.message);
            }
          }
          continue;
        }
        if (block.type === "video") {
          if (block.source?.kind === "youtube") {
            addIssue(
              "youtubePagesOnly",
              `${path}.source.kind`,
              "YouTube is a Pages 2D-only capability and cannot run in the portable WebXR profile.",
            );
            continue;
          }
          if (block.source?.kind !== "contentAsset") {
            addIssue("unsupportedMediaSource", `${path}.source`, "WebXR requires a content-addressed media source.");
            continue;
          }
          requireCapability("contentAddressedMedia", `${path}.source.kind`);
          if (block.collectAffect === true) requireCapability("affectInput", `${path}.collectAffect`);
          const asset = assets.get(block.source.assetId);
          if (!asset) {
            addIssue("missingAsset", `${path}.source.assetId`, `Asset ${block.source.assetId} was not found.`, { assetId: block.source.assetId });
            continue;
          }
          const projection = PROJECTION_CAPABILITY[asset.projection];
          if (!projection) {
            addIssue("unsupportedProjection", `study.media[${asset.assetId}].projection`, `Unsupported projection ${asset.projection}.`, { assetId: asset.assetId });
          } else requireCapability(projection, `study.media[${asset.assetId}].projection`);
          const stereo = STEREO_CAPABILITY[asset.stereoLayout];
          if (stereo === undefined) {
            addIssue("unsupportedStereoLayout", `study.media[${asset.assetId}].stereoLayout`, `Unsupported stereo layout ${asset.stereoLayout}.`, { assetId: asset.assetId });
          } else requireCapability(stereo, `study.media[${asset.assetId}].stereoLayout`);
          for (const capability of asset.requiredCapabilities ?? []) {
            requireCapability(capability, `study.media[${asset.assetId}].requiredCapabilities`);
          }
          const mimeType = typeof asset.mimeType === "string" ? asset.mimeType.trim().toLowerCase() : "";
          if (!mimeType) {
            addIssue(
              "missingMimeType",
              `study.media[${asset.assetId}].mimeType`,
              `Asset ${asset.assetId} does not declare a MIME type.`,
              { assetId: asset.assetId },
            );
          } else if (supportedMedia === null) {
            addIssue(
              "mediaSupportUnverified",
              `study.media[${asset.assetId}].mimeType`,
              `Playback support for ${asset.mimeType} has not been observed in this WebXR runtime.`,
              { assetId: asset.assetId, mimeType: asset.mimeType },
            );
          } else if (!supportedMedia.has(mimeType)) {
            addIssue(
              "unsupportedMimeType",
              `study.media[${asset.assetId}].mimeType`,
              `The observed WebXR runtime cannot play ${asset.mimeType}.`,
              { assetId: asset.assetId, mimeType: asset.mimeType },
            );
          }
          if (requireVerifiedAssets && !verified.has(asset.assetId)) {
            addIssue(
              "assetNotVerified",
              `${path}.source.assetId`,
              `Asset ${asset.assetId} has not been hash-verified for this run.`,
              { assetId: asset.assetId },
            );
          }
          continue;
        }
        addIssue("unsupportedBlock", `${path}.type`, `Unsupported portable block type ${block.type}.`);
      }
    }
  }

  return deepFreeze({
    schema: WEBXR_PREFLIGHT_SCHEMA,
    version: WEBXR_PREFLIGHT_VERSION,
    surface: "webXr",
    ok: issues.length === 0,
    qualification: "logicalPreflightOnly",
    physicalQuestQualified: false,
    requiredCapabilities: sorted(required),
    availableCapabilities: sorted(available),
    verifiedAssetIds: sorted(verified),
    supportedMimeTypes: supportedMedia === null ? null : sorted(supportedMedia),
    issues,
  });
}
