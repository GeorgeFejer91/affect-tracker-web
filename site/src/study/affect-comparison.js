import {
  affectPaletteColor,
  buildFlubberPath,
  createProfiles,
  createProjectionOffsets,
} from "../math.js";
import { createFaceRenderer } from "../face.js";

const profiles = createProfiles();

export function comparisonFrame({
  currentX = 0,
  currentY = 0,
  phase = 0,
  sequence = 0,
  palette,
  baseShape = "circle",
  amplitudeScale = 1,
  disorderScale = 1,
  overlayOpacity = 1,
  sessionId = "study-instruction",
} = {}) {
  return Object.freeze({
    currentX: Math.max(-1, Math.min(1, Number(currentX) || 0)),
    currentY: Math.max(-1, Math.min(1, Number(currentY) || 0)),
    phase: Number.isFinite(phase) ? phase : 0,
    sequence,
    palette,
    baseShape,
    amplitudeScale,
    disorderScale,
    overlayOpacity,
    sessionId,
  });
}

function comparisonMarkup() {
  return `
    <div class="study-affect-comparison" role="img" aria-label="Synchronized Face and Flubber at neutral affect.">
      <figure>
        <div class="face-preview" aria-hidden="true">
          <svg viewBox="-1.1 -1.1 2.2 2.2">
            <circle class="face-halo" cx="0" cy="0" r="0.91"></circle>
            <circle class="face-head" cx="0" cy="0" r="0.82"></circle>
            <path class="face-brow face-brow-left"></path>
            <path class="face-brow face-brow-right"></path>
            <ellipse class="face-eye face-eye-left" cx="-0.34" cy="-0.13" rx="0.12" ry="0.0775"></ellipse>
            <ellipse class="face-eye face-eye-right" cx="0.34" cy="-0.13" rx="0.12" ry="0.0775"></ellipse>
            <circle class="face-pupil" cx="-0.34" cy="-0.13" r="0.035"></circle>
            <circle class="face-pupil" cx="0.34" cy="-0.13" r="0.035"></circle>
            <path class="face-nose" d="M 0 -0.03 L -0.045 0.19 L 0.055 0.19"></path>
            <path class="face-mouth" d="M -0.42 0.36 Q 0 0.36 0.42 0.36 Q 0 0.36 -0.42 0.36 Z"></path>
          </svg>
        </div>
        <figcaption>Face</figcaption>
      </figure>
      <figure>
        <div class="flubber-preview" aria-hidden="true">
          <svg viewBox="-1.62 -1.62 3.24 3.24">
            <path class="shape-halo"></path>
            <path class="shape-base"></path>
            <path class="shape-outline"></path>
          </svg>
        </div>
        <figcaption>Flubber</figcaption>
      </figure>
    </div>`;
}

export function createInstructionAffectComparison(root, {
  seed = "study-instruction",
  reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false,
} = {}) {
  root.insertAdjacentHTML("beforeend", comparisonMarkup());
  const container = root.querySelector(".study-affect-comparison:last-child");
  const faceRoot = container.querySelector(".face-preview");
  const flubberRoot = container.querySelector(".flubber-preview");
  const renderFace = createFaceRenderer(faceRoot);
  const flubberPaths = [...flubberRoot.querySelectorAll("path")];
  const offsets = createProjectionOffsets(seed, profiles.waveCount);

  function render(input) {
    const snapshot = comparisonFrame({ ...input, sessionId: seed });
    const flubber = buildFlubberPath({
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
    for (const path of flubberPaths) path.setAttribute("d", flubber.path);
    flubberRoot.style.setProperty("--affect-color", flubber.color);
    flubberRoot.querySelector("svg").style.opacity = String(snapshot.overlayOpacity);
    renderFace(snapshot, reducedMotion, flubber.color || affectPaletteColor(snapshot.currentX, snapshot.currentY, snapshot.palette));
    container.dataset.renderSequence = String(snapshot.sequence);
    container.setAttribute(
      "aria-label",
      `Synchronized Face and Flubber: valence ${snapshot.currentX.toFixed(3)}, arousal ${snapshot.currentY.toFixed(3)}.`,
    );
    return Object.freeze({ snapshot, faceAndFlubberPhase: snapshot.phase, flubber });
  }

  return Object.freeze({ element: container, render });
}

