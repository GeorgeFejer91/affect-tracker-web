import { buildFlubberPath, createProfiles, createProjectionOffsets } from "../../site/src/math.js";

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
      reducedMotion,
    });
    for (const path of paths) path.setAttribute("d", rendered.path);
    root.style.setProperty("--affect-color", rendered.color);
    const svg = paths[0]?.ownerSVGElement;
    if (svg) svg.style.opacity = String(snapshot.overlayOpacity ?? 1);
    return rendered;
  };
}
