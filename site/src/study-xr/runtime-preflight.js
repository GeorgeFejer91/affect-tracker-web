import { normalizeStickAxis } from "../webxr-study-core.js";
import { deepFreeze } from "./panel-layout.js";
import { evaluateWebXrPreflight } from "./preflight.js";

export const PORTABLE_WEBXR_RUNTIME_PROFILE = "content-asset-media-v1";
export const PORTABLE_WEBXR_RUNNABLE_BLOCK_TYPES = Object.freeze([
  "instruction",
  "video",
  "questionnaire",
  "break",
  "completion",
]);

function studyBlocks(study) {
  const blocks = [];
  for (const section of study?.sections ?? []) {
    for (const trial of section.trials ?? []) blocks.push(...(trial.blocks ?? []));
  }
  return blocks;
}

export function referencedContentAssets(study) {
  const assetById = new Map((study?.media ?? []).map((asset) => [asset.assetId, asset]));
  const referenced = new Map();
  for (const block of studyBlocks(study)) {
    if (block.type !== "video" || block.source?.kind !== "contentAsset") continue;
    const asset = assetById.get(block.source.assetId);
    if (asset) referenced.set(asset.assetId, asset);
  }
  return deepFreeze([...referenced.values()].map((asset) => ({ ...asset })));
}

export function portableStudyRunInputs(study) {
  const policies = (study?.sections ?? []).map((section) => section.orderPolicy);
  const williamsCounts = (study?.sections ?? [])
    .filter((section) => section.orderPolicy?.type === "williamsBalancedLatinSquare")
    .map((section) => section.trials.length % 2 === 0 ? section.trials.length : section.trials.length * 2);
  return deepFreeze({
    needsRandomSeed: policies.some((policy) => policy?.type === "seededShuffle"),
    counterbalanceGroupCount: williamsCounts.length ? Math.min(...williamsCounts) : null,
    needsCalibration: study?.pinnedSettings?.acquisition?.resetPolicy === "requireCalibration",
  });
}

export function evaluatePortableWebXrRuntimePreflight(study, options = {}) {
  const base = evaluateWebXrPreflight(study, options);
  const issues = base.issues.map((issue) => ({ ...issue }));
  return deepFreeze({
    ...base,
    ok: issues.length === 0,
    runtimeProfile: PORTABLE_WEBXR_RUNTIME_PROFILE,
    runnableBlockTypes: [...PORTABLE_WEBXR_RUNNABLE_BLOCK_TYPES],
    issues,
  });
}

function stickAxes(gamepad) {
  const axes = Array.from(gamepad?.axes ?? []);
  if (axes.length >= 4) return { x: normalizeStickAxis(axes[2]), y: normalizeStickAxis(axes[3]) };
  if (axes.length >= 2) return { x: normalizeStickAxis(axes[0]), y: normalizeStickAxis(axes[1]) };
  return { x: 0, y: 0 };
}

export function portableControllerSnapshot(inputSources) {
  const controllers = Array.from(inputSources ?? []).filter((source) => source?.gamepad);
  const right = controllers.find((source) => source.handedness === "right") ?? controllers[0];
  const left = controllers.find((source) => source.handedness === "left");
  return deepFreeze({
    ...stickAxes(right?.gamepad),
    select: Boolean(right?.gamepad?.buttons?.[0]?.pressed),
    back: Boolean(left?.gamepad?.buttons?.[0]?.pressed),
    hand: right?.handedness || "unknown",
    controllerPresent: Boolean(right),
  });
}
