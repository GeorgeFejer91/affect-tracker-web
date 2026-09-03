import { createFaceRenderer } from "./face.js";
import { createFacePhotoRenderer } from "./face-photo.js?v=dense21-warp-packs-1";
import { createFaceModelRenderer } from "./face-model.js?v=matrix21-1-friendly-eyes-1";

const mode = (id, label, shortLabel, description, kind, profile = null) => Object.freeze({
  id,
  label,
  shortLabel,
  description,
  kind,
  profile,
});

export const FACE_ENGINE_MODES = Object.freeze([
  mode(
    "affec-empirical",
    "AFFEC empirical 3D",
    "AFFEC empirical 3D",
    "Uses all 5,807 valid perceived valence/arousal trials in AFFEC to place six expression prototypes, then blends the local CC0 morph face continuously.",
    "model",
    "affec-empirical",
  ),
  mode(
    "mediapipe-atlas",
    "MediaPipe-rigged atlas 3D",
    "MediaPipe-rigged 3D",
    "Uses build-time scores from MediaPipe's 52-blendshape model on nine project-owned photoreal anchors; no camera or recognition model runs in the app.",
    "model",
    "mediapipe-atlas",
  ),
  mode(
    "facs-continuous",
    "Continuous FACS-style 3D",
    "Continuous 3D",
    "Maps valence and arousal directly to smooth, project-authored morph equations without snapping to cells.",
    "model",
    "facs-continuous",
  ),
  mode(
    "matrix-anchors",
    "21 × 21 matrix-anchor 3D",
    "21 × 21 matrix 3D",
    "Uses a compact 441-state face cache at exact 0.1 nodes. Select the 21 × 21 affect transition to move face and Flubber together along shortest diagonal paths.",
    "model",
    "matrix-anchors",
  ),
  mode(
    "photo-atlas",
    "Photoreal atlas blend",
    "Photoreal atlas",
    "Blends the four nearest cells of a project-owned 21 × 21 landmark-warped atlas for dense, continuous photoreal transitions without runtime machine learning.",
    "photo",
  ),
]);

export const DEFAULT_FACE_ENGINE_MODE = "affec-empirical";

const MODE_BY_ID = new Map(FACE_ENGINE_MODES.map((entry) => [entry.id, entry]));

export function normalizeFaceEngineMode(value) {
  return MODE_BY_ID.has(value) ? value : DEFAULT_FACE_ENGINE_MODE;
}

export function faceEngineDefinition(value) {
  return MODE_BY_ID.get(normalizeFaceEngineMode(value));
}

export function resolveFaceEffectiveMode(result) {
  if (result?.mode === "model") return "model";
  if (result?.mode === "photo") return "photo";
  if (result?.mode === "fallback") return resolveFaceEffectiveMode(result.result);
  return "vector";
}

function findNodes(root) {
  return Object.freeze({
    model: root?.querySelector?.("canvas[data-face-model]") ?? null,
    photo: root?.querySelector?.("canvas[data-face-photo]") ?? null,
    vector: root?.querySelector?.("[data-face-3d-fallback]") ?? null,
  });
}

function setNodeVisible(node, visible) {
  if (!node) return;
  if ("hidden" in node) node.hidden = !visible;
  if (node.style) node.style.visibility = visible ? "" : "hidden";
  node.setAttribute?.("aria-hidden", String(!visible));
}

/**
 * Coordinate the five selectable strategies and the fixed local fallback chain:
 * detailed 3D -> photoreal atlas -> canonical SVG.
 */
export function createFaceEngineRenderer(root, options = {}) {
  const nodes = findNodes(root);
  const vectorRenderer = options.vectorRenderer
    ?? createFaceRenderer(nodes.vector);
  let selectedMode = normalizeFaceEngineMode(options.mode);
  let effectiveMode = "vector";
  let lastResult = null;
  let destroyed = false;
  let photoRenderer;
  let modelRenderer;

  const inspectEffectiveMode = () => {
    const definition = faceEngineDefinition(selectedMode);
    if (definition.kind === "photo") {
      return photoRenderer?.mode === "photo" ? "photo" : "vector";
    }
    if (modelRenderer?.mode === "model") return "model";
    if (photoRenderer?.mode === "photo") return "photo";
    return "vector";
  };

  const updatePresentation = () => {
    const nextEffective = destroyed ? "vector" : inspectEffectiveMode();
    effectiveMode = nextEffective;
    setNodeVisible(nodes.model, nextEffective === "model");
    setNodeVisible(nodes.photo, nextEffective === "photo");
    setNodeVisible(nodes.vector, nextEffective === "vector");
    if (root?.dataset) {
      root.dataset.faceEngine = selectedMode;
      root.dataset.faceEffectiveMode = nextEffective;
    }
    options.onModeChange?.(selectedMode, nextEffective);
  };

  const childModeChanged = () => updatePresentation();
  photoRenderer = options.photoRenderer ?? createFacePhotoRenderer(root, {
    atlasUrl: options.photoAtlasUrl,
    fallbackRenderer: vectorRenderer,
    onModeChange: childModeChanged,
  });
  modelRenderer = options.modelRenderer ?? createFaceModelRenderer(root, {
    fallbackRenderer: photoRenderer,
    profile: faceEngineDefinition(selectedMode).profile ?? undefined,
    onModeChange: childModeChanged,
  });

  const render = (snapshot, reducedMotion = false, presentationColor) => {
    if (destroyed) {
      const result = vectorRenderer(snapshot, reducedMotion, presentationColor);
      updatePresentation();
      return Object.freeze({ mode: selectedMode, effectiveMode: "vector", result });
    }
    const definition = faceEngineDefinition(selectedMode);
    if (definition.kind === "photo") {
      lastResult = photoRenderer(snapshot, reducedMotion, presentationColor);
    } else {
      if (modelRenderer.profile !== definition.profile) modelRenderer.setProfile(definition.profile);
      lastResult = modelRenderer(snapshot, reducedMotion, presentationColor);
    }
    effectiveMode = resolveFaceEffectiveMode(lastResult);
    updatePresentation();
    return Object.freeze({
      mode: selectedMode,
      effectiveMode,
      profile: definition.profile,
      result: lastResult,
    });
  };

  render.setMode = (value) => {
    const nextMode = normalizeFaceEngineMode(value);
    selectedMode = nextMode;
    const definition = faceEngineDefinition(nextMode);
    if (definition.profile && modelRenderer.profile !== definition.profile) {
      modelRenderer.setProfile(definition.profile);
    }
    updatePresentation();
    return selectedMode;
  };
  render.setPhotoAtlasUrl = (value) => {
    const atlasUrl = photoRenderer.setAtlasUrl?.(value) ?? photoRenderer.atlasUrl;
    updatePresentation();
    return atlasUrl;
  };
  render.resize = () => {
    modelRenderer.resize?.();
    photoRenderer.resize?.();
  };
  render.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    modelRenderer.destroy?.();
    photoRenderer.destroy?.();
    updatePresentation();
  };
  Object.defineProperties(render, {
    mode: { enumerable: true, get: () => selectedMode },
    definition: { enumerable: true, get: () => faceEngineDefinition(selectedMode) },
    effectiveMode: { enumerable: true, get: () => effectiveMode },
    lastError: {
      enumerable: true,
      get: () => modelRenderer.lastError ?? photoRenderer.lastError ?? null,
    },
    modelRenderer: { enumerable: true, value: modelRenderer },
    photoRenderer: { enumerable: true, value: photoRenderer },
    photoAtlasUrl: { enumerable: true, get: () => photoRenderer.atlasUrl },
  });

  updatePresentation();
  return render;
}
