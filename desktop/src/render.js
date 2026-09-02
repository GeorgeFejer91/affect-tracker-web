import { buildFlubberPath, createProfiles, createProjectionOffsets } from "../../site/src/math.js";
import { createFaceRenderer } from "../../site/src/face.js";
import { createFace3dRenderer } from "../../site/src/face-3d.js";

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

export function createSynchronizedAffectRenderer(root) {
  const faceRoot = root.querySelector(".face-preview");
  const renderFaceFallback = createFaceRenderer(faceRoot.querySelector("[data-face-3d-fallback]"));
  const renderFace = createFace3dRenderer(faceRoot, { fallbackRenderer: renderFaceFallback });
  const renderFlubber = createFlubberRenderer(root.querySelector(".flubber-preview"));

  return (snapshot, reducedMotion = false) => {
    const flubber = renderFlubber(snapshot, reducedMotion);
    const face = renderFace(snapshot, reducedMotion, flubber.color);
    root.dataset.face3dMode = renderFace.mode;
    root.dataset.renderSequence = String(snapshot.sequence ?? "");
    root.setAttribute(
      "aria-label",
      `Procedural affect display: valence ${snapshot.currentX.toFixed(3)}, arousal ${snapshot.currentY.toFixed(3)}; face left, Flubber right.`,
    );
    return Object.freeze({ face, flubber, sequence: snapshot.sequence });
  };
}
