import { buildFlubberPath, createProfiles, createProjectionOffsets } from "../../site/src/math.js";
import {
  createFaceEngineRenderer,
  faceEngineDefinition,
  normalizeFaceEngineMode,
} from "../../site/src/face-engines.js";

const profiles = createProfiles();

export function createFlubberRenderer(root) {
  const paths = [...root.querySelectorAll(".shape-halo, .shape-base, .shape-outline")];
  let seed = "affect-tracker";
  let offsets = createProjectionOffsets(seed, profiles.waveCount);

  return (snapshot, reducedMotion = false) => {
    if (snapshot.sessionId && snapshot.sessionId !== seed) {
      seed = snapshot.sessionId;
      offsets = createProjectionOffsets(seed, profiles.waveCount);
    }
    const rendered = buildFlubberPath({
      profiles,
      offsets,
      x: snapshot.currentX,
      y: snapshot.currentY,
      phase: snapshot.phase,
      palette: snapshot.palette,
      amplitudeScale: snapshot.amplitudeScale,
      disorderScale: snapshot.disorderScale,
      baseShape: snapshot.baseShape,
      reducedMotion,
    });
    for (const path of paths) path.setAttribute("d", rendered.path);
    root.style.setProperty("--affect-color", rendered.color);
    const svg = paths[0]?.ownerSVGElement;
    if (svg) svg.style.opacity = String(snapshot.overlayOpacity ?? 1);
    return rendered;
  };
}

export function createSynchronizedAffectRenderer(root, options = {}) {
  const faceRoot = root.querySelector(".face-preview");
  const renderFace = createFaceEngineRenderer(faceRoot, {
    mode: normalizeFaceEngineMode(options.faceMode),
    photoAtlasUrl: options.photoAtlasUrl,
    onModeChange: options.onFaceModeChange,
  });
  const renderFlubber = createFlubberRenderer(root.querySelector(".flubber-preview"));

  const render = (snapshot, reducedMotion = false) => {
    const flubber = renderFlubber(snapshot, reducedMotion);
    const face = renderFace(snapshot, reducedMotion, flubber.color);
    root.dataset.face3dMode = face.effectiveMode;
    root.dataset.faceEngine = face.mode;
    root.dataset.renderSequence = String(snapshot.sequence ?? "");
    const definition = faceEngineDefinition(face.mode);
    root.setAttribute(
      "aria-label",
      `${definition.label} affect display: valence ${snapshot.currentX.toFixed(3)}, arousal ${snapshot.currentY.toFixed(3)}; face left, Flubber right.`,
    );
    return Object.freeze({ face, flubber, sequence: snapshot.sequence });
  };
  render.setFaceMode = (mode) => renderFace.setMode(mode);
  render.setPhotoAtlasUrl = (value) => renderFace.setPhotoAtlasUrl(value);
  Object.defineProperties(render, {
    faceMode: { enumerable: true, get: () => renderFace.mode },
    faceEffectiveMode: { enumerable: true, get: () => renderFace.effectiveMode },
    photoAtlasUrl: { enumerable: true, get: () => renderFace.photoAtlasUrl },
  });
  return render;
}
